/* ── Constants ───────────────────────────────────────────────────────────── */
const MAX_MARKERS   = 2000;
const MAX_LOOPS     = 14;
const MODEL         = 'claude-sonnet-4-6';
const CESIUM_VER    = '1.122';

/* ── Color scales ────────────────────────────────────────────────────────── */
const COLOR_SCALES = {
  fire:       ['#FFFF33','#FF9900','#FF5500','#FF0000','#8B0000'],
  seismic:    ['#00CC44','#99FF00','#FFFF00','#FF8800','#FF0000','#8B0000'],
  heat:       ['#313695','#4575B4','#74ADD1','#ABD9E9','#FFFFBF','#FDAE61','#F46D43','#D73027','#A50026'],
  cool:       ['#F7FCFD','#E0ECF4','#BFD3E6','#9EBCDA','#8C96C6','#8C6BB1','#88419D','#6E016B'],
  confidence: ['#FF8800','#FF4400','#FF0000'],
  terrain:    ['#006994','#2E8B57','#90EE90','#F4D03F','#A0522D','#FFFFFF'],
};

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3), 16),
    parseInt(hex.slice(3,5), 16),
    parseInt(hex.slice(5,7), 16),
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r,g,b].map(v => Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
}

function getColorFromScale(schemeName, t) {
  const stops = COLOR_SCALES[schemeName] || COLOR_SCALES.heat;
  const clamped = Math.max(0, Math.min(1, t));
  const pos = clamped * (stops.length - 1);
  const lo  = Math.floor(pos);
  const hi  = Math.min(lo + 1, stops.length - 1);
  if (lo === hi) return stops[lo];
  const f = pos - lo;
  const [r1,g1,b1] = hexToRgb(stops[lo]);
  const [r2,g2,b2] = hexToRgb(stops[hi]);
  return rgbToHex(r1+(r2-r1)*f, g1+(g2-g1)*f, b1+(b2-b1)*f);
}

/* ── App state ───────────────────────────────────────────────────────────── */
const state = {
  conversationHistory: [],
  datasets:    {},   // { id: { rawData, renderConfig } }
  filters:     {},   // { id: { fieldName: { type, min, max, current_min, current_max } } }
  cesiumLayers:{},   // { id: PointPrimitiveCollection | DataSource }
  viewer:      null,
};

/* ── System prompt ───────────────────────────────────────────────────────── */
const SYSTEM_PROMPT = `You are "Ask Cesium AI" — a geospatial data visualization assistant that controls a live 3D CesiumJS globe.

## CRITICAL DATA INTEGRITY RULE
You MUST NEVER invent, hallucinate, or fabricate geographic locations, coordinates, or data points.
Every single marker, polygon, or annotation placed on the map MUST come from actual data returned by one of your tools.
If a tool returns no results or an error, tell the user clearly. Do NOT add any markers as placeholders.

## Workflow for geospatial queries
1. Geocode the location → get coordinates
2. Call fly_to to navigate the camera to a good view
3. Fetch data using the appropriate tool (fetch_usgs_earthquakes, fetch_nasa_firms_fires, search_osm_features, etc.)
4. If data was found: call add_color_scale_markers (for quantitative datasets) or add multiple add_point_marker calls (for named places)
5. Call add_legend to explain what the colors/symbols mean
6. Optionally call add_filter_controls if the dataset is large and filterable
7. Report back: state the data source, the date range of the data, and the count of features shown

## When no data is found
Say exactly what happened: "No earthquake data was found for that region in that time range" — do not add any markers.
If a tool requires an API key that wasn't provided, say so clearly: "Fire data requires a NASA FIRMS key. Click ⚙️ Settings to add your free key from firms.modaps.eosdis.nasa.gov/api/map_key/"

## Dataset size limits
Cap all datasets at ${MAX_MARKERS} markers. If the source has more, explain: "Showing the N highest-magnitude events from M total."

## Color schemes to use
- 'fire': for wildfire / heat / temperature data (yellow → red)
- 'seismic': for earthquake magnitude or geological risk (green → red)
- 'heat': for generic continuous data (blue → red)
- 'cool': for population density, human activity (light → purple)
- 'confidence': for detection confidence (orange → red)

## Tool calling order
Always geocode first, then fly_to, then fetch data. Do not fly_to until you have coordinates.
Call add_legend and add_filter_controls AFTER you have the data and have called add_color_scale_markers.

## Data sources and capabilities
- Earthquakes: USGS FDSN — global, real-time, 1900s onward, no key required
- Wildfires: NASA FIRMS — last 10 days near-real-time, requires free FIRMS MAP_KEY
- Places / features: OpenStreetMap Overpass API — global, no key required
- Country/region boundaries: Use load_geojson_url with public Natural Earth / GeoJSON URLs

For historical wildfire perimeters (US, older than 10 days), suggest load_geojson_url with NIFC ArcGIS GeoJSON.

## Text responses
Keep responses concise. One short paragraph maximum. Include key stats (count, date range, data source). Do not repeat tool names.`;

