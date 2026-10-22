/*
 * Train and car look-ups shared by the Trip Schedule and the Route Planner.
 * Google Routes API first (worldwide); NAVITIME via RapidAPI for trains where
 * Google has none (Japan). Both keys are entered on the Trip Schedule page.
 *
 * Train routes come back in one shape whichever service answered:
 *   { source, tz, dep: Date, arr: Date, fare, legs: [Leg] }
 *   Leg: { kind: 'walk' | 'ride' | 'car', mode, line, from, to, fromCoord, toCoord,
 *          dep: Date, arr: Date, meters, stops: [{ name, coord, arr: Date }] }
 *   (stops = stations the train calls at between from and to; coords are { lat, lng })
 */
const Transit = (function () {
  const GOOGLE_KEY = 'gmaps.apiKey';
  const NAVITIME_KEY = 'navitime.rapidKey';
  const NAVITIME_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
  const JAPAN_TZ = 'Asia/Tokyo';

  const GEOAPIFY_KEY = 'geoapify.apiKey';
  const keys = () => ({ google: App.store.get(GOOGLE_KEY, ''), navitime: App.store.get(NAVITIME_KEY, ''), geoapify: App.store.get(GEOAPIFY_KEY, '') });
  const secs = (d) => parseInt(String(d || '0').replace('s', ''), 10) || 0;
  function fmtDur(s) {
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  }

  // ---------- Time zones ----------
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function validTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return !!tz; } catch { return false; }
  }
  // UTC instant -> { date, time } as shown on a clock in tz.
  function utcToZoned(d, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: validTz(tz) ? tz : browserTz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  // Clock time in tz -> UTC instant.
  function zonedToUtc(date, time, tz) {
    const guess = new Date(`${date}T${time}:00Z`);
    const z = utcToZoned(guess, tz);
    return new Date(guess.getTime() - (Date.parse(`${z.date}T${z.time}:00Z`) - guess.getTime()));
  }

  // ---------- Google Routes ----------
  async function computeRoutes(body, fieldMask) {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': keys().google, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Google Maps: ' + ((json.error && json.error.message) || res.statusText));
    return json;
  }

  const waypoint = (p) => (typeof p === 'string' ? { address: p } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const latLng = (l) => (l && l.latLng ? { lat: l.latLng.latitude, lng: l.latLng.longitude } : null);

  // ---------- Saved results (places and typical drive times rarely change) ----------
  // Kept in this browser so repeating or tweaking a search costs no requests.
  const CACHE_KEY = 'transit.cache.v1';
  const DAY_MS = 24 * 3600e3;
  const cache = App.store.get(CACHE_KEY, {});
  async function remembered(key, maxAgeMs, fetcher) {
    const hit = cache[key];
    if (hit && Date.now() - hit.t < maxAgeMs) return hit.v;
    const v = await fetcher();
    if (v != null) {
      cache[key] = { t: Date.now(), v };
      const keysByAge = Object.keys(cache).sort((a, b) => cache[a].t - cache[b].t);
      keysByAge.slice(0, Math.max(0, keysByAge.length - 200)).forEach((k) => delete cache[k]);
      App.store.set(CACHE_KEY, cache);
    }
    return v;
  }
  const placeKey = (p) => (typeof p === 'string' ? p.trim().toLowerCase() : `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`);

  // Drive between two places (address strings or { lat, lng }) -> { secs, meters, start,
  // goal, path | polyline }, or null when there is no road route. Uses Geoapify (free,
  // adjusted for traffic) when there's a key, otherwise Google (traffic-aware).
  // Typical drives (no departure time) are remembered for a week.
  async function drive(origin, destination, departAt) {
    if (keys().geoapify) return remembered(`gdrive:${placeKey(origin)}>${placeKey(destination)}`, 7 * DAY_MS, () => geoapifyDrive(origin, destination));
    const fetcher = async () => {
      const body = { origin: waypoint(origin), destination: waypoint(destination), travelMode: 'DRIVE' };
      if (departAt && departAt > new Date()) { body.departureTime = departAt.toISOString(); body.routingPreference = 'TRAFFIC_AWARE'; }
      const json = await computeRoutes(body, 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation');
      const r = json.routes && json.routes[0];
      if (!r) return null;
      return {
        secs: secs(r.duration), meters: r.distanceMeters || 0, polyline: r.polyline && r.polyline.encodedPolyline,
        start: latLng(r.legs[0].startLocation), goal: latLng(r.legs[0].endLocation),
      };
    };
    if (departAt) return fetcher();
    return remembered(`drive:${placeKey(origin)}>${placeKey(destination)}`, 7 * DAY_MS, fetcher);
  }

  // ---------- Geoapify (free): places and quick drive estimates ----------
  async function geoapify(path, options) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://api.geoapify.com${path}${sep}apiKey=${encodeURIComponent(keys().geoapify)}`, options);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Geoapify: ' + (json.message || json.error || res.statusText));
    return json;
  }

  // Place name -> { lat, lng, country } (country = 'jp' etc.), or null. Needs a Geoapify key.
  async function geocode(text) {
    if (!keys().geoapify || !text) return null;
    return remembered(`place:${placeKey(text)}`, 90 * DAY_MS, async () => {
      const json = await geoapify(`/v1/geocode/search?text=${encodeURIComponent(text)}&lang=en&limit=1&format=json`);
      const r = json.results && json.results[0];
      return r ? { lat: r.lat, lng: r.lon, country: r.country_code } : null;
    });
  }

  // Geoapify's drive times assume empty roads. Compared with Google's traffic-aware
  // times around Tokyo/Saitama, short local drives took about 2.2x as long and a 70 km
  // mostly-expressway drive about 1.2x, so times are scaled by distance:
  //   3 km x2.2, 10 km x1.7, 20 km x1.4, 50 km+ x1.2.
  const withTraffic = (secs, meters) => Math.round((secs * (1.2 + 1.4 * Math.exp(-meters / 10000))) / 60) * 60; // whole minutes

  async function geoapifyDrive(origin, destination) {
    const [a, b] = await Promise.all([typeof origin === 'string' ? geocode(origin) : origin, typeof destination === 'string' ? geocode(destination) : destination]);
    if (!a || !b) return null;
    const json = await geoapify(`/v1/routing?waypoints=${a.lat},${a.lng}|${b.lat},${b.lng}&mode=drive&format=json`);
    const r = json.results && json.results[0];
    if (!r) return null;
    // Keep the road shape for the map, thinned to at most ~80 points.
    const pts = (r.geometry || []).flat();
    const step = Math.max(1, Math.ceil(pts.length / 80));
    const path = pts.filter((p, i) => i % step === 0 || i === pts.length - 1).map((p) => ({ lat: +p.lat.toFixed(5), lng: +p.lon.toFixed(5) }));
    return { secs: withTraffic(r.time, r.distance), meters: Math.round(r.distance), path, start: { lat: a.lat, lng: a.lng }, goal: { lat: b.lat, lng: b.lng } };
  }

  // Drive times (traffic-adjusted) from many places to one, in a single request.
  async function quickDriveTimes(origins, goal) {
    const json = await geoapify('/v1/routematrix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'drive', sources: origins.map((o) => ({ location: [o.lng, o.lat] })), targets: [{ location: [goal.lng, goal.lat] }] }),
    });
    return (json.sources_to_targets || []).map((row) => (row && row[0] && row[0].time != null ? { secs: withTraffic(row[0].time, row[0].distance), meters: row[0].distance } : null));
  }

  const VEHICLE = {
    BUS: 'Bus', INTERCITY_BUS: 'Bus', TROLLEYBUS: 'Bus',
    SUBWAY: 'Subway', METRO_RAIL: 'Subway',
    TRAM: 'Tram', LIGHT_RAIL: 'Tram', CABLE_CAR: 'Tram', FUNICULAR: 'Tram', GONDOLA_LIFT: 'Tram',
    FERRY: 'Ferry', SHARE_TAXI: 'Taxi',
  };

  // Google transit route -> common shape (consecutive walking steps merged).
  function fromGoogle(route, tz) {
    const legs = [];
    let zone = tz;
    (route.legs || []).flatMap((l) => l.steps || []).forEach((s) => {
      const t = s.transitDetails;
      if (s.travelMode === 'TRANSIT' && t) {
        const line = t.transitLine || {}, sd = t.stopDetails || {};
        const lv = t.localizedValues && t.localizedValues.departureTime;
        if (lv && lv.timeZone) zone = lv.timeZone;
        legs.push({
          kind: 'ride', mode: VEHICLE[line.vehicle && line.vehicle.type] || 'Train', line: line.nameShort || line.name || 'Train',
          from: (sd.departureStop && sd.departureStop.name) || '', to: (sd.arrivalStop && sd.arrivalStop.name) || '',
          fromCoord: latLng(sd.departureStop && sd.departureStop.location) || latLng(s.startLocation),
          toCoord: latLng(sd.arrivalStop && sd.arrivalStop.location) || latLng(s.endLocation),
          dep: new Date(sd.departureTime), arr: new Date(sd.arrivalTime), meters: s.distanceMeters || 0,
          stops: [], headsign: t.headsign, stopCount: t.stopCount,
        });
      } else {
        const last = legs[legs.length - 1];
        if (last && last.kind === 'walk') { last.secs += secs(s.staticDuration); last.meters += s.distanceMeters || 0; last.toCoord = latLng(s.endLocation); }
        else legs.push({ kind: 'walk', mode: 'Walk', line: '', secs: secs(s.staticDuration), meters: s.distanceMeters || 0, fromCoord: latLng(s.startLocation), toCoord: latLng(s.endLocation), stops: [] });
      }
    });
    if (!legs.some((l) => l.kind === 'ride')) return null;
    // Walks take their times from the rides around them.
    legs.forEach((l, i) => {
      if (l.kind !== 'walk') return;
      if (i === 0) { l.arr = legs[1].dep; l.dep = new Date(l.arr.getTime() - l.secs * 1000); }
      else { l.dep = legs[i - 1].arr; l.arr = new Date(l.dep.getTime() + l.secs * 1000); }
      l.from = i === 0 ? '' : legs[i - 1].to;
      l.to = i === legs.length - 1 ? '' : legs[i + 1].from;
    });
    return { source: 'Google', tz: zone, dep: legs[0].dep, arr: legs[legs.length - 1].arr, fare: '', legs };
  }

  // ---------- NAVITIME (Japan) ----------
  async function navitimeRoutes(start, goal, date, time, mode, via) {
    const p = new URLSearchParams({
      start: `${start.lat},${start.lng}`, goal: `${goal.lat},${goal.lng}`,
      [mode === 'arrive' ? 'goal_time' : 'start_time']: `${date}T${time}:00`, limit: '5', options: 'railway_calling_at',
    });
    if (via) p.set('via', JSON.stringify([{ lat: via.coord.lat, lon: via.coord.lng }]));
    // The same search within 6 hours reuses the saved answer (NAVITIME's free plan is 500 a month).
    let left = null;
    const json = await remembered(`navitime:${p}`, 6 * 3600e3, async () => {
      const res = await fetch(`https://${NAVITIME_HOST}/route_transit?${p}`, {
        headers: { 'X-RapidAPI-Key': keys().navitime, 'X-RapidAPI-Host': NAVITIME_HOST },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('NAVITIME: ' + (body.message || res.statusText));
      left = res.headers.get('x-ratelimit-requests-remaining');
      return body;
    });
    return { routes: (json.items || []).map(fromNavitime).filter(Boolean), left };
  }

  function fromNavitime(item) {
    const sections = item.sections || [];
    const coord = (pt) => (pt && pt.coord ? { lat: pt.coord.lat, lng: pt.coord.lon } : null);
    const name = (pt) => (!pt || pt.name === 'start' || pt.name === 'goal' ? '' : JpNames.toEnglish(pt.name));
    const mins = (s) => (Date.parse(s.to_time) - Date.parse(s.from_time)) / 60000;

    // A via point given as coordinates makes NAVITIME walk out to that exact spot and
    // back. When the spot is a station (short walks either side), drop those walks.
    const v = sections.findIndex((s) => s.type === 'point' && s.with_via);
    const skip = new Set();
    let viaArr = item.summary.via && item.summary.via.from_time ? new Date(item.summary.via.from_time) : null;
    if (v > 0) {
      const before = sections[v - 1], after = sections[v + 1];
      if (before && after && before.move === 'walk' && after.move === 'walk' && mins(before) <= 10 && mins(after) <= 10) {
        skip.add(v - 1).add(v + 1);
        const arriving = sections[v - 3];
        if (arriving && arriving.type === 'move') viaArr = new Date(arriving.to_time);
      }
    }

    const legs = [];
    sections.forEach((s, i) => {
      if (s.type !== 'move' || skip.has(i)) return;
      const walk = s.move === 'walk';
      const bus = /bus/.test(s.move || '');
      const calling = ((s.transport && s.transport.calling_at) || []).filter((c) => c.to_time || c.from_time);
      legs.push({
        kind: walk ? 'walk' : 'ride', mode: walk ? 'Walk' : bus ? 'Bus' : s.move === 'ferry' ? 'Ferry' : 'Train',
        line: walk ? '' : JpNames.toEnglish((s.transport && s.transport.self_name) || s.line_name),
        from: name(sections[i - 1]), to: name(sections[i + 1]),
        fromCoord: coord(sections[i - 1]), toCoord: coord(sections[i + 1]),
        dep: new Date(s.from_time), arr: new Date(s.to_time), meters: s.distance || 0,
        stops: calling.map((c) => ({ name: JpNames.toEnglish(c.name), coord: coord(c), arr: new Date(c.to_time || c.from_time) })),
      });
    });
    if (!legs.length) return null;
    const m = item.summary.move;
    const fare = m.fare && m.fare.unit_0 ? `¥${Math.round(m.fare.unit_0).toLocaleString()}` : '';
    return { source: 'NAVITIME', tz: JAPAN_TZ, dep: new Date(m.from_time), arr: new Date(m.to_time), fare, legs, viaArr };
  }

  // ---------- Train search ----------
  // Returns { routes, source, left, car, reason }. reason explains an empty result:
  // 'walk' | 'place' | 'no-data' | 'none'. car (when looked up) is the drive between the two places.
  // Google transit search -> { routes, found } (found = Google returned anything, even walking only).
  async function googleTransit(from, to, mode, when, tz) {
    const json = await computeRoutes({
      origin: waypoint(from), destination: waypoint(to), travelMode: 'TRANSIT', computeAlternativeRoutes: true, languageCode: 'en',
      [mode === 'arrive' ? 'arrivalTime' : 'departureTime']: when.toISOString(),
    }, 'routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation,routes.legs.steps.endLocation,routes.legs.steps.transitDetails');
    return { routes: (json.routes || []).map((r) => fromGoogle(r, tz)).filter(Boolean), found: !!(json.routes || []).length };
  }

  // Google can't route trains through a chosen stop, so search the two halves and join them.
  async function googleViaRoutes(from, to, via, mode, when, tz) {
    const CHANGE_MS = 5 * 60000;
    const earliest = (rs) => rs.reduce((a, b) => (b.arr < a.arr ? b : a), rs[0]);
    const latest = (rs) => rs.reduce((a, b) => (b.dep > a.dep ? b : a), rs[0]);
    let first, second;
    if (mode === 'arrive') {
      second = latest((await googleTransit(via.name, to, 'arrive', when, tz)).routes);
      if (second) first = latest((await googleTransit(from, via.name, 'arrive', new Date(second.dep - CHANGE_MS), tz)).routes);
    } else {
      first = earliest((await googleTransit(from, via.name, 'leave', when, tz)).routes);
      if (first) second = earliest((await googleTransit(via.name, to, 'leave', new Date(first.arr.getTime() + CHANGE_MS), tz)).routes);
    }
    if (!first || !second) return [];
    return [{ ...first, arr: second.arr, legs: [...first.legs, ...second.legs], viaArr: first.arr }];
  }

  // Where the two places are: Geoapify (free) when there's a key, otherwise Google's
  // drive route between them (which then also gives the car option). Null if not found.
  async function places(from, to) {
    const [start, goal] = await Promise.all([geocode(from), geocode(to)]).catch(() => [null, null]);
    if (start && goal) return { start, goal };
    if (!keys().google) return null;
    const car = await drive(from, to).catch(() => null);
    return car ? { start: car.start, goal: car.goal, car } : null;
  }

  // Returns { routes, source, left, places, reason }. reason explains an empty result:
  // 'walk' | 'place' | 'no-data' | 'none'. places (when looked up) = { start, goal, car? }.
  // via (optional) = { name, coord }: a station the trains must pass through; routes then carry viaArr.
  async function trainRoutes({ from, to, date, time, mode, tz, via }, onStatus) {
    const k = keys();
    const viaNavitime = async (pl) => {
      if (onStatus) onStatus('Asking NAVITIME for trains…');
      const nav = await navitimeRoutes(pl.start, pl.goal, date, time, mode, via);
      return { routes: nav.routes, source: 'NAVITIME', left: nav.left, places: pl, reason: nav.routes.length ? '' : 'none' };
    };

    // Both places in Japan: Google has no trains there, so go straight to NAVITIME.
    let pl = null;
    if (k.geoapify && k.navitime) {
      pl = await places(from, to);
      if (pl && pl.start.country === 'jp' && pl.goal.country === 'jp') return viaNavitime(pl);
    }
    if (!k.google) throw new Error('Add your Google Maps API key on the Trip Schedule page (API keys) first.');

    const when = zonedToUtc(date, time, tz);
    const g = await googleTransit(from, to, mode, when, tz);
    if (g.routes.length) {
      if (!via) return { routes: g.routes, source: 'Google', places: pl };
      const joined = await googleViaRoutes(from, to, via, mode, when, tz);
      return { routes: joined, source: 'Google', places: pl, reason: joined.length ? '' : 'none' };
    }
    if (g.found) return { routes: [], reason: 'walk', places: pl };

    // No trains from Google at all: NAVITIME if there's a key.
    pl = pl || await places(from, to);
    if (!pl) return { routes: [], reason: 'place' };
    if (!k.navitime) return { routes: [], reason: 'no-data', places: pl };
    return viaNavitime(pl);
  }

  const REASONS = {
    walk: 'Google only found a walking route — no train is needed for this trip.',
    place: 'Google could not find one of these places. Try adding the city or country, e.g. "Kawagoe Station, Saitama".',
    'no-data': 'Google does not provide train timetables for this area through its API (Japan is not covered). Add a NAVITIME key on the Trip Schedule page (API keys) for Japanese trains.',
    none: 'No trains found for that time.',
  };
  const reasonText = (reason) => REASONS[reason] || 'No trains found.';

  // One-line description of a route's rides, e.g. for speaker notes.
  function summary(route) {
    const hm = (d) => utcToZoned(d, route.tz).time;
    const rides = route.legs.filter((l) => l.kind !== 'walk')
      .map((l) => (l.kind === 'car' ? `Car: ${l.from} ${hm(l.dep)} → ${l.to || 'destination'} ${hm(l.arr)}` : `${l.line}: ${l.from} ${hm(l.dep)} → ${l.to} ${hm(l.arr)}`));
    return rides.join('; ') + (route.fare ? ` · ${route.fare}` : '');
  }

  // Straight-line distance in km.
  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  return { keys, fmtDur, utcToZoned, zonedToUtc, drive, geocode, quickDriveTimes, trainRoutes, reasonText, summary, km, browserTz };
})();
