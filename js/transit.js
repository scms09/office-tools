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

  // Drive between two places (address strings or { lat, lng }). Also tells us where
  // Google placed the two ends. Null when Google finds no road route.
  async function drive(origin, destination, departAt) {
    const body = { origin: waypoint(origin), destination: waypoint(destination), travelMode: 'DRIVE' };
    if (departAt && departAt > new Date()) { body.departureTime = departAt.toISOString(); body.routingPreference = 'TRAFFIC_AWARE'; }
    const json = await computeRoutes(body, 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation');
    const r = json.routes && json.routes[0];
    if (!r) return null;
    return {
      secs: secs(r.duration), meters: r.distanceMeters || 0, polyline: r.polyline && r.polyline.encodedPolyline,
      start: latLng(r.legs[0].startLocation), goal: latLng(r.legs[0].endLocation),
    };
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
    const res = await fetch(`https://${NAVITIME_HOST}/route_transit?${p}`, {
      headers: { 'X-RapidAPI-Key': keys().navitime, 'X-RapidAPI-Host': NAVITIME_HOST },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('NAVITIME: ' + (json.message || res.statusText));
    return { routes: (json.items || []).map(fromNavitime).filter(Boolean), left: res.headers.get('x-ratelimit-requests-remaining') };
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

  // Returns { routes, source, left, car, reason }. reason explains an empty result:
  // 'walk' | 'place' | 'no-data' | 'none'. car (when looked up) is the drive between the two places.
  // via (optional) = { name, coord }: a station the trains must pass through; routes then carry viaArr.
  async function trainRoutes({ from, to, date, time, mode, tz, via }, onStatus) {
    if (!keys().google) throw new Error('Add your Google Maps API key on the Trip Schedule page (API keys) first.');
    const when = zonedToUtc(date, time, tz);
    const g = await googleTransit(from, to, mode, when, tz);
    if (g.routes.length) {
      if (!via) return { routes: g.routes, source: 'Google' };
      const joined = await googleViaRoutes(from, to, via, mode, when, tz);
      return { routes: joined, source: 'Google', reason: joined.length ? '' : 'none' };
    }
    if (g.found) return { routes: [], reason: 'walk' };

    // No trains from Google at all (e.g. Japan): NAVITIME, using Google's idea of where the places are.
    const car = await drive(from, to).catch(() => null);
    if (!car) return { routes: [], reason: 'place' };
    if (!keys().navitime) return { routes: [], reason: 'no-data', car };
    if (onStatus) onStatus('Google has no trains here — asking NAVITIME…');
    const nav = await navitimeRoutes(car.start, car.goal, date, time, mode, via);
    return { routes: nav.routes, source: 'NAVITIME', left: nav.left, car, reason: nav.routes.length ? '' : 'none' };
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

  return { keys, fmtDur, utcToZoned, zonedToUtc, drive, trainRoutes, reasonText, summary, km, browserTz };
})();
