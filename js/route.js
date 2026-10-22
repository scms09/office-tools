/*
 * Route Planner: compares train all the way, train part of the way + car, and
 * car all the way, recommends one, and lays the chosen journey out on a slide
 * (map on the left, legs + comparison on the right).
 * Train/car look-ups live in js/transit.js; API keys come from the Trip Schedule page.
 */
(function () {
  const KEY = 'route.draft.v2';
  const MIN_SAVING_MIN = 15; // train + car must save this much over train only to be recommended
  // Stations where the car could start: Geoapify rates up to MAX_CANDIDATES in one
  // request (traffic-adjusted, see js/transit.js) and the best one gets a full route
  // for the map. Without a Geoapify key, Google checks the NO_GEOAPIFY_STATIONS closest.
  const MAX_CANDIDATES = 25;
  const NO_GEOAPIFY_STATIONS = 5;

  // Badge colour for each leg mode on the slide.
  const LEG_MODES = {
    Walk: '6B7280', Train: 'C0392B', Subway: '8E44AD', Bus: '27AE60', Tram: 'D35400', Ferry: '2980B9',
    Car: '2E86DE', Taxi: 'B7950B', Bike: 'F39C12', Motorbike: '16A085', Flight: '34495E', Other: '7F8C8D',
  };

  const defaults = () => ({
    origin: '', destination: '', via: '', date: '', time: '09:00', timeMode: 'leave',
    tz: App.store.get('trip.draft.v1', {}).tz || Transit.browserTz, pickup: 10, units: 'METRIC',
    title: '', subtitle: '', map: null, legs: [], comparison: [],
  });
  const state = { ...defaults(), ...App.store.get(KEY, {}) };
  let options = []; // last comparison (not saved)

  const $ = (id) => document.getElementById(id);
  const hm = (d) => Transit.utcToZoned(d, state.tz).time;
  const durMin = (o) => Math.round((o.arr - o.dep) / 60000);
  function fmtDist(meters) {
    if (state.units === 'IMPERIAL') {
      const mi = meters / 1609.34;
      return mi < 0.2 ? `${Math.round(meters * 3.281)} ft` : `${mi.toFixed(1)} mi`;
    }
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  }

  // ---------- Comparing the options ----------

  // Stations along the train routes where you could get off and take a car for
  // the last stretch: only those within about a third of the trip (5–25 km) of
  // the destination, otherwise "train one stop, then drive" is just driving.
  // With a preferred station, only stations reached after it count (the station
  // itself always does). Ordered by a rough guess (straight line at ~35 km/h).
  function carStations(routes, start, goal, viaCoord) {
    const radius = Math.max(5, Math.min(25, Transit.km(start, goal) / 3));
    const best = new Map();
    routes.forEach((route) => route.legs.forEach((leg, legIndex) => {
      if (leg.kind !== 'ride') return;
      [...leg.stops, { name: leg.to, coord: leg.toCoord, arr: leg.arr }].forEach((s) => {
        if (!s.name || !s.coord) return;
        const isVia = viaCoord && Transit.km(s.coord, viaCoord) < 1;
        if (!isVia && Transit.km(s.coord, goal) > radius) return;
        if (route.viaArr && s.arr < route.viaArr - 60000) return; // before the preferred station
        const guess = (s.arr - route.dep) + (Transit.km(s.coord, goal) / 35) * 3600e3;
        const prev = best.get(s.name);
        if (!prev || guess < prev.guess) best.set(s.name, { ...s, route, legIndex, guess });
      });
    }));
    return [...best.values()].sort((a, b) => a.guess - b.guess).slice(0, MAX_CANDIDATES);
  }

  // Stations worth a full drive look-up: with Geoapify, the single best one from its
  // one-request estimates; otherwise the closest few by the rough guess.
  async function shortlist(stations, goal) {
    if (!Transit.keys().geoapify) return stations.slice(0, NO_GEOAPIFY_STATIONS);
    const quick = await Transit.quickDriveTimes(stations.map((s) => s.coord), goal);
    const rated = stations.map((s, i) => ({ s, est: quick[i] ? (s.arr - s.route.dep) + quick[i].secs * 1000 : Infinity }));
    rated.sort((a, b) => a.est - b.est);
    return rated.length && rated[0].est < Infinity ? [rated[0].s] : [];
  }

  // The best "train to a station, then car" journey, or null.
  async function trainPlusCar(routes, start, goal, viaCoord) {
    const stations = await shortlist(carStations(routes, start, goal, viaCoord), goal);
    const drives = await Promise.allSettled(stations.map((s) => Transit.drive(s.coord, goal)));
    let best = null;
    stations.forEach((s, i) => {
      const d = drives[i].status === 'fulfilled' && drives[i].value;
      if (!d) return;
      const carDep = new Date(s.arr.getTime() + state.pickup * 60000);
      const arr = new Date(carDep.getTime() + d.secs * 1000);
      if (!best || arr - s.route.dep < best.arr - best.s.route.dep) best = { s, d, carDep, arr };
    });
    if (!best) return null;
    const { s, d } = best;
    const ride = s.route.legs[s.legIndex];
    const legs = [
      ...s.route.legs.slice(0, s.legIndex),
      { ...ride, to: s.name, toCoord: s.coord, arr: s.arr, meters: ride.to === s.name ? ride.meters : 0, stops: ride.stops.filter((x) => x.arr < s.arr) },
      { kind: 'car', mode: 'Car', line: '', from: s.name, to: state.destination, fromCoord: s.coord, toCoord: goal, dep: best.carDep, arr: best.arr, meters: d.meters, polyline: d.polyline, path: d.path, wait: state.pickup },
    ];
    return { ...s.route, legs, arr: best.arr, fare: '', via: s.name };
  }

  function carOnly(car, when) {
    const dep = state.timeMode === 'arrive' ? new Date(when.getTime() - car.secs * 1000) : when;
    const arr = new Date(dep.getTime() + car.secs * 1000);
    return { source: 'Google', dep, arr, fare: '', legs: [{ kind: 'car', mode: 'Car', line: '', from: state.origin, to: state.destination, fromCoord: car.start, toCoord: car.goal, dep, arr, meters: car.meters, polyline: car.polyline, path: car.path }] };
  }

  // Train all the way + the best train-and-car journey for a set of train routes.
  async function trainOptions(routes, car, viaCoord) {
    if (!routes.length) return {};
    const train = routes.reduce((a, b) => ((b.arr - b.dep) < (a.arr - a.dep) ? b : a));
    const combo = await trainPlusCar(routes, car.start, car.goal, viaCoord);
    return { train, combo };
  }

  // Train + car is recommended only when it saves enough time over train only.
  function pickRecommended(trainOpt, comboOpt) {
    if (trainOpt && comboOpt) comboOpt.saving = durMin(trainOpt.route) - durMin(comboOpt.route);
    if (comboOpt && comboOpt.saving >= MIN_SAVING_MIN) return comboOpt;
    return trainOpt || comboOpt || null;
  }

  async function compareRoutes() {
    ['origin', 'destination', 'via', 'date', 'time'].forEach((id) => { state[id] = $(id).value.trim(); });
    if (!Transit.keys().geoapify && !Transit.keys().google) { $('keyNote').hidden = false; setStatus('Add your Geoapify key (or a Google Maps key) on the Trip Schedule page first.', true); return; }
    if (!state.origin || !state.destination || !state.date || !state.time) { setStatus('Fill in From, To, Date and Time.', true); return; }

    const btn = $('compare');
    btn.disabled = true;
    options = [];
    renderOptions();
    setStatus('Looking up trains…');
    try {
      const search = { from: state.origin, to: state.destination, date: state.date, time: state.time, mode: state.timeMode, tz: state.tz };
      const res = await Transit.trainRoutes(search, setStatus);
      const pl = res.places;
      const car = (pl && pl.car) || await Transit.drive(pl ? pl.start : state.origin, pl ? pl.goal : state.destination);
      if (!car) { setStatus('Could not find a road route between these places. Try adding the city or country.', true); return; }

      // Preferred station: find where it is, then trains that pass through it.
      let viaRes = null, viaCoord = null;
      if (state.via) {
        setStatus(`Finding ${state.via}…`);
        viaCoord = await Transit.geocode(state.via).catch(() => null);
        if (!viaCoord) { const d = await Transit.drive(state.via, car.goal); viaCoord = d && d.start; }
        if (!viaCoord) { setStatus(`Could not find "${state.via}". Try adding the city, e.g. "Kawagoe Station, Saitama".`, true); return; }
        setStatus(`Looking up trains via ${state.via}…`);
        viaRes = await Transit.trainRoutes({ ...search, via: { name: state.via, coord: viaCoord } }, setStatus);
      }

      setStatus('Checking drive times from stations along the way…');
      const base = await trainOptions(res.routes || [], car, null);
      const when = Transit.zonedToUtc(state.date, state.time, state.tz);
      const carOpt = { id: 'car', title: 'Car all the way', route: carOnly(car, when) };

      if (viaRes) {
        const pref = await trainOptions(viaRes.routes || [], car, viaCoord);
        const trainOpt = pref.train && { id: 'train', title: `Train via ${state.via}`, route: pref.train };
        const comboOpt = pref.combo && {
          id: 'combo', route: pref.combo,
          title: Transit.km(pref.combo.legs[pref.combo.legs.length - 1].fromCoord, viaCoord) < 1
            ? `Train to ${pref.combo.via} + car` : `Train via ${state.via} to ${pref.combo.via} + car`,
        };
        const rec = pickRecommended(trainOpt, comboOpt);
        // For reference: the best way when not going through the preferred station.
        const plainRec = pickRecommended(base.train && { id: 'train', title: 'Train all the way', route: base.train },
          base.combo && { id: 'combo', title: `Train to ${base.combo.via} + car`, route: base.combo });
        const ref = plainRec && { id: 'ref', title: `Not via ${state.via}: ${plainRec.title}`, route: plainRec.route };
        options = [trainOpt, comboOpt, carOpt, ref].filter(Boolean);
        if (rec) rec.recommended = true;
        if (ref && rec) ref.diff = durMin(ref.route) - durMin(rec.route);
        if (!trainOpt && !comboOpt) setStatus(`No trains found via ${state.via} for that time.`, true);
      } else {
        const trainOpt = base.train && { id: 'train', title: 'Train all the way', route: base.train };
        const comboOpt = base.combo && { id: 'combo', title: `Train to ${base.combo.via} + car`, route: base.combo };
        const rec = pickRecommended(trainOpt, comboOpt);
        options = [trainOpt, comboOpt, carOpt].filter(Boolean);
        if (rec) rec.recommended = true;
        else carOpt.recommended = true;
      }
      const fastest = options.reduce((a, b) => (durMin(b.route) < durMin(a.route) ? b : a));
      fastest.fastest = true;

      const anyTrains = options.some((o) => o.id === 'train' || o.id === 'combo');
      const leftCount = (viaRes && viaRes.left) || res.left;
      const left = leftCount != null ? ` NAVITIME searches left this month: ${leftCount}.` : '';
      if (anyTrains) setStatus(`Trains from ${(viaRes || res).source}.${left} Pick an option to put it on the slide.`);
      else if (!state.via) setStatus(`${Transit.reasonText(res.reason)} Showing the car option only.`, true);
      renderOptions();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
      App.store.set(KEY, state);
    }
  }

  // ---------- Option cards ----------
  function legLine(l) {
    if (l.kind === 'walk') return `Walk ${Transit.fmtDur((l.arr - l.dep) / 1000)}`;
    if (l.kind === 'car') return `Car ${hm(l.dep)} → ${hm(l.arr)}: ${l.from} → ${l.to} (${fmtDist(l.meters)}${l.wait ? `, after ${l.wait} min to get a car` : ''})`;
    return `${l.line} ${hm(l.dep)} → ${hm(l.arr)}: ${l.from} → ${l.to}`;
  }

  function optionNote(o) {
    if (o.id === 'combo' && o.saving != null) return o.saving > 0 ? `${o.saving} min faster than train only` : `${-o.saving} min slower than train only`;
    if (o.id === 'ref' && o.diff != null) return o.diff < 0 ? `${-o.diff} min faster than the recommended route` : o.diff > 0 ? `${o.diff} min slower than the recommended route` : 'same time as the recommended route';
    if (o.id === 'car') return fmtDist(o.route.legs[0].meters);
    return o.route.fare || '';
  }

  function renderOptions() {
    const box = $('options');
    box.innerHTML = '';
    options.forEach((o) => {
      const badges = [o.recommended && App.el('span', { class: 'badge rec' }, 'Recommended'), o.fastest && App.el('span', { class: 'badge' }, 'Fastest')].filter(Boolean);
      box.appendChild(App.el('div', { class: 'opt-card' + (o.recommended ? ' recommended' : '') },
        App.el('div', { class: 'opt-head' },
          App.el('div', {}, App.el('b', {}, o.title), ' ', badges),
          App.el('button', { type: 'button', class: 'btn small' + (o.recommended ? ' primary' : ''), onclick: () => useOption(o) }, 'Use on slide')),
        App.el('div', { class: 'opt-time' }, `${hm(o.route.dep)} → ${hm(o.route.arr)} · ${Transit.fmtDur((o.route.arr - o.route.dep) / 1000)}`, optionNote(o) ? ` · ${optionNote(o)}` : ''),
        App.el('ul', { class: 'opt-legs' }, o.route.legs.map((l) => App.el('li', {}, legLine(l))))));
    });
    if (options.some((o) => o.id === 'combo')) {
      box.appendChild(App.el('p', { class: 'hint' }, `Train + car is recommended only when it saves at least ${MIN_SAVING_MIN} minutes. The ${state.pickup} min to get a car (taxi wait) is included.`));
    }
  }

  function legRow(l, i, legs) {
    return {
      mode: l.mode,
      from: l.from || (i === 0 ? state.origin : ''),
      to: l.to || (i === legs.length - 1 ? state.destination : ''),
      detail: l.kind === 'ride' ? l.line : l.kind === 'car' && l.wait ? `after ${l.wait} min to get a car` : '',
      duration: Transit.fmtDur((l.arr - l.dep) / 1000),
      distance: l.meters ? fmtDist(l.meters) : '',
    };
  }

  async function useOption(o) {
    const r = o.route;
    state.legs = r.legs.map(legRow);
    state.comparison = options.map((x) => ({ mode: x.title + (x.recommended ? ' ★' : ''), duration: Transit.fmtDur((x.route.arr - x.route.dep) / 1000), distance: optionNote(x) }));
    state.subtitle = `${o.title} · ${hm(r.dep)} → ${hm(r.arr)} · ${Transit.fmtDur((r.arr - r.dep) / 1000)}`;
    $('subtitle').value = state.subtitle;
    renderTables();
    refresh();
    try {
      state.map = await mapPicture(r);
      refresh();
      setStatus(`"${o.title}" is on the slide. Edit anything below before downloading.`);
    } catch (err) {
      setStatus(`"${o.title}" is on the slide, but the map picture could not be made (${err.message}). ${Transit.keys().geoapify ? '' : 'Add a free Geoapify key on the Trip Schedule page (API keys), or '}upload a screenshot instead.`, true);
    }
  }

  // Map picture: Geoapify when a key is set (free), otherwise Google Maps Static.
  // Train lines in red, walks in grey, car in blue; A = start, B = end, C = where the car starts.
  async function mapPicture(route) {
    if (!Transit.keys().geoapify) return loadImage(googleMapUrl(route));
    const res = await fetch(`https://maps.geoapify.com/v1/staticmap?apiKey=${encodeURIComponent(Transit.keys().geoapify)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geoapifyRequest(route)),
    });
    if (!res.ok) {
      const msg = await res.json().then((j) => j.message || j.error).catch(() => '');
      throw new Error(`Geoapify: ${msg || res.status}`);
    }
    return loadImage(await res.blob());
  }

  function geoapifyRequest(route) {
    const pt = (c) => ({ lat: c.lat, lon: c.lng });
    const geometries = [], all = [];
    route.legs.forEach((l) => {
      const seq = [l.fromCoord, ...(l.kind === 'car' ? [] : l.stops.map((s) => s.coord)), l.toCoord].filter(Boolean);
      all.push(...seq);
      if (l.kind === 'car') {
        const road = l.path && l.path.length > 1 ? l.path : seq;
        geometries.push(l.polyline
          ? { type: 'polyline5', value: l.polyline, linecolor: '#2E86DE', linewidth: 5 }
          : { type: 'polyline', value: road.map(pt), linecolor: '#2E86DE', linewidth: 5 });
      } else if (seq.length > 1) {
        geometries.push(l.kind === 'walk'
          ? { type: 'polyline', value: seq.map(pt), linecolor: '#6B7280', linewidth: 3, linestyle: 'dashed' }
          : { type: 'polyline', value: seq.map(pt), linecolor: '#C0392B', linewidth: 5 });
      }
    });
    const marker = (c, text, color) => ({ ...pt(c), text, color, type: 'material', size: 'large' });
    const first = route.legs[0].fromCoord, last = route.legs[route.legs.length - 1].toCoord;
    const carLeg = route.legs.find((l) => l.kind === 'car');
    const markers = [
      first && marker(first, 'A', '#27AE60'),
      last && marker(last, 'B', '#C0392B'),
      carLeg && carLeg !== route.legs[0] && carLeg.fromCoord && marker(carLeg.fromCoord, 'C', '#2E86DE'),
    ].filter(Boolean);
    // View: the whole route plus a margin; extra at the top because marker pins
    // are drawn above their point.
    const lats = all.map((c) => c.lat), lngs = all.map((c) => c.lng);
    const latSpan = Math.max(...lats) - Math.min(...lats), lngSpan = Math.max(...lngs) - Math.min(...lngs);
    const padLat = latSpan * 0.12 + 0.005, padTop = padLat + latSpan * 0.1 + 0.005, padLng = lngSpan * 0.12 + 0.005;
    return {
      style: 'osm-bright', lang: 'en', width: 620, height: 580, scaleFactor: 2, format: 'png',
      area: { type: 'rect', value: { lat1: Math.min(...lats) - padLat, lon1: Math.min(...lngs) - padLng, lat2: Math.max(...lats) + padTop, lon2: Math.max(...lngs) + padLng } },
      markers, geometries,
    };
  }

  function googleMapUrl(route) {
    const pt = (c) => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
    const q = ['size=620x560', 'scale=2', 'maptype=roadmap'];
    route.legs.forEach((l) => {
      if (l.kind === 'car') {
        if (l.polyline) q.push('path=' + encodeURIComponent(`color:0x2E86DEff|weight:5|enc:${l.polyline}`));
        return;
      }
      const seq = [l.fromCoord, ...l.stops.map((s) => s.coord), l.toCoord].filter(Boolean);
      if (seq.length > 1) q.push('path=' + encodeURIComponent(`${l.kind === 'walk' ? 'color:0x6B7280ff|weight:3' : 'color:0xC0392Bff|weight:5'}|${seq.map(pt).join('|')}`));
    });
    const first = route.legs[0].fromCoord, last = route.legs[route.legs.length - 1].toCoord;
    if (first) q.push('markers=' + encodeURIComponent(`color:green|label:A|${pt(first)}`));
    if (last) q.push('markers=' + encodeURIComponent(`color:red|label:B|${pt(last)}`));
    const carLeg = route.legs.find((l) => l.kind === 'car');
    if (carLeg && carLeg !== route.legs[0] && carLeg.fromCoord) q.push('markers=' + encodeURIComponent(`color:blue|label:C|${pt(carLeg.fromCoord)}`));
    q.push('key=' + encodeURIComponent(Transit.keys().google));
    return 'https://maps.googleapis.com/maps/api/staticmap?' + q.join('&');
  }

  // Reads an image (URL or File) into { data: dataURL, w, h } so it can be embedded in the .pptx.
  async function loadImage(src) {
    const res = src instanceof Blob ? null : await fetch(src);
    if (res && !res.ok) throw new Error('Map image request failed');
    const blob = src instanceof Blob ? src : await res.blob();
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
      els.push({ type: 'text', ...mapBox, text: 'Map\nPick an option or upload an image', align: 'center', valign: 'middle', fontSize: 14, color: T.muted });
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
      els.push({ type: 'text', x: rx, y, w: rw, h: 0.5, text: 'Compare routes and pick an option, or add legs on the left.', fontSize: 12, italic: true, color: T.muted, margin: 0 });
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
      els.push({ type: 'text', x: rx, y: cy, w: rw, h: 0.4, text: 'Options compared', fontSize: 16, bold: true, color: T.primary, margin: 0 });
      els.push({
        type: 'table', x: rx, y: cy + 0.45, w: rw, colW: [rw * 0.5, rw * 0.22, rw * 0.28], rowH: cmpRowH, fontSize: 11, header: true, zebra: true,
        rows: [['Option', 'Time', 'Notes'], ...cmp.map((c) => [c.mode, c.duration, c.distance])],
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
    const p = new URLSearchParams({ api: '1', origin: state.origin, destination: state.destination, travelmode: 'transit' });
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
      { key: 'mode', placeholder: 'e.g. Train all the way' },
      { key: 'duration' },
      { key: 'distance' },
    ]);
  }

  const FIELDS_IN_FORM = ['origin', 'destination', 'via', 'date', 'time', 'timeMode', 'tz', 'pickup', 'units', 'title', 'subtitle'];

  function init() {
    try { $('tzList').append(...Intl.supportedValuesOf('timeZone').map((z) => App.el('option', { value: z }))); } catch { /* older browsers */ }
    FIELDS_IN_FORM.forEach((id) => {
      $(id).value = state[id] ?? '';
      $(id).addEventListener('input', () => { state[id] = id === 'pickup' ? Number($(id).value) || 0 : $(id).value; refresh(); });
    });
    $('keyNote').hidden = !!(Transit.keys().geoapify || Transit.keys().google);

    $('compare').addEventListener('click', compareRoutes);
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
