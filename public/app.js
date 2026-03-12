// ── Ask Cesium AI — frontend ──────────────────────────────────────────────

let viewer = null;
let conversationHistory = [];
let isLoading = false;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('load', init);

async function init() {
  // Fetch Cesium Ion token from server
  let cesiumIonToken = '';
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    cesiumIonToken = cfg.cesiumIonToken ?? '';
  } catch {
    // server not ready yet — continue without token
  }

  if (cesiumIonToken) {
    Cesium.Ion.defaultAccessToken = cesiumIonToken;
  }

  // Initialize CesiumJS viewer
  try {
    const terrainProvider = cesiumIonToken
      ? await Cesium.createWorldTerrainAsync()
      : new Cesium.EllipsoidTerrainProvider();

    viewer = new Cesium.Viewer('cesiumContainer', {
      terrainProvider,
      timeline: false,
      animation: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: true,
      selectionIndicator: true,
      skyAtmosphere: new Cesium.SkyAtmosphere(),
    });

    // Enable atmosphere + lighting for cinematic look
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.atmosphereLightIntensity = 10.0;

    // Cinematic opening: Earth from space
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(20, 20, 24_000_000),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });

    // Slowly drift in to a comfortable view
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(10, 28, 16_000_000),
      duration: 3.5,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
  } catch (err) {
    console.error('Cesium init error:', err);
  }

  // Hide loading overlay
  const loading = document.getElementById('cesium-loading');
  if (loading) {
    loading.style.opacity = '0';
    loading.style.transition = 'opacity 0.5s';
    setTimeout(() => loading.remove(), 500);
  }

  // Wire UI
  document.getElementById('send-btn').addEventListener('click', handleSend);
  document.getElementById('query-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  document.getElementById('query-input').addEventListener('input', autoResize);
  document.getElementById('new-chat-btn').addEventListener('click', newConversation);
  wireStarterBtns();
}

// ---------------------------------------------------------------------------
// New conversation
// ---------------------------------------------------------------------------

function newConversation() {
  conversationHistory = [];

  if (viewer) {
    viewer.entities.removeAll();
    viewer.dataSources.removeAll();
    viewer.scene.globe.enableLighting = true;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(10, 28, 16_000_000),
      duration: 2.5,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
  }

  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = welcomeHTML();
  wireStarterBtns();
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

async function handleSend() {
  if (isLoading) return;

  const inputEl = document.getElementById('query-input');
  const message = inputEl.value.trim();
  if (!message) return;

  // Clear input
  inputEl.value = '';
  inputEl.style.height = 'auto';

  setLoading(true);

  // Remove welcome screen on first real message
  document.getElementById('welcome')?.remove();

  // Render user bubble
  appendBubble('user', message);

  // Track history (we send n-1 history + current message via req body)
  conversationHistory.push({ role: 'user', content: message });

  // Show typing indicator
  const typingEl = showTyping();

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        // Send all history except the message we just added (server appends it)
        history: conversationHistory.slice(0, -1),
      }),
    });

    typingEl.remove();

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `Server error ${res.status}`);
    }

    const data = await res.json();

    // Add assistant response to history for multi-turn context
    conversationHistory.push({ role: 'assistant', content: data.message });

    // Render assistant bubble
    appendBubble('assistant', data.message, data.actions ?? []);

    // Execute Cesium actions
    if (data.actions?.length) {
      await executeActions(data.actions);
    }
  } catch (err) {
    typingEl.remove();
    showError(err.message);
    // Roll back failed user message from history
    conversationHistory.pop();
  } finally {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function appendBubble(role, text, actions = []) {
  const messagesEl = document.getElementById('messages');

  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;

  // Label
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'Ask Cesium AI';
  wrap.appendChild(label);

  // Bubble
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = renderMarkdown(text);
  wrap.appendChild(bubble);

  // Action tags (assistant only)
  if (role === 'assistant' && actions.length > 0) {
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'action-tags';
    const uniqueTypes = [...new Set(actions.map((a) => actionTypeLabel(a.type)))];
    tagsWrap.innerHTML = uniqueTypes.map((t) => `<span class="action-tag">✦ ${t}</span>`).join('');
    wrap.appendChild(tagsWrap);
  }

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function actionTypeLabel(type) {
  return (
    {
      fly_to: 'Flew to location',
      add_marker: 'Added marker',
      add_polygon: 'Drew polygon',
      add_polyline: 'Drew line',
      load_geojson: 'Loaded dataset',
      set_time: 'Set globe time',
      clear: 'Cleared globe',
    }[type] ?? type
  );
}

/** Very lightweight markdown → HTML: bold, italic, bullet lists, line breaks */
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

function showTyping() {
  const messagesEl = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Ask Cesium AI';

  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

  wrap.appendChild(label);
  wrap.appendChild(indicator);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

function setLoading(state) {
  isLoading = state;
  document.getElementById('send-btn').disabled = state;
  document.getElementById('query-input').disabled = state;
}

function showError(msg) {
  const toast = document.getElementById('error-toast');
  toast.textContent = `Error: ${msg}`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 5000);
}

function autoResize() {
  const el = document.getElementById('query-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function wireStarterBtns() {
  document.querySelectorAll('.starter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('query-input').value = btn.dataset.query;
      handleSend();
    });
  });
}

