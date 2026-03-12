import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

const client = new Anthropic();

// ---------------------------------------------------------------------------
// Tool definitions — what Claude can do to control the Cesium globe
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'geocode_location',
    description:
      'Convert a place name, landmark, city, country, or address into geographic coordinates (latitude/longitude) using OpenStreetMap Nominatim. Always call this before fly_to when you only have a place name and not exact coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        place_name: {
          type: 'string',
          description: 'The place name, landmark, city, country, or address to geocode.',
        },
      },
      required: ['place_name'],
    },
  },
  {
    name: 'fly_to',
    description:
      'Animate the Cesium globe camera to fly to specific coordinates. This visually moves the 3D globe to show a location. Use after geocode_location to navigate to a place.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude in decimal degrees.' },
        lng: { type: 'number', description: 'Longitude in decimal degrees.' },
        altitude_meters: {
          type: 'number',
          description:
            'Camera altitude above ground in meters. Guidelines: continent=8,000,000; country=2,000,000; region=500,000; city=80,000; neighborhood=10,000; building=1,000.',
        },
        heading_degrees: {
          type: 'number',
          description: 'Camera heading in degrees (0=north, 90=east). Defaults to 0.',
        },
        pitch_degrees: {
          type: 'number',
          description: 'Camera pitch in degrees. -90=straight down, -30=angled. Defaults to -45.',
        },
      },
      required: ['lat', 'lng', 'altitude_meters'],
    },
  },
  {
    name: 'add_point_marker',
    description:
      'Add a labeled point marker (colored dot + text label) on the Cesium globe at specific coordinates. Use this to highlight individual places, landmarks, or data points.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude in decimal degrees.' },
        lng: { type: 'number', description: 'Longitude in decimal degrees.' },
        label: { type: 'string', description: 'Short label text shown next to the marker on the globe.' },
        description: { type: 'string', description: 'Longer description shown in the info popup when clicked.' },
        color: {
          type: 'string',
          description: 'CSS color for the marker dot, e.g. "#FFD700" (gold), "#FF4444" (red), "#44BBFF" (blue), "#44FF88" (green), "#FF8844" (orange).',
        },
        size: {
          type: 'number',
          description: 'Marker pixel size. Default 12. Use 16 for primary markers, 10 for secondary.',
        },
      },
      required: ['lat', 'lng', 'label'],
    },
  },
  {
    name: 'add_polyline',
    description: 'Draw a line on the Cesium globe connecting multiple geographic points. Useful for routes, borders, rivers, or connections between places.',
    input_schema: {
      type: 'object',
      properties: {
        coordinates: {
          type: 'array',
          description: 'Array of [latitude, longitude] pairs defining the line path.',
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        },
        label: { type: 'string', description: 'Name/label for this line.' },
        color: { type: 'string', description: 'CSS color string, e.g. "#FF4444".' },
        width: { type: 'number', description: 'Line width in pixels. Default 3.' },
      },
      required: ['coordinates', 'label'],
    },
  },
  {
    name: 'add_polygon',
    description: 'Draw a filled polygon on the Cesium globe. Useful for highlighting regions, national parks, countries, flood zones, or any geographic area.',
    input_schema: {
      type: 'object',
      properties: {
        coordinates: {
          type: 'array',
          description: 'Array of [latitude, longitude] pairs defining the polygon boundary. Close it by repeating the first point at the end.',
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        },
        label: { type: 'string', description: 'Name/label for this polygon.' },
        color: { type: 'string', description: 'CSS color for fill and outline, e.g. "#4488FF".' },
        alpha: { type: 'number', description: 'Fill opacity 0.0–1.0. Default 0.35.' },
      },
      required: ['coordinates', 'label'],
    },
  },
  {
    name: 'search_osm_features',
    description:
      'Search OpenStreetMap (via Overpass API) for real-world geographic features near a location. Use this to find and map actual data like volcanoes, airports, hospitals, national parks, peaks, bridges, etc.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Center latitude for the search.' },
        lng: { type: 'number', description: 'Center longitude for the search.' },
        radius_meters: { type: 'number', description: 'Search radius in meters. E.g. 100000 for 100 km.' },
        feature_type: {
          type: 'string',
          description:
            'OSM tag in "key=value" format. Examples: "natural=volcano", "aeroway=aerodrome", "amenity=hospital", "tourism=attraction", "natural=peak", "natural=reef", "landuse=forest", "historic=monument", "railway=station".',
        },
        limit: { type: 'number', description: 'Max results to return. Default 10, max 30.' },
      },
      required: ['lat', 'lng', 'radius_meters', 'feature_type'],
    },
  },
  {
    name: 'load_geojson_url',
    description: 'Load and display a GeoJSON dataset from a public URL on the Cesium globe. Useful for pre-existing datasets like country borders, river networks, protected areas, etc.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public HTTPS URL of the GeoJSON file.' },
        label: { type: 'string', description: 'Display name for this dataset layer.' },
        color: { type: 'string', description: 'CSS color for rendering features, e.g. "#44BBFF".' },
      },
      required: ['url', 'label'],
    },
  },
  {
    name: 'set_globe_time',
    description: 'Set the time of day on the Cesium globe. This moves the sun and changes lighting/shadows. Great for showing day vs night, sunrise/sunset over a landmark, or a specific historical moment.',
    input_schema: {
      type: 'object',
      properties: {
        iso_datetime: {
          type: 'string',
          description: 'ISO 8601 datetime string, e.g. "2024-06-21T06:00:00Z" for summer solstice sunrise.',
        },
      },
      required: ['iso_datetime'],
    },
  },
  {
    name: 'clear_all_entities',
    description: 'Remove all markers, polygons, polylines, and loaded GeoJSON datasets from the Cesium globe. Use when starting a fresh query or when the user asks to clear/reset the map.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are "Ask Cesium", an AI geospatial assistant that controls a live CesiumJS 3D globe in the user's browser.

When users ask geographic questions or request visualizations, you use your tools to:
1. Fetch real geodata (geocoding, OpenStreetMap search)
2. Queue visual actions on the globe (fly to, add markers, draw polygons, etc.)
3. Give a concise, informative explanation of what you've shown

## Tool Usage Rules

- ALWAYS use geocode_location before fly_to when you have a place name (not exact coordinates)
- After flying to a location, use add_point_marker to highlight the key point(s) of interest
- For list queries ("5 tallest mountains", "major airports in Japan"), add a separate marker per item with descriptive labels
- Use search_osm_features to surface real-world data — don't invent coordinates for things like volcanoes, peaks, hospitals
- When search_osm_features returns results, add markers for each result then fly_to a view that shows them all
- Use clear_all_entities at the start when the user is clearly asking about something new and unrelated to the current view

## Altitude Guidelines for fly_to
- Whole continent: 8,000,000 – 12,000,000 m
- Large country: 2,000,000 – 5,000,000 m
- Small country / region: 300,000 – 1,000,000 m
- City overview: 50,000 – 200,000 m
- Neighborhood / district: 3,000 – 30,000 m
- Single building / landmark: 300 – 2,000 m

## Response Style
- 2–4 sentences explaining what you're showing and key facts (height, population, age, etc.)
- Use bold (**text**) for place names and key stats
- If OSM search returns 0 results, acknowledge it and show what you found instead
- Never refuse — always try to show something helpful

## Example flows
- "Show me the Eiffel Tower" → geocode → fly_to Paris at ~1500m → add_point_marker at Eiffel Tower → brief response
- "Map active volcanoes in Indonesia" → geocode Indonesia → fly_to Indonesia at 2,000,000m → search_osm_features natural=volcano (large radius) → markers for each → response
- "Clear the map" → clear_all_entities → "Cleared the globe."`;

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function geocodeLocation(place_name) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place_name)}&format=json&limit=3`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AskCesiumAI/1.0 (geospatial demo)' },
  });
  if (!res.ok) return { error: `Nominatim returned ${res.status}` };
  const data = await res.json();
  if (!data.length) return { error: `Could not find location: "${place_name}"` };
  const top = data[0];
  return {
    lat: parseFloat(top.lat),
    lng: parseFloat(top.lon),
    display_name: top.display_name,
    type: top.type,
    boundingbox: top.boundingbox, // [minlat, maxlat, minlng, maxlng]
    alternatives: data.slice(1).map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      name: r.display_name,
    })),
  };
}