/* ── Tool definitions ────────────────────────────────────────────────────── */
const TOOLS = [
  {
    name: 'geocode_location',
    description: 'Convert a place name to geographic coordinates using Nominatim. Always call this first before fly_to or any data fetch.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Place name, city, region, or address to geocode' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fly_to',
    description: 'Fly the camera to specific coordinates. Call after geocoding the target location.',
    input_schema: {
      type: 'object',
      properties: {
        lat:      { type: 'number', description: 'Latitude' },
        lng:      { type: 'number', description: 'Longitude' },
        altitude: { type: 'number', description: 'Camera altitude in meters. Use 500000 for country-level, 100000 for region, 20000 for city, 2000 for street' },
        label:    { type: 'string', description: 'Optional: label for the location' },
      },
      required: ['lat', 'lng', 'altitude'],
    },
  },
  {
    name: 'fetch_usgs_earthquakes',
    description: 'Fetch real earthquake data from USGS. Returns actual seismic events — never fabricate data when this returns 0 results.',
    input_schema: {
      type: 'object',
      properties: {
        lat:           { type: 'number', description: 'Center latitude' },
        lng:           { type: 'number', description: 'Center longitude' },
        radius_km:     { type: 'number', description: 'Search radius in km (e.g. 500 for a country, 2000 for a continent region)' },
        start_date:    { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:      { type: 'string', description: 'End date YYYY-MM-DD' },
        min_magnitude: { type: 'number', description: 'Minimum magnitude (e.g. 4.0)' },
        max_results:   { type: 'number', description: 'Maximum results (up to 2000)' },
      },
      required: ['lat', 'lng', 'radius_km'],
    },
  },
  {
    name: 'fetch_nasa_firms_fires',
    description: 'Fetch real active fire detections from NASA FIRMS satellite data (last 1-10 days). Requires user to have configured a FIRMS MAP_KEY in Settings.',
    input_schema: {
      type: 'object',
      properties: {
        lat:       { type: 'number', description: 'Center latitude' },
        lng:       { type: 'number', description: 'Center longitude' },
        radius_km: { type: 'number', description: 'Search radius in km' },
        days:      { type: 'number', description: 'Number of past days (1-10, max for NRT data)' },
        satellite: {
          type: 'string',
          enum: ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'],
          description: 'Satellite source. VIIRS_SNPP_NRT is most detailed and recent.',
        },
      },
      required: ['lat', 'lng', 'radius_km'],
    },
  },
  {
    name: 'search_osm_features',
    description: 'Search OpenStreetMap for real-world features (hospitals, airports, schools, rivers, parks, etc.) using the Overpass API.',
    input_schema: {
      type: 'object',
      properties: {
        lat:          { type: 'number', description: 'Center latitude' },
        lng:          { type: 'number', description: 'Center longitude' },
        radius_m:     { type: 'number', description: 'Search radius in meters' },
        feature_type: {
          type: 'string',
          description: 'OSM feature type. Examples: amenity=hospital, amenity=airport, amenity=school, natural=peak, natural=water, landuse=forest, aeroway=aerodrome, historic=castle',
        },
        limit:        { type: 'number', description: 'Max results (up to 500)' },
      },
      required: ['lat', 'lng', 'radius_m', 'feature_type'],
    },
  },
  {
    name: 'add_color_scale_markers',
    description: 'Add a batch of data-driven markers to the globe, colored by a continuous numeric value. Use this for earthquake magnitudes, fire intensity, temperature, etc. Each marker must come from actual fetched data.',
    input_schema: {
      type: 'object',
      properties: {
        dataset_id:   { type: 'string', description: 'Unique ID for this dataset (e.g. "usgs_2024", "firms_fires")' },
        markers: {
          type: 'array',
          description: 'Array of data points. Each must be actual fetched data, never fabricated.',
          items: {
            type: 'object',
            properties: {
              lat:   { type: 'number' },
              lng:   { type: 'number' },
              value: { type: 'number', description: 'The quantitative value used for color mapping' },
              label: { type: 'string', description: 'Tooltip text shown on hover' },
            },
            required: ['lat', 'lng', 'value'],
          },
        },
        field_name:   { type: 'string', description: 'Human-readable name for the value (e.g. "Magnitude", "Fire Radiative Power (MW)")' },
        color_scheme: { type: 'string', enum: ['fire','seismic','heat','cool','confidence','terrain'], description: 'Color scale to use' },
        min_val:      { type: 'number', description: 'Value at the low end of the color scale' },
        max_val:      { type: 'number', description: 'Value at the high end of the color scale' },
        point_size:   { type: 'number', description: 'Marker pixel size (default 7)' },
      },
      required: ['dataset_id', 'markers', 'field_name', 'color_scheme', 'min_val', 'max_val'],
    },
  },
  {
    name: 'add_point_marker',
    description: 'Add a single labeled marker pin to the globe. Use for key locations, landmarks, or named places.',
    input_schema: {
      type: 'object',
      properties: {
        lat:         { type: 'number' },
        lng:         { type: 'number' },
        label:       { type: 'string', description: 'Marker label shown on globe' },
        description: { type: 'string', description: 'Longer description shown in popup' },
        color:       { type: 'string', description: 'CSS color for the marker (e.g. "#FF4444")' },
        icon:        { type: 'string', description: 'Emoji icon prefix (e.g. "🏥", "✈️", "🌋")' },
      },
      required: ['lat', 'lng', 'label'],
    },
  },
  {
    name: 'add_polygon',
    description: 'Draw a polygon (boundary, area, region) on the globe.',
    input_schema: {
      type: 'object',
      properties: {
        coordinates: {
          type: 'array',
          description: 'Array of [lng, lat] pairs forming the polygon ring',
          items: { type: 'array', items: { type: 'number' } },
        },
        label:        { type: 'string' },
        fill_color:   { type: 'string', description: 'CSS color for fill (include alpha: rgba(r,g,b,a))' },
        stroke_color: { type: 'string', description: 'CSS color for outline' },
        stroke_width: { type: 'number', description: 'Outline width in pixels' },
      },
      required: ['coordinates', 'label'],
    },
  },
  {
    name: 'add_polyline',
    description: 'Draw a line (route, river, boundary) on the globe.',
    input_schema: {
      type: 'object',
      properties: {
        coordinates: {
          type: 'array',
          description: 'Array of [lng, lat] pairs',
          items: { type: 'array', items: { type: 'number' } },
        },
        label: { type: 'string' },
        color: { type: 'string', description: 'CSS color' },
        width: { type: 'number', description: 'Line width in pixels' },
      },
      required: ['coordinates', 'label'],
    },
  },
  {
    name: 'load_geojson_url',
    description: 'Load and display a GeoJSON dataset from a public URL. Useful for country boundaries, administrative regions, fire perimeters, etc.',
    input_schema: {
      type: 'object',
      properties: {
        url:          { type: 'string', description: 'Public URL to a GeoJSON file or endpoint' },
        label:        { type: 'string', description: 'Human-readable name for this dataset' },
        dataset_id:   { type: 'string', description: 'Unique ID for this layer' },
        stroke_color: { type: 'string', description: 'CSS color for borders (default "#FFFFFF")' },
        fill_color:   { type: 'string', description: 'CSS fill color (default "rgba(255,255,255,0.15)")' },
      },
      required: ['url', 'label', 'dataset_id'],
    },
  },
  {
    name: 'add_legend',
    description: 'Add an HTML legend overlay panel to the bottom-left of the globe. Always call this after plotting a dataset.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Legend title (e.g. "USGS Earthquakes M5+ — 2024")' },
        source_name: { type: 'string', description: 'Data source name (e.g. "USGS Earthquake Hazards Program")' },
        source_url:  { type: 'string', description: 'URL to the data source' },
        date_range:  { type: 'string', description: 'Date range of data shown (e.g. "Jan 1 – Dec 31, 2024")' },
        color_scheme:{ type: 'string', enum: ['fire','seismic','heat','cool','confidence','terrain'], description: 'If set, renders a continuous gradient bar' },
        min_val:     { type: 'number' },
        max_val:     { type: 'number' },
        unit:        { type: 'string', description: 'Unit label for gradient (e.g. "MW", "M", "°C")' },
        items: {
          type: 'array',
          description: 'Discrete legend items (for categorical data or mixed layers)',
          items: {
            type: 'object',
            properties: {
              color: { type: 'string' },
              label: { type: 'string' },
              shape: { type: 'string', enum: ['circle','square','line'], description: 'Default: circle' },
            },
            required: ['color', 'label'],
          },
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_filter_controls',
    description: 'Add interactive filter controls over the globe so users can dynamically filter the displayed dataset.',
    input_schema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', description: 'Must match the dataset_id used in add_color_scale_markers' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type:    { type: 'string', enum: ['range','select'], description: '"range" for a slider, "select" for a dropdown' },
              field:   { type: 'string', description: 'Field name in the marker data objects' },
              label:   { type: 'string', description: 'Human-readable label' },
              min:     { type: 'number', description: 'Minimum value (for range)' },
              max:     { type: 'number', description: 'Maximum value (for range)' },
              step:    { type: 'number', description: 'Slider step (default 0.1 for floats, 1 for ints)' },
              options: { type: 'array', items: { type: 'string' }, description: 'Options for select type' },
            },
            required: ['type', 'field', 'label'],
          },
        },
      },
      required: ['dataset_id', 'filters'],
    },
  },
  {
    name: 'set_globe_time',
    description: 'Set the time of day on the globe (affects sun position and lighting).',
    input_schema: {
      type: 'object',
      properties: {
        iso_datetime: { type: 'string', description: 'ISO 8601 datetime string e.g. "2024-07-15T12:00:00Z"' },
      },
      required: ['iso_datetime'],
    },
  },
  {
    name: 'clear_all_entities',
    description: 'Remove all markers, polygons, datasets, legends, and filters from the globe and reset to clean state.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

/* ── Anthropic API (browser-side direct call) ────────────────────────────── */
async function callClaude(messages) {
  const key = localStorage.getItem('anthropicKey');
  if (!key) throw new Error('No Anthropic API key. Click ⚙️ Settings to add yours.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':                              key,
      'anthropic-version':                      '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type':                           'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      tools:      TOOLS,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if (res.status === 401) throw new Error('Invalid Anthropic API key. Click ⚙️ Settings to update it.');
    throw new Error(msg);
  }
  return res.json();
}

/* ── Agentic loop ────────────────────────────────────────────────────────── */
async function runQuery(userMessage) {
  const pendingActions = [];
  const msgs = [
    ...state.conversationHistory,
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < MAX_LOOPS; i++) {
    let response;
    try {
      response = await callClaude(msgs);
    } catch (err) {
      return { text: `Error: ${err.message}`, actions: pendingActions };
    }

    msgs.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      state.conversationHistory = msgs;
      return { text, actions: pendingActions };
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await dispatchTool(block.name, block.input, pendingActions);
        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     JSON.stringify(result),
        });
      }
      msgs.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    break;
  }

  state.conversationHistory = msgs;
  return { text: 'Analysis complete.', actions: pendingActions };
}