// ---------------------------------------------------------------------------
// Cesium action executor
// ---------------------------------------------------------------------------

async function executeActions(actions) {
  for (const action of actions) {
    try {
      await executeAction(action);
    } catch (err) {
      console.warn('[Cesium] action failed:', action.type, err);
    }
  }
}

async function executeAction(action) {
  if (!viewer) return;

  switch (action.type) {
    // ── Fly camera ─────────────────────────────────────────────────────────
    case 'fly_to': {
      const dest = Cesium.Cartesian3.fromDegrees(action.lng, action.lat, action.altitude);
      viewer.camera.flyTo({
        destination: dest,
        duration: 2.5,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        orientation: {
          heading: Cesium.Math.toRadians(action.heading ?? 0),
          pitch: Cesium.Math.toRadians(action.pitch ?? -45),
          roll: 0,
        },
      });
      await sleep(2800); // wait for animation before placing markers
      break;
    }

    // ── Point marker ───────────────────────────────────────────────────────
    case 'add_marker': {
      const color = safeColor(action.color, '#FFD700');
      viewer.entities.add({
        name: action.label,
        position: Cesium.Cartesian3.fromDegrees(action.lng, action.lat),
        point: {
          pixelSize: action.size ?? 12,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: action.label,
          font: '13px Inter, system-ui, sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -22),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          showBackground: true,
          backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
        },
        description: action.description || undefined,
      });
      break;
    }

    // ── Polyline ───────────────────────────────────────────────────────────
    case 'add_polyline': {
      // coordinates: [[lat,lng], ...]  →  Cesium wants [lng,lat, ...]
      const coords = action.coordinates.flatMap(([lat, lng]) => [lng, lat]);
      viewer.entities.add({
        name: action.label,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(coords),
          width: action.width ?? 3,
          material: safeColor(action.color, '#FF4444'),
          clampToGround: true,
        },
      });
      break;
    }

    // ── Polygon ────────────────────────────────────────────────────────────
    case 'add_polygon': {
      const coords = action.coordinates.flatMap(([lat, lng]) => [lng, lat]);
      const fillColor = safeColor(action.color, '#4488FF').withAlpha(action.alpha ?? 0.35);
      const outlineColor = safeColor(action.color, '#4488FF');
      viewer.entities.add({
        name: action.label,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(coords),
          material: fillColor,
          outline: true,
          outlineColor,
          outlineWidth: 2,
          clampToGround: true,
        },
      });
      break;
    }

    // ── GeoJSON dataset ────────────────────────────────────────────────────
    case 'load_geojson': {
      const stroke = safeColor(action.color, '#FFFFFF');
      const fill = safeColor(action.color, '#FFFFFF').withAlpha(0.3);
      const ds = await Cesium.GeoJsonDataSource.load(action.url, {
        clampToGround: true,
        stroke,
        fill,
        strokeWidth: 2,
      });
      ds.name = action.label;
      await viewer.dataSources.add(ds);
      break;
    }

    // ── Globe time ─────────────────────────────────────────────────────────
    case 'set_time': {
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(action.datetime);
      viewer.clock.shouldAnimate = false;
      viewer.scene.globe.enableLighting = true;
      break;
    }

    // ── Clear all ──────────────────────────────────────────────────────────
    case 'clear': {
      viewer.entities.removeAll();
      viewer.dataSources.removeAll();
      break;
    }

    default:
      console.warn('[Cesium] unknown action type:', action.type);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function safeColor(cssColor, fallback) {
  try {
    return Cesium.Color.fromCssColorString(cssColor ?? fallback);
  } catch {
    return Cesium.Color.fromCssColorString(fallback);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Welcome HTML template
// ---------------------------------------------------------------------------

function welcomeHTML() {
  return `
    <div id="welcome">
      <div class="welcome-icon">🌍</div>
      <h2>Ask Cesium AI</h2>
      <p>Ask any question about Earth — I'll fly the 3D globe there, add markers, and surface real geospatial data.</p>
      <div class="starter-prompts">
        <button class="starter-btn" data-query="Show me the Eiffel Tower in Paris">
          <span class="starter-icon">🗼</span> Show me the Eiffel Tower
        </button>
        <button class="starter-btn" data-query="Map active volcanoes in Indonesia">
          <span class="starter-icon">🌋</span> Map active volcanoes in Indonesia
        </button>
        <button class="starter-btn" data-query="Show me the 5 highest mountain peaks in the Himalayas">
          <span class="starter-icon">🏔️</span> Highest Himalayan peaks
        </button>
        <button class="starter-btn" data-query="Fly to the Amazon rainforest in Brazil and describe it">
          <span class="starter-icon">🌿</span> Fly to the Amazon rainforest
        </button>
        <button class="starter-btn" data-query="Show major international airports in Japan">
          <span class="starter-icon">✈️</span> Airports in Japan
        </button>
        <button class="starter-btn" data-query="Show me the Great Barrier Reef from above at sunset">
          <span class="starter-icon">🐠</span> Great Barrier Reef at sunset
        </button>
      </div>
    </div>`;
}