async function searchOsmFeatures({ lat, lng, radius_meters, feature_type, limit = 10 }) {
  const parts = feature_type.split('=');
  if (parts.length !== 2) return { error: 'feature_type must be "key=value"' };
  const [key, value] = parts;
  const cap = Math.min(Math.max(1, limit), 30);

  const query = `[out:json][timeout:20];(node["${key}"="${value}"](around:${radius_meters},${lat},${lng});way["${key}"="${value}"](around:${radius_meters},${lat},${lng}););out center ${cap};`;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  });
  if (!res.ok) return { error: `Overpass API returned ${res.status}` };
  const data = await res.json();

  const results = (data.elements ?? [])
    .slice(0, cap)
    .map((el) => {
      const elLat = el.lat ?? el.center?.lat;
      const elLng = el.lon ?? el.center?.lon;
      if (!elLat || !elLng) return null;
      return {
        lat: elLat,
        lng: elLng,
        name: el.tags?.name || el.tags?.['name:en'] || feature_type,
        tags: Object.fromEntries(
          Object.entries(el.tags ?? {}).filter(([k]) =>
            ['name', 'name:en', 'height', 'ele', 'operator', 'description', 'website'].includes(k)
          )
        ),
      };
    })
    .filter(Boolean);

  return { count: results.length, results };
}