/* ── Tool dispatcher ─────────────────────────────────────────────────────── */
async function dispatchTool(name, input, pendingActions) {
  try {
    switch (name) {
      case 'geocode_location':        return await geocodeLocation(input);
      case 'fly_to':                  pendingActions.push({ type: 'fly_to', ...input }); return { success: true };
      case 'fetch_usgs_earthquakes':  return await fetchUSGSEarthquakes(input);
      case 'fetch_nasa_firms_fires':  return await fetchNASAFIRMS(input);
      case 'search_osm_features':     return await searchOSMFeatures(input);
      case 'add_color_scale_markers': return addColorScaleMarkersToState(input, pendingActions);
      case 'add_point_marker':        pendingActions.push({ type: 'add_point_marker', ...input }); return { success: true };
      case 'add_polygon':             pendingActions.push({ type: 'add_polygon', ...input }); return { success: true };
      case 'add_polyline':            pendingActions.push({ type: 'add_polyline', ...input }); return { success: true };
      case 'load_geojson_url':        pendingActions.push({ type: 'load_geojson_url', ...input }); return { success: true };
      case 'add_legend':              pendingActions.push({ type: 'add_legend', ...input }); return { success: true };
      case 'add_filter_controls':     addFilterState(input); pendingActions.push({ type: 'add_filter_controls', ...input }); return { success: true };
      case 'set_globe_time':          pendingActions.push({ type: 'set_globe_time', ...input }); return { success: true };
      case 'clear_all_entities':      pendingActions.push({ type: 'clear_all_entities' }); return { success: true };
      default:                        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

/* ── Data-fetch tools ────────────────────────────────────────────────────── */
async function geocodeLocation({ query }) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) return { error: `Geocoding failed: ${res.status}` };
  const data = await res.json();
  if (!data.length) return { error: `Location not found: "${query}"` };
  const r = data[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display_name: r.display_name, type: r.type };
}

async function fetchUSGSEarthquakes({ lat, lng, radius_km, start_date, end_date, min_magnitude, max_results }) {
  const limit = Math.min(max_results || 1000, MAX_MARKERS);
  const now   = new Date();
  const start = start_date || new Date(now - 30 * 864e5).toISOString().split('T')[0];
  const end   = end_date   || now.toISOString().split('T')[0];

  const params = new URLSearchParams({
    format:        'geojson',
    latitude:      lat,
    longitude:     lng,
    maxradiuskm:   radius_km,
    starttime:     start,
    endtime:       end,
    minmagnitude:  min_magnitude ?? 2.0,
    orderby:       'magnitude',
    limit,
  });

  let res;
  try {
    res = await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`);
  } catch (e) {
    return { error: `Network error fetching USGS data: ${e.message}` };
  }
  if (!res.ok) return { error: `USGS API error ${res.status}` };

  const data = await res.json();
  const quakes = (data.features || []).map(f => ({
    lat:       f.geometry.coordinates[1],
    lng:       f.geometry.coordinates[0],
    depth_km:  Math.round(f.geometry.coordinates[2] || 0),
    magnitude: f.properties.mag,
    place:     f.properties.place,
    time:      new Date(f.properties.time).toISOString().split('T')[0],
    id:        f.id,
  })).filter(q => q.lat != null && q.lng != null);

  return {
    count:       quakes.length,
    earthquakes: quakes,
    start_date:  start,
    end_date:    end,
    min_magnitude: min_magnitude ?? 2.0,
    source: 'USGS Earthquake Hazards Program',
    source_url: 'https://earthquake.usgs.gov',
  };
}

async function fetchNASAFIRMS({ lat, lng, radius_km, days, satellite }) {
  const firmsKey = localStorage.getItem('firmsKey');
  if (!firmsKey) {
    return { error: 'NASA FIRMS key not configured. Click ⚙️ Settings and add your free FIRMS MAP_KEY. Register at https://firms.modaps.eosdis.nasa.gov/api/map_key/' };
  }

  const d   = Math.min(Math.max(1, Math.round(days || 7)), 10);
  const sat = satellite || 'VIIRS_SNPP_NRT';
  const R   = 6371;
  const dlat = (radius_km / R) * (180 / Math.PI);
  const dlng = dlat / Math.cos(lat * Math.PI / 180);
  const w = (lng - dlng).toFixed(4);
  const s = (lat - dlat).toFixed(4);
  const e = (lng + dlng).toFixed(4);
  const n = (lat + dlat).toFixed(4);
  const bbox = `${w},${s},${e},${n}`;

  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${firmsKey}/${sat}/${bbox}/${d}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { error: `FIRMS network error (possible CORS issue): ${err.message}. Consider using the Railway-hosted version for fire data.` };
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { error: 'Invalid FIRMS MAP_KEY. Please check your key in ⚙️ Settings.' };
    return { error: `FIRMS API error ${res.status}` };
  }

  const csv = await res.text();
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return { count: 0, fires: [], satellite: sat, days: d, message: 'No fire detections in this area for the selected period.' };

  const headers = lines[0].split(',').map(h => h.trim());
  const fires = [];

  for (let i = 1; i < lines.length && fires.length < MAX_MARKERS; i++) {
    const vals = lines[i].split(',');
    const obj  = {};
    headers.forEach((h, j) => { obj[h] = (vals[j] || '').trim(); });

    const flat = parseFloat(obj.latitude);
    const flng = parseFloat(obj.longitude);
    if (isNaN(flat) || isNaN(flng)) continue;

    fires.push({
      lat:        flat,
      lng:        flng,
      brightness: parseFloat(obj.bright_ti4 || obj.brightness || 0),
      frp:        parseFloat(obj.frp || 0),
      confidence: obj.confidence,
      date:       obj.acq_date,
      satellite:  obj.satellite,
      daynight:   obj.daynight,
    });
  }

  return {
    count: fires.length,
    fires,
    satellite: sat,
    days: d,
    source: 'NASA FIRMS (Fire Information for Resource Management System)',
    source_url: 'https://firms.modaps.eosdis.nasa.gov',
  };
}

async function searchOSMFeatures({ lat, lng, radius_m, feature_type, limit }) {
  const max = Math.min(limit || 200, 500);
  const [key, val] = feature_type.includes('=') ? feature_type.split('=') : ['amenity', feature_type];
  const query = `
    [out:json][timeout:25];
    (
      node["${key}"="${val}"](around:${radius_m},${lat},${lng});
      way["${key}"="${val}"](around:${radius_m},${lat},${lng});
    );
    out center ${max};
  `.trim();

  let res;
  try {
    res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `data=${encodeURIComponent(query)}`,
    });
  } catch (err) {
    return { error: `OSM network error: ${err.message}` };
  }
  if (!res.ok) return { error: `Overpass API error ${res.status}` };

  const data = await res.json();
  const features = (data.elements || []).map(el => ({
    lat:  el.lat ?? el.center?.lat,
    lng:  el.lon ?? el.center?.lon,
    name: el.tags?.name || el.tags?.['name:en'] || `${key}=${val}`,
    type: el.tags?.[key] || val,
    tags: el.tags || {},
  })).filter(f => f.lat != null && f.lng != null);

  return {
    count:    features.length,
    features,
    feature_type,
    source: 'OpenStreetMap via Overpass API',
    source_url: 'https://www.openstreetmap.org',
  };
}

/* ── Tool helpers (state side-effects before Cesium render) ──────────────── */
function addColorScaleMarkersToState(input, pendingActions) {
  const { dataset_id, markers } = input;
  const capped = markers.slice(0, MAX_MARKERS);
  state.datasets[dataset_id] = {
    rawData:      capped,
    renderConfig: { ...input, markers: capped },
  };
  pendingActions.push({ type: 'color_scale_markers', ...input, markers: capped });
  return { success: true, rendered: capped.length, capped: capped.length < markers.length };
}

function addFilterState({ dataset_id, filters }) {
  state.filters[dataset_id] = {};
  for (const f of filters) {
    state.filters[dataset_id][f.field] = {
      ...f,
      current_min: f.min,
      current_max: f.max,
    };
  }
}

/* ── Cesium action executors ─────────────────────────────────────────────── */
function executeActions(actions) {
  for (const action of actions) {
    try { executeSingleAction(action); }
    catch (err) { console.warn('Cesium action error:', action.type, err); }
  }
}

function executeSingleAction(action) {
  const { viewer } = state;
  if (!viewer) return;

  switch (action.type) {

    case 'fly_to': {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(action.lng, action.lat, action.altitude),
        duration: 2.0,
      });
      break;
    }

    case 'color_scale_markers': {
      const { dataset_id, markers, color_scheme, min_val, max_val, point_size } = action;
      removeCesiumLayer(dataset_id);

      const collection = new Cesium.PointPrimitiveCollection();
      const range = (max_val - min_val) || 1;

      for (const m of markers) {
        const t     = (m.value - min_val) / range;
        const color = getColorFromScale(color_scheme, t);
        collection.add({
          position: Cesium.Cartesian3.fromDegrees(m.lng, m.lat),
          color:    Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          pixelSize: point_size || 7,
          id:       m.label || String(m.value),
        });
      }

      viewer.scene.primitives.add(collection);
      state.cesiumLayers[dataset_id] = collection;
      break;
    }

    case 'add_point_marker': {
      const color = action.color || '#3b82f6';
      const label = action.icon ? `${action.icon} ${action.label}` : action.label;
      viewer.entities.add({
        position:  Cesium.Cartesian3.fromDegrees(action.lng, action.lat),
        point: {
          pixelSize:        10,
          color:            Cesium.Color.fromCssColorString(color),
          outlineColor:     Cesium.Color.WHITE,
          outlineWidth:     2,
          heightReference:  Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text:             label,
          font:             '11px sans-serif',
          fillColor:        Cesium.Color.WHITE,
          outlineColor:     Cesium.Color.BLACK,
          outlineWidth:     2,
          style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:      new Cesium.Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: action.description,
      });
      break;
    }

    case 'add_polygon': {
      const flat = action.coordinates.flatMap(c => [c[0], c[1]]);
      viewer.entities.add({
        name: action.label,
        polygon: {
          hierarchy:     Cesium.Cartesian3.fromDegreesArray(flat),
          material:      Cesium.Color.fromCssColorString(action.fill_color || 'rgba(255,255,255,0.15)'),
          outline:       true,
          outlineColor:  Cesium.Color.fromCssColorString(action.stroke_color || '#FFFFFF'),
          outlineWidth:  action.stroke_width || 2,
        },
      });
      break;
    }

    case 'add_polyline': {
      const flat = action.coordinates.flatMap(c => [c[0], c[1]]);
      viewer.entities.add({
        name: action.label,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width:     action.width || 2,
          material:  Cesium.Color.fromCssColorString(action.color || '#3b82f6'),
        },
      });
      break;
    }

    case 'load_geojson_url': {
      const { url, dataset_id, stroke_color, fill_color } = action;
      removeCesiumLayer(dataset_id);
      Cesium.GeoJsonDataSource.load(url, {
        stroke:      Cesium.Color.fromCssColorString(stroke_color || '#FFFFFF').withAlpha(0.8),
        fill:        Cesium.Color.fromCssColorString(fill_color  || 'rgba(255,255,255,0.1)'),
        strokeWidth: 2,
      }).then(ds => {
        viewer.dataSources.add(ds);
        state.cesiumLayers[dataset_id] = ds;
      }).catch(e => console.warn('GeoJSON load error:', e));
      break;
    }

    case 'set_globe_time': {
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(action.iso_datetime);
      break;
    }

    case 'add_legend': {
      renderLegend(action);
      break;
    }

    case 'add_filter_controls': {
      renderFilterPanel(action);
      break;
    }

    case 'clear_all_entities': {
      viewer.entities.removeAll();
      viewer.dataSources.removeAll();
      for (const id of Object.keys(state.cesiumLayers)) {
        const layer = state.cesiumLayers[id];
        if (layer instanceof Cesium.PointPrimitiveCollection) viewer.scene.primitives.remove(layer);
      }
      state.cesiumLayers    = {};
      state.datasets        = {};
      state.filters         = {};
      hideLegend();
      hideFilterPanel();
      break;
    }
  }
}

function removeCesiumLayer(id) {
  const layer = state.cesiumLayers[id];
  if (!layer) return;
  if (layer instanceof Cesium.PointPrimitiveCollection) {
    state.viewer.scene.primitives.remove(layer);
  } else if (layer.isDestroyed?.() === false) {
    state.viewer.dataSources.remove(layer);
  }
  delete state.cesiumLayers[id];
}

/* ── Legend renderer ─────────────────────────────────────────────────────── */
function renderLegend(action) {
  const panel = document.getElementById('legend-panel');
  const { title, source_name, source_url, date_range, color_scheme, min_val, max_val, unit, items } = action;

  let html = `<button class="overlay-close" id="legend-close">✕</button>`;
  html += `<div class="legend-title">${esc(title)}</div>`;

  if (color_scheme && min_val !== undefined && max_val !== undefined) {
    const stops = COLOR_SCALES[color_scheme] || COLOR_SCALES.heat;
    const grad  = stops.join(',');
    html += `<div class="legend-gradient-bar" style="background:linear-gradient(to right,${grad})"></div>`;
    const unitStr = unit ? ` ${esc(unit)}` : '';
    html += `<div class="legend-gradient-labels"><span>${min_val}${unitStr}</span><span>${max_val}${unitStr}</span></div>`;
  }

  for (const item of (items || [])) {
    const shapeClass = item.shape === 'square' ? 'square' : item.shape === 'line' ? 'line' : '';
    html += `<div class="legend-item">
      <span class="legend-swatch ${shapeClass}" style="background:${esc(item.color)}"></span>
      <span class="legend-label">${esc(item.label)}</span>
    </div>`;
  }

  if (source_name || date_range) html += `<hr class="legend-divider">`;
  if (date_range)  html += `<div class="legend-date">📅 ${esc(date_range)}</div>`;
  if (source_name) {
    html += `<div class="legend-source">Source: `;
    html += source_url ? `<a href="${esc(source_url)}" target="_blank" rel="noopener">${esc(source_name)}</a>` : esc(source_name);
    html += `</div>`;
  }

  panel.innerHTML = html;
  panel.classList.remove('hidden');
  document.getElementById('legend-close').addEventListener('click', hideLegend);
}

function hideLegend() {
  document.getElementById('legend-panel').classList.add('hidden');
}

/* ── Filter panel renderer ───────────────────────────────────────────────── */
function renderFilterPanel(action) {
  const { dataset_id, filters } = action;
  const content = document.getElementById('filter-content');
  const panel   = document.getElementById('filter-panel');

  let html = `<div class="filter-title">Filter Dataset</div>`;

  for (const f of filters) {
    if (f.type === 'range') {
      const min = f.min ?? 0;
      const max = f.max ?? 100;
      const step = f.step ?? (max - min > 50 ? 1 : 0.1);
      html += `<div class="filter-group">
        <label>
          ${esc(f.label)}
          <span class="filter-val" id="fv-${dataset_id}-${f.field}">${min} – ${max}</span>
        </label>
        <input type="range" class="filter-range"
          data-dataset="${esc(dataset_id)}" data-field="${esc(f.field)}" data-bound="min"
          min="${min}" max="${max}" step="${step}" value="${min}" />
        <input type="range" class="filter-range"
          data-dataset="${esc(dataset_id)}" data-field="${esc(f.field)}" data-bound="max"
          min="${min}" max="${max}" step="${step}" value="${max}" />
      </div>`;
    } else if (f.type === 'select') {
      html += `<div class="filter-group">
        <label>${esc(f.label)}</label>
        <select class="filter-select" data-dataset="${esc(dataset_id)}" data-field="${esc(f.field)}">
          <option value="">All</option>
          ${(f.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
        </select>
      </div>`;
    }
  }

  content.innerHTML = html;
  panel.classList.remove('hidden');
  document.getElementById('filter-close').addEventListener('click', hideFilterPanel);

  panel.querySelectorAll('.filter-range').forEach(el => el.addEventListener('input', onFilterChange));
  panel.querySelectorAll('.filter-select').forEach(el => el.addEventListener('change', onFilterChange));
}

function hideFilterPanel() {
  document.getElementById('filter-panel').classList.add('hidden');
}

function onFilterChange(evt) {
  const { dataset, field, bound } = evt.target.dataset;
  const val = parseFloat(evt.target.value);

  if (!state.filters[dataset]) return;
  if (!state.filters[dataset][field]) state.filters[dataset][field] = {};

  if (bound === 'min') state.filters[dataset][field].current_min = val;
  if (bound === 'max') state.filters[dataset][field].current_max = val;

  if (evt.target.tagName === 'SELECT') {
    state.filters[dataset][field].selected = evt.target.value;
  }

  // Update displayed range
  const labelEl = document.getElementById(`fv-${dataset}-${field}`);
  if (labelEl && state.filters[dataset][field]) {
    const f = state.filters[dataset][field];
    labelEl.textContent = `${f.current_min ?? f.min} – ${f.current_max ?? f.max}`;
  }

  applyFilters(dataset);
}

function applyFilters(dataset_id) {
  const ds = state.datasets[dataset_id];
  if (!ds) return;

  let filtered = ds.rawData;
  const filters = state.filters[dataset_id] || {};

  for (const [field, f] of Object.entries(filters)) {
    if (f.type === 'range' || (f.current_min !== undefined)) {
      const lo = f.current_min ?? f.min ?? -Infinity;
      const hi = f.current_max ?? f.max ?? Infinity;
      filtered = filtered.filter(m => {
        const v = m[field] ?? m.value;
        return v >= lo && v <= hi;
      });
    }
    if (f.selected) {
      filtered = filtered.filter(m => !m[field] || m[field] === f.selected);
    }
  }

  // Re-render with filtered data
  const cfg = ds.renderConfig;
  const action = { type: 'color_scale_markers', ...cfg, markers: filtered.slice(0, MAX_MARKERS) };
  executeSingleAction(action);
}

/* ── HTML escape ─────────────────────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Markdown renderer (minimal) ────────────────────────────────────────── */
function renderMarkdown(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs,'<ul>$1</ul>')
    .replace(/\n{2,}/g,'</p><p>')
    .replace(/\n/g,'<br>')
    .replace(/^(.+)$/,'<p>$1</p>');
}

/* ── Chat UI ─────────────────────────────────────────────────────────────── */
function appendMessage(role, text, actions) {
  const container = document.getElementById('messages');
  const welcome   = document.getElementById('welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'Ask Cesium AI';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = renderMarkdown(text);

  div.appendChild(label);
  div.appendChild(bubble);

  if (role === 'assistant' && actions?.length) {
    const tags = document.createElement('div');
    tags.className = 'action-tags';
    const distinct = [...new Set(actions.map(a => actionLabel(a.type)))];
    for (const lbl of distinct) {
      const tag = document.createElement('span');
      tag.className = 'action-tag';
      tag.textContent = lbl;
      tags.appendChild(tag);
    }
    div.appendChild(tags);
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function actionLabel(type) {
  const map = {
    fly_to:               '📍 Navigated',
    color_scale_markers:  '🗺 Data mapped',
    add_point_marker:     '📌 Marker added',
    add_polygon:          '⬡ Polygon drawn',
    add_polyline:         '〰 Line drawn',
    load_geojson_url:     '📂 GeoJSON loaded',
    add_legend:           '🏷 Legend',
    add_filter_controls:  '🎚 Filters',
    clear_all_entities:   '🧹 Cleared',
    set_globe_time:       '⏰ Time set',
  };
  return map[type] || `⚙ ${type}`;
}

let typingEl = null;

function showTyping() {
  const container = document.getElementById('messages');
  typingEl = document.createElement('div');
  typingEl.className = 'message assistant';
  typingEl.innerHTML = `
    <div class="msg-label">Ask Cesium AI</div>
    <div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  `;
  container.appendChild(typingEl);
  container.scrollTop = container.scrollHeight;
}

function hideTyping() {
  typingEl?.remove();
  typingEl = null;
}

function showErrorToast(msg, durationMs = 5000) {
  const toast = document.getElementById('error-toast');
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, durationMs);
}

function setInputEnabled(enabled) {
  document.getElementById('query-input').disabled = !enabled;
  document.getElementById('send-btn').disabled     = !enabled;
}

/* ── Setup modal ─────────────────────────────────────────────────────────── */
function showSetupModal() {
  const modal = document.getElementById('setup-modal');
  modal.classList.remove('hidden');
  document.getElementById('input-anthropic-key').value = localStorage.getItem('anthropicKey') || '';
  document.getElementById('input-cesium-token').value  = localStorage.getItem('cesiumToken')  || '';
  document.getElementById('input-firms-key').value     = localStorage.getItem('firmsKey')     || '';
  document.getElementById('modal-error').classList.add('hidden');
}

function hideSetupModal() {
  document.getElementById('setup-modal').classList.add('hidden');
}

function saveKeys() {
  const key     = document.getElementById('input-anthropic-key').value.trim();
  const cesium  = document.getElementById('input-cesium-token').value.trim();
  const firms   = document.getElementById('input-firms-key').value.trim();
  const errEl   = document.getElementById('modal-error');

  if (!key) {
    errEl.textContent = 'Anthropic API key is required.';
    errEl.classList.remove('hidden');
    return;
  }

  localStorage.setItem('anthropicKey', key);
  if (cesium) localStorage.setItem('cesiumToken', cesium);
  else        localStorage.removeItem('cesiumToken');
  if (firms)  localStorage.setItem('firmsKey', firms);
  else        localStorage.removeItem('firmsKey');

  hideSetupModal();
  initCesium();
}

/* ── Main send handler ───────────────────────────────────────────────────── */
async function handleSend() {
  const input = document.getElementById('query-input');
  const text  = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = '';

  if (!localStorage.getItem('anthropicKey')) {
    showSetupModal();
    return;
  }

  setInputEnabled(false);
  appendMessage('user', text);
  showTyping();

  try {
    const { text: reply, actions } = await runQuery(text);
    hideTyping();
    executeActions(actions);
    appendMessage('assistant', reply, actions);
  } catch (err) {
    hideTyping();
    showErrorToast(err.message);
    appendMessage('assistant', `Sorry, an error occurred: ${err.message}`);
  } finally {
    setInputEnabled(true);
    document.getElementById('query-input').focus();
  }
}

/* ── New conversation ────────────────────────────────────────────────────── */
function newConversation() {
  state.conversationHistory = [];
  const messages = document.getElementById('messages');
  messages.innerHTML = `
    <div id="welcome">
      <div class="welcome-icon">🌍</div>
      <h2>Ask Cesium AI</h2>
      <p>Describe a geospatial dataset and I'll find the verified data and build the map — with legends, filters, and real-time data.</p>
      <div class="starter-prompts">
        <button class="starter-btn" data-query="Show me earthquake activity in Japan from 2024, colored by magnitude with depth filters"><span>🌋</span> Earthquakes in Japan (2024) by magnitude</button>
        <button class="starter-btn" data-query="Map active wildfires detected by NASA satellites in California in the last 7 days, colored by fire intensity"><span>🔥</span> Active wildfires in California this week</button>
        <button class="starter-btn" data-query="Find all major airports within 500km of New York City"><span>✈️</span> Airports near New York City</button>
        <button class="starter-btn" data-query="Map magnitude 6+ earthquakes worldwide in the last 30 days"><span>📡</span> Global major earthquakes (last 30 days)</button>
        <button class="starter-btn" data-query="Show hospitals and emergency medical centers in London"><span>🏥</span> Hospitals in London</button>
        <button class="starter-btn" data-query="Show me the 10 highest mountain peaks in the Alps with their elevations"><span>🏔️</span> Highest Alpine peaks</button>
      </div>
    </div>
  `;
  wireStarterButtons();
}

function wireStarterButtons() {
  document.querySelectorAll('.starter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('query-input').value = btn.dataset.query;
      handleSend();
    });
  });
}

/* ── Cesium initialization ───────────────────────────────────────────────── */
function initCesium() {
  const token = localStorage.getItem('cesiumToken');
  if (token) Cesium.Ion.defaultAccessToken = token;

  if (state.viewer) {
    try { state.viewer.destroy(); } catch (_) {}
    state.viewer = null;
  }

  const loading = document.getElementById('cesium-loading');
  loading.style.display = 'flex';

  try {
    const viewer = new Cesium.Viewer('cesiumContainer', {
      terrainProvider:    token
        ? Cesium.createWorldTerrain()
        : new Cesium.EllipsoidTerrainProvider(),
      imageryProvider:    token
        ? undefined
        : new Cesium.TileMapServiceImageryProvider({ url: Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII') }),
      animation:          false,
      baseLayerPicker:    false,
      fullscreenButton:   false,
      geocoder:           false,
      homeButton:         false,
      infoBox:            true,
      sceneModePicker:    false,
      selectionIndicator: true,
      timeline:           false,
      navigationHelpButton: false,
      creditContainer:    document.createElement('div'),
    });

    viewer.scene.globe.enableLighting = true;
    viewer.scene.backgroundColor = Cesium.Color.BLACK;

    state.viewer = viewer;

    // Fade out loading overlay once ready
    viewer.scene.globe.tileLoadProgressEvent.addEventListener(remaining => {
      if (remaining === 0) {
        loading.style.opacity = '0';
        setTimeout(() => { loading.style.display = 'none'; loading.style.opacity = '1'; }, 400);
      }
    });

    // Fallback hide after 5s
    setTimeout(() => {
      loading.style.opacity = '0';
      setTimeout(() => { loading.style.display = 'none'; loading.style.opacity = '1'; }, 400);
    }, 5000);

  } catch (err) {
    console.error('Cesium init error:', err);
    loading.innerHTML = `<p style="color:#ef4444">Globe failed to load: ${err.message}</p>`;
  }
}

/* ── Entry point ─────────────────────────────────────────────────────────── */
window.addEventListener('load', () => {
  // Show modal if no API key
  if (!localStorage.getItem('anthropicKey')) {
    showSetupModal();
  } else {
    initCesium();
  }

  // Modal save button
  document.getElementById('save-keys-btn').addEventListener('click', saveKeys);

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', showSetupModal);

  // New conversation
  document.getElementById('new-chat-btn').addEventListener('click', newConversation);

  // Send button
  document.getElementById('send-btn').addEventListener('click', handleSend);

  // Textarea: Enter to send, Shift+Enter for newline, auto-resize
  const textarea = document.getElementById('query-input');
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  });

  // Overlay close buttons (initial wiring for static HTML)
  document.getElementById('legend-close')?.addEventListener('click', hideLegend);
  document.getElementById('filter-close')?.addEventListener('click', hideFilterPanel);

  // Starter prompt buttons
  wireStarterButtons();
});
