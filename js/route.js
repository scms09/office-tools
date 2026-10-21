/*
 * Route Planner: Google Routes API -> editable journey legs -> slide.
 * Slide layout lives in buildSlides(): map on the left, legs + comparison on the right.
 */
(function () {
  const KEY = 'route.draft.v1';
  const API_KEY = 'gmaps.apiKey';

  const TRAVEL_MODES = { TRANSIT: 'Public transport', DRIVE: 'Car', WALK: 'Walking', BICYCLE: 'Bicycle', TWO_WHEELER: 'Motorbike' };
  const GMAPS_MODE = { TRANSIT: 'transit', DRIVE: 'driving', WALK: 'walking', BICYCLE: 'bicycling', TWO_WHEELER: 'driving' };
  const LEG_FOR_MODE = { DRIVE: 'Car', WALK: 'Walk', BICYCLE: 'Bike', TWO_WHEELER: 'Motorbike' };
  // Badge colour for each leg mode on the slide.
  const LEG_MODES = {
    Walk: '6B7280', Train: 'C0392B', Subway: '8E44AD', Bus: '27AE60', Tram: 'D35400', Ferry: '2980B9',
    Car: '2E86DE', Taxi: 'B7950B', Bike: 'F39C12', Motorbike: '16A085', Flight: '34495E', Other: '7F8C8D',
  };
  const VEHICLE = {
    BUS: 'Bus', INTERCITY_BUS: 'Bus', TROLLEYBUS: 'Bus',
    SUBWAY: 'Subway', METRO_RAIL: 'Subway',
    RAIL: 'Train', HEAVY_RAIL: 'Train', COMMUTER_TRAIN: 'Train', HIGH_SPEED_TRAIN: 'Train', LONG_DISTANCE_TRAIN: 'Train', MONORAIL: 'Train',
    TRAM: 'Tram', LIGHT_RAIL: 'Tram', CABLE_CAR: 'Tram', FUNICULAR: 'Tram', GONDOLA_LIFT: 'Tram',
    FERRY: 'Ferry', SHARE_TAXI: 'Taxi',
  };
  const FIELDS = [
    'routes.duration', 'routes.distanceMeters', 'routes.polyline.encodedPolyline', 'routes.localizedValues',
    'routes.legs.steps.travelMode', 'routes.legs.steps.staticDuration', 'routes.legs.steps.distanceMeters', 'routes.legs.steps.transitDetails',
  ].join(',');

  const defaults = () => ({
    origin: '', destination: '', mode: 'TRANSIT', compare: ['DRIVE', 'WALK'], departure: '', units: 'METRIC',
    title: '', subtitle: '', map: null, legs: [], comparison: [],
  });
  const state = { ...defaults(), ...App.store.get(KEY, {}) };

  const $ = (id) => document.getElementById(id);

  // ---------- Formatting ----------
  const secs = (d) => parseInt(String(d || '0').replace('s', ''), 10) || 0;
  function fmtDur(s) {
    const m = Math.round(s / 60);
    if (m < 60) return `${Math.max(m, 1)} min`;
    return `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
  }
  function fmtDist(meters) {
    if (state.units === 'IMPERIAL') {
      const mi = meters / 1609.34;
      return mi < 0.2 ? `${Math.round(meters * 3.281)} ft` : `${mi.toFixed(1)} mi`;
    }
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  }

  // ---------- Google APIs ----------
  async function computeRoute(travelMode, key) {
    const body = {
      origin: { address: state.origin }, destination: { address: state.destination },
      travelMode, languageCode: 'en', units: state.units,
    };
    if (state.departure && travelMode === 'TRANSIT') {
      const d = new Date(state.departure);
      if (d > new Date()) body.departureTime = d.toISOString();
    }
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || res.statusText);
    if (!json.routes || !json.routes.length) {
      throw new Error(travelMode === 'TRANSIT'
        ? 'No public transport route found. Google does not provide train timetables for some countries (e.g. Japan) through its API — use "Open in Google Maps" and type the legs in.'
        : `No ${TRAVEL_MODES[travelMode].toLowerCase()} route found`);
    }
    return json.routes[0];
  }

  const routeDuration = (r) => (r.localizedValues && r.localizedValues.duration && r.localizedValues.duration.text) || fmtDur(secs(r.duration));
  const routeDistance = (r) => (r.localizedValues && r.localizedValues.distance && r.localizedValues.distance.text) || fmtDist(r.distanceMeters || 0);

  // Transit routes become one leg per vehicle ride, with consecutive walking steps merged.
  // Other modes are a single door-to-door leg.
  function legsFromRoute(route, mode) {
    if (mode !== 'TRANSIT') {
      return [{ mode: LEG_FOR_MODE[mode], from: state.origin, to: state.destination, detail: '', duration: routeDuration(route), distance: routeDistance(route) }];
    }
    const out = [];
    (route.legs || []).flatMap((l) => l.steps || []).forEach((s) => {
      const t = s.transitDetails;
      if (s.travelMode === 'TRANSIT' && t) {
        const line = t.transitLine || {};
        const stops = t.stopDetails || {};
        const dep = t.localizedValues && t.localizedValues.departureTime && t.localizedValues.departureTime.time && t.localizedValues.departureTime.time.text;
        out.push({
          mode: VEHICLE[line.vehicle && line.vehicle.type] || 'Other',
          from: (stops.departureStop && stops.departureStop.name) || '',
          to: (stops.arrivalStop && stops.arrivalStop.name) || '',
          detail: [line.nameShort || line.name, t.headsign && `towards ${t.headsign}`, t.stopCount && `${t.stopCount} stops`, dep && `dep ${dep}`].filter(Boolean).join(' · '),
          _s: secs(s.staticDuration), _m: s.distanceMeters || 0,
        });
      } else {
        const last = out[out.length - 1];
        if (last && last._walk) { last._s += secs(s.staticDuration); last._m += s.distanceMeters || 0; }
        else out.push({ mode: 'Walk', from: '', to: '', detail: '', _walk: true, _s: secs(s.staticDuration), _m: s.distanceMeters || 0 });
      }
    });
    out.forEach((l, i) => {
      if (!l._walk) return;
      l.from = i === 0 ? state.origin : out[i - 1].to;
      l.to = i === out.length - 1 ? state.destination : out[i + 1].from;
    });
    return out.map(({ _s, _m, _walk, ...l }) => ({ ...l, duration: fmtDur(_s), distance: fmtDist(_m) }));
  }

  function staticMapUrl(polyline, key) {
    const q = [
      'size=620x560', 'scale=2', 'maptype=roadmap',
      `path=${encodeURIComponent(`color:0x2E86DEff|weight:5|enc:${polyline}`)}`,
      `markers=${encodeURIComponent(`color:green|label:A|${state.origin}`)}`,
      `markers=${encodeURIComponent(`color:red|label:B|${state.destination}`)}`,
      `key=${encodeURIComponent(key)}`,
    ];
    return 'https://maps.googleapis.com/maps/api/staticmap?' + q.join('&');
  }

  // Reads an image (URL or File) into { data: dataURL, w, h } so it can be embedded in the .pptx.
  async function loadImage(src) {
    const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Not a valid image')); img.src = data; });
    return { data, w: img.naturalWidth, h: img.naturalHeight };
  }

  async function fetchRoute() {
    const key = $('apiKey').value.trim();
    if (!key) { $('keyBox').open = true; setStatus('Add a Google Maps API key first (or fill in the legs manually).', true); return; }
    if (!state.origin || !state.destination) { setStatus('Enter both From and To.', true); return; }

    const btn = $('fetch');
    btn.disabled = true;
    setStatus('Fetching route…');
    try {
      const main = await computeRoute(state.mode, key);
      state.legs = legsFromRoute(main, state.mode);
      state.subtitle = `By ${TRAVEL_MODES[state.mode].toLowerCase()} · ${routeDuration(main)} · ${routeDistance(main)}`;

      const modes = [state.mode, ...state.compare.filter((m) => m !== state.mode)];
      const results = await Promise.allSettled(modes.map((m) => (m === state.mode ? Promise.resolve(main) : computeRoute(m, key))));
      state.comparison = modes.map((m, i) => results[i].status === 'fulfilled'
        ? { mode: TRAVEL_MODES[m], duration: routeDuration(results[i].value), distance: routeDistance(results[i].value) }
        : { mode: TRAVEL_MODES[m], duration: 'n/a', distance: '' });
      if (state.comparison.length < 2) state.comparison = [];

      let note = '';
      if (main.polyline && main.polyline.encodedPolyline) {
        try { state.map = await loadImage(staticMapUrl(main.polyline.encodedPolyline, key)); }
        catch { note = ' Map image could not be loaded — check that Maps Static API is enabled, or upload a screenshot.'; }
      }
      syncInputs();
      renderTables();
      refresh();
      setStatus('Route loaded. Edit anything below before downloading.' + note, !!note);
    } catch (err) {
      setStatus('Google Maps: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Slide ----------
  function buildSlides() {
    const T = SlideKit.THEME;
    const title = state.title || (state.origin && state.destination ? `${state.origin} → ${state.destination}` : 'Route');
    const els = SlideKit.frame(title, state.subtitle);
    const top = state.subtitle ? 1.5 : 1.15, bottom = 7.2;

    const mapBox = { x: 0.4, y: top, w: 6.1, h: bottom - top };
    if (state.map) {
      els.push({ type: 'image', ...mapBox, data: state.map.data, imgW: state.map.w, imgH: state.map.h });
    } else {
      els.push({ type: 'rect', ...mapBox, fill: T.light, line: T.border });
      els.push({ type: 'text', ...mapBox, text: 'Map\nFetch a route or upload an image', align: 'center', valign: 'middle', fontSize: 14, color: T.muted });
    }

    const rx = 6.8, rw = SlideKit.W - 0.4 - rx;
    let y = top;
    els.push({ type: 'text', x: rx, y, w: rw, h: 0.4, text: 'Journey', fontSize: 16, bold: true, color: T.primary, margin: 0 });
    y += 0.45;

    const cmp = state.comparison.filter((c) => c.mode);
    const cmpRowH = 0.3;
    const cmpH = cmp.length ? 0.45 + cmpRowH * (cmp.length + 1) : 0;
    const legs = state.legs.filter((l) => l.mode || l.from || l.to);
    const avail = bottom - y - (cmp.length ? cmpH + 0.25 : 0);

    if (!legs.length) {
      els.push({ type: 'text', x: rx, y, w: rw, h: 0.5, text: 'Add journey legs on the left.', fontSize: 12, italic: true, color: T.muted, margin: 0 });
    }
    const lh = legs.length ? Math.min(0.8, avail / legs.length) : 0;
    const k = Math.min(1, lh / 0.7); // shrink text when there are many legs
    const fs = (n) => Math.max(7, Math.round(n * k));
    const badgeW = 1.05, timeW = 1.15, textX = rx + badgeW + 0.12, textW = rw - badgeW - 0.12 - timeW;
    legs.forEach((l, i) => {
      const ly = y + i * lh, bh = lh - 0.1;
      els.push({ type: 'rect', x: rx, y: ly, w: badgeW, h: bh, fill: LEG_MODES[l.mode] || LEG_MODES.Other });
      els.push({ type: 'text', x: rx, y: ly, w: badgeW, h: bh, text: l.mode || '', fontSize: fs(11), bold: true, color: T.white, align: 'center', valign: 'middle' });
      els.push({ type: 'text', x: textX, y: ly, w: textW, h: bh * 0.55, text: [l.from, l.to].filter(Boolean).join(' → '), fontSize: fs(12), bold: true, valign: 'bottom', margin: 2 });
      els.push({ type: 'text', x: textX, y: ly + bh * 0.55, w: textW, h: bh * 0.45, text: l.detail || '', fontSize: fs(10), color: T.muted, valign: 'top', margin: 2 });
      els.push({ type: 'text', x: rx + rw - timeW, y: ly, w: timeW, h: bh, text: [l.duration, l.distance].filter(Boolean).join('\n'), fontSize: fs(11), bold: true, align: 'right', valign: 'middle', margin: 2 });
    });

    if (cmp.length) {
      const cy = bottom - cmpH;
      els.push({ type: 'text', x: rx, y: cy, w: rw, h: 0.4, text: 'Mode comparison', fontSize: 16, bold: true, color: T.primary, margin: 0 });
      els.push({
        type: 'table', x: rx, y: cy + 0.45, w: rw, colW: [rw * 0.44, rw * 0.28, rw * 0.28], rowH: cmpRowH, fontSize: 11, header: true, zebra: true,
        rows: [['Mode', 'Time', 'Distance'], ...cmp.map((c) => [c.mode, c.duration, c.distance])],
      });
    }
    return [{ elements: els }];
  }

  const refresh = App.debounce(() => {
    App.store.set(KEY, state);
    updateGmapsLink();
    $('mapThumb').hidden = !state.map;
    if (state.map) $('mapThumb').src = state.map.data;
    SlideKit.renderPreview($('preview'), buildSlides());
  }, 120);

  // ---------- Form ----------
  function setStatus(msg, isError) {
    const s = $('status');
    s.textContent = msg;
    s.classList.toggle('error', !!isError);
  }

  function updateGmapsLink() {
    const p = new URLSearchParams({ api: '1', origin: state.origin, destination: state.destination, travelmode: GMAPS_MODE[state.mode] });
    $('gmapsLink').href = 'https://www.google.com/maps/dir/?' + p.toString();
  }

  // Generic editable table: rows of objects, one input per column.
  function editableRows(tbodyId, list, columns) {
    const tbody = $(tbodyId);
    tbody.innerHTML = '';
    list.forEach((row, i) => {
      const tr = App.el('tr');
      columns.forEach((col) => {
        let input;
        if (col.options) {
          input = App.el('select', {}, col.options.map((o) => App.el('option', { value: o }, o)));
          if (row[col.key] && !col.options.includes(row[col.key])) input.append(App.el('option', { value: row[col.key] }, row[col.key]));
        } else {
          input = App.el('input', { type: 'text', placeholder: col.placeholder || '' });
        }
        input.value = row[col.key] || '';
        if (col.width) input.style.minWidth = col.width;
        input.addEventListener('input', () => { row[col.key] = input.value; refresh(); });
        tr.appendChild(App.el('td', {}, input));
      });
      tr.appendChild(App.el('td', {}, App.el('button', {
        class: 'btn icon', title: 'Remove', onclick: () => { list.splice(i, 1); renderTables(); refresh(); },
      }, '✕')));
      tbody.appendChild(tr);
    });
  }

  function renderTables() {
    editableRows('legs', state.legs, [
      { key: 'mode', options: Object.keys(LEG_MODES), width: '84px' },
      { key: 'from', width: '110px' },
      { key: 'to', width: '110px' },
      { key: 'detail', placeholder: 'Line, platform…', width: '120px' },
      { key: 'duration', width: '64px' },
      { key: 'distance', width: '60px' },
    ]);
    editableRows('comparison', state.comparison, [
      { key: 'mode', placeholder: 'e.g. Car' },
      { key: 'duration' },
      { key: 'distance' },
    ]);
  }

  const FIELDS_IN_FORM = ['origin', 'destination', 'mode', 'departure', 'units', 'title', 'subtitle'];
  function syncInputs() { FIELDS_IN_FORM.forEach((id) => { $(id).value = state[id] || ''; }); }

  function init() {
    syncInputs();
    FIELDS_IN_FORM.forEach((id) => $(id).addEventListener('input', () => { state[id] = $(id).value; refresh(); }));

    const cmpBox = $('compare');
    Object.entries(TRAVEL_MODES).forEach(([m, label]) => {
      const cb = App.el('input', { type: 'checkbox', value: m });
      cb.checked = state.compare.includes(m);
      cb.addEventListener('change', () => {
        state.compare = [...cmpBox.querySelectorAll('input:checked')].map((c) => c.value);
        refresh();
      });
      cmpBox.appendChild(App.el('label', {}, cb, label));
    });

    const key = $('apiKey');
    key.value = App.store.get(API_KEY, '');
    key.addEventListener('input', () => App.store.set(API_KEY, key.value.trim()));
    if (!key.value) $('keyBox').open = true;

    $('fetch').addEventListener('click', fetchRoute);
    $('addLeg').addEventListener('click', () => { state.legs.push({ mode: 'Walk', from: '', to: '', detail: '', duration: '', distance: '' }); renderTables(); refresh(); });
    $('addCmp').addEventListener('click', () => { state.comparison.push({ mode: '', duration: '', distance: '' }); renderTables(); refresh(); });
    $('mapUpload').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { state.map = await loadImage(file); refresh(); } catch (err) { App.toast(err.message, 'error'); }
      e.target.value = '';
    });
    $('mapRemove').addEventListener('click', () => { state.map = null; refresh(); });
    $('download').addEventListener('click', async () => {
      try {
        await SlideKit.exportPptx(buildSlides(), state.title || (state.origin ? `Route ${state.origin} to ${state.destination}` : 'Route'));
      } catch (err) {
        App.toast('Could not create the file: ' + err.message, 'error');
      }
    });

    renderTables();
    refresh();
  }

  init();
})();