// ---------------------------------------------------------------------------
// Execute a single tool call; returns result object and appends to actions[]
// ---------------------------------------------------------------------------

async function executeTool(name, input, actions) {
  switch (name) {
    case 'geocode_location':
      return await geocodeLocation(input.place_name);

    case 'fly_to':
      actions.push({
        type: 'fly_to',
        lat: input.lat,
        lng: input.lng,
        altitude: input.altitude_meters,
        heading: input.heading_degrees ?? 0,
        pitch: input.pitch_degrees ?? -45,
      });
      return {
        success: true,
        message: `Camera will fly to (${input.lat.toFixed(4)}, ${input.lng.toFixed(4)}) at ${input.altitude_meters}m.`,
      };

    case 'add_point_marker':
      actions.push({
        type: 'add_marker',
        lat: input.lat,
        lng: input.lng,
        label: input.label,
        description: input.description ?? '',
        color: input.color ?? '#FFD700',
        size: input.size ?? 12,
      });
      return { success: true, message: `Marker "${input.label}" queued at (${input.lat}, ${input.lng}).` };

    case 'add_polyline':
      actions.push({
        type: 'add_polyline',
        coordinates: input.coordinates,
        label: input.label,
        color: input.color ?? '#FF4444',
        width: input.width ?? 3,
      });
      return { success: true, message: `Polyline "${input.label}" queued.` };

    case 'add_polygon':
      actions.push({
        type: 'add_polygon',
        coordinates: input.coordinates,
        label: input.label,
        color: input.color ?? '#4488FF',
        alpha: input.alpha ?? 0.35,
      });
      return { success: true, message: `Polygon "${input.label}" queued.` };

    case 'search_osm_features':
      return await searchOsmFeatures(input);

    case 'load_geojson_url': {
      try {
        const parsed = new URL(input.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { error: 'Only http/https URLs are allowed.' };
        }
      } catch {
        return { error: 'Invalid URL.' };
      }
      actions.push({
        type: 'load_geojson',
        url: input.url,
        label: input.label,
        color: input.color ?? '#FFFFFF',
      });
      return { success: true, message: `GeoJSON "${input.label}" will be loaded from ${input.url}.` };
    }

    case 'set_globe_time':
      actions.push({ type: 'set_time', datetime: input.iso_datetime });
      return { success: true, message: `Globe time set to ${input.iso_datetime}.` };

    case 'clear_all_entities':
      actions.push({ type: 'clear' });
      return { success: true, message: 'All entities cleared.' };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// POST /api/query — main endpoint
// ---------------------------------------------------------------------------

app.post('/api/query', async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  const actions = [];
  const messages = [...history, { role: 'user', content: message.trim() }];

  try {
    const MAX_LOOPS = 12;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      // Append Claude's response to message history for the next loop turn
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b) => b.type === 'text');
        return res.json({ message: textBlock?.text ?? 'Done.', actions });
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of response.content) {
          if (block.type === 'tool_use') {
            const result = await executeTool(block.name, block.input, actions);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason — return what we have
      break;
    }

    res.json({ message: 'Analysis complete.', actions });
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/config — expose non-secret config to the frontend
// ---------------------------------------------------------------------------

app.get('/api/config', (_req, res) => {
  res.json({ cesiumIonToken: process.env.CESIUM_ION_TOKEN ?? '' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`\n🌍 Ask Cesium AI`);
  console.log(`   http://localhost:${PORT}\n`);
});
