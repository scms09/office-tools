/*
 * Trip Schedule: days as columns, 06:00–24:00 as rows, events drawn as boxes on
 * top of a native PowerPoint table. Up to 7 days per slide; longer trips get
 * one slide per week.
 *
 * Event: { id, type: meeting|note|flight|train|car, date, start, endDate, end,
 *          title, subtitle, bullets, showTime, flightNo, route, from, to, label, details }
 * Times are local times at the destination ("HH:MM").
 */
(function () {
  const KEY = 'trip.draft.v1';
  const API_KEY = 'gmaps.apiKey';
  const C = { grid: 'BFBFBF', meeting: 'E7E8EA', travel: 'FFF2CC', line: '000000', arrow: '9BBB59', text: '000000' };
  const FIRST_HOUR = 6, LAST_HOUR = 24;
  const DAY_START = FIRST_HOUR * 60, DAY_END = LAST_HOUR * 60;
  // Slide geometry (inches)
  const G = { x0: 0.15, w: 13.03, timeW: 0.8, tableY: 0.62, headH: [0.26, 0.44], hourH: 0.262, footH: [0.36, 0.24, 0.34, 0.4] };
  const HOURS = LAST_HOUR - FIRST_HOUR;
  const GRID_TOP = G.tableY + G.headH[0] + G.headH[1];
  const GRID_BOTTOM = GRID_TOP + HOURS * G.hourH;
  const FOOT_BOTTOM = GRID_BOTTOM + G.footH.reduce((a, b) => a + b, 0);
  const yOf = (min) => GRID_TOP + (min / 60 - FIRST_HOUR) * G.hourH;

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const defaults = () => ({ name: '', start: '', end: '', tz: browserTz, buffer: 30, title: '', logo: null, events: [], days: {} });
  let state = { ...defaults(), ...App.store.get(KEY, {}) };
  let hits = []; // per slide: clickable boxes [{x, y, w, h, id}]

  const $ = (id) => document.getElementById(id);

  // ---------- Date & time helpers ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'];
  const pad = (n) => String(n).padStart(2, '0');
  const parseDate = (s) => new Date(s + 'T00:00:00Z');
  const addDays = (s, n) => { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const uid = () => Math.random().toString(36).slice(2, 10);

  function dayLabel(s) {
    const d = parseDate(s);
    return `${MONTHS[d.getUTCMonth()]} ${ordinal(d.getUTCDate())} / (${WEEKDAYS[d.getUTCDay()]})`;
  }
  function rangeLabel(days) {
    const a = parseDate(days[0]), b = parseDate(days[days.length - 1]);
    const left = `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}`;
    if (days.length === 1) return left;
    return a.getUTCMonth() === b.getUTCMonth() ? `${left} - ${b.getUTCDate()}` : `${left} - ${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}`;
  }
  function tripDays() {
    if (!state.start || !state.end || state.end < state.start) return [];
    const out = [];
    for (let d = state.start; d <= state.end && out.length < 62; d = addDays(d, 1)) out.push(d);
    return out;
  }
  const chunk = (arr, n) => arr.reduce((acc, x, i) => { if (i % n === 0) acc.push([]); acc[acc.length - 1].push(x); return acc; }, []);

  function validTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }
  const tz = () => (validTz(state.tz) ? state.tz : browserTz);

  // UTC instant -> { date, time } as shown on a clock at the destination.
  function utcToZoned(d) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  // Destination clock time -> UTC instant.
  function zonedToUtc(date, time) {
    const guess = new Date(`${date}T${time}:00Z`);
    const z = utcToZoned(guess);
    const asIfUtc = Date.parse(`${z.date}T${z.time}:00Z`);
    return new Date(guess.getTime() - (asIfUtc - guess.getTime()));
  }

  // ---------- Layout ----------
  const isTravel = (ev) => ev.type === 'flight' || ev.type === 'train' || ev.type === 'car';

  // Splits events into per-day segments (overnight flights continue next day)
  // and gives overlapping segments side-by-side lanes.
  function segmentsFor(days) {
    const segs = Object.fromEntries(days.map((d) => [d, []]));
    state.events.forEach((ev) => {
      if (!ev.date || !ev.start) return;
      const endDate = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
      const startMin = toMin(ev.start);
      const endMin = ev.end ? toMin(ev.end) : startMin;
      days.forEach((d) => {
        if (d < ev.date || d > endDate) return;
        let s = d === ev.date ? startMin : 0;
        let e = d === endDate ? endMin : DAY_END;
        if (ev.type === 'note') e = s + 45;
        if (d !== ev.date && e <= DAY_START) return; // continuation ends before 06:00
        s = clamp(s, DAY_START, DAY_END - 15);
        e = clamp(Math.max(e, s + (isTravel(ev) ? 15 : 30)), DAY_START, DAY_END);
        const first = d === ev.date;
        segs[d].push({ ev, s, e, first, vs: visualStart(ev, s, first), ve: visualEnd(ev, s, e, first) });
      });
    });
    Object.values(segs).forEach(assignLanes);
    return segs;
  }

  // Where a segment's drawing really ends (minutes). Short trips draw taller than
  // their duration (arrow + icon + label box), so overlap is judged on this.
  const inchToMin = (h) => (h / G.hourH) * 60;
  function visualEnd(ev, s, e, first) {
    if (ev.type === 'meeting') return Math.max(e, s + inchToMin(0.44));
    if (ev.type === 'note') return s + inchToMin(ev.showTime ? 0.48 : 0.32);
    const arrow = Math.max(((e - s) / 60) * G.hourH, 0.3);
    if (!first) return s + inchToMin(arrow);
    // Box at the start time (time may wrap to 2 lines in a narrow lane); icon above it.
    const lines = ev.type === 'flight' ? [ev.label, ev.flightNo, ev.route].filter(Boolean).length + 2 : ev.label ? 3 : 2;
    const bh = 0.1 + lines * 0.17;
    const below = s <= DAY_START ? 0.04 + ICON_H[ev.type] : 0;
    return Math.min(DAY_END, s + inchToMin(Math.max(arrow, bh + below)));
  }
  // Where a segment's drawing really starts: travel icons poke up above the start time.
  const visualStart = (ev, s, first) => (isTravel(ev) && first ? Math.max(DAY_START, s - inchToMin(ICON_H[ev.type] + 0.03)) : s);

  const ICON_H = { flight: 0.15, car: 0.17, train: 0.28 };
  const TRAVEL_LANE_W = 0.6;

  // Lane position inside a day column: travel-only lanes are a narrow fixed
  // strip, meeting lanes share the rest of the width.
  function laneBox(seg, x, dayW) {
    const flags = seg.travelOnly, n = flags.length, t = flags.filter(Boolean).length;
    const tw = t === n ? dayW / n : Math.min(TRAVEL_LANE_W, (dayW * 0.45) / t);
    const mw = t === n ? 0 : (dayW - t * tw) / (n - t);
    const width = (l) => (flags[l] ? tw : mw);
    let lx = x;
    for (let l = 0; l < seg.lane; l++) lx += width(l);
    return { lx, lw: width(seg.lane) };
  }

  function assignLanes(list) {
    list.forEach((x) => { x.ve = Math.max(x.ve ?? x.e, x.e); x.vs = Math.min(x.vs ?? x.s, x.s); });
    list.sort((a, b) => a.vs - b.vs || b.ve - a.ve);
    let cluster = [], clusterEnd = -1;
    const flush = () => {
      const n = Math.max(...cluster.map((x) => x.lane)) + 1;
      const isTravelLane = (l) => !cluster.some((x) => x.lane === l && !isTravel(x.ev));
      // Travel-only lanes go on the left, meeting lanes on the right.
      const order = [...Array(n).keys()].sort((a, b) => isTravelLane(b) - isTravelLane(a) || a - b);
      const travelOnly = order.map(isTravelLane);
      cluster.forEach((x) => { x.lane = order.indexOf(x.lane); x.travelOnly = travelOnly; });
      cluster = [];
    };
    list.forEach((seg) => {
      if (cluster.length && seg.vs >= clusterEnd) { flush(); clusterEnd = -1; }
      let lane = 0;
      while (cluster.some((c) => c.lane === lane && c.ve > seg.vs)) lane++;
      seg.lane = lane;
      cluster.push(seg);
      clusterEnd = Math.max(clusterEnd, seg.ve);
    });
    if (cluster.length) flush();
  }

  // Rough estimate of wrapped text height (inches) in a box of width w.
  function parasHeight(paras, w, k = 1) {
    const usableW = Math.max(0.2, w - 0.1) * 72;
    return paras.reduce((sum, p) => {
      const fs = p.fontSize * k;
      const avail = usableW - (p.bullet ? fs * 1.2 : 0);
      const lines = Math.max(1, Math.ceil((p.text.length * fs * (p.bold ? 0.53 : 0.49)) / avail));
      return sum + (lines * fs * 1.2) / 72;
    }, 0) + 0.08;
  }
  // Shrink all font sizes together until the estimated height fits.
  function fitParas(paras, w, h, minScale = 0.55) {
    let k = 1;
    while (k > minScale && parasHeight(paras, w, k) > h) k -= 0.05;
    return paras.map((p) => ({ ...p, fontSize: Math.round(p.fontSize * k * 2) / 2 }));
  }
  const timeRange = (ev) => `${ev.start} – ${ev.end || ev.start}`;

  function drawSegment(els, boxes, seg, x, dayW) {
    const ev = seg.ev;
    const { lx, lw } = laneBox(seg, x, dayW);
    const y1 = yOf(seg.s), y2 = yOf(seg.e);

    if (ev.type === 'meeting') {
      const b = { x: lx + 0.05, y: y1 + 0.02, w: lw - 0.1, h: Math.max(y2 - y1 - 0.04, 0.4) };
      let paras = [{ text: ev.title || 'Meeting', bold: true, fontSize: 14, align: 'center' }];
      const bullets = (ev.bullets || '').split('\n').map((t) => t.trim()).filter(Boolean);
      if (ev.subtitle) paras.push({ text: ev.subtitle, fontSize: 12, align: 'center' });
      // The gap before the bullets and the gap before the time are the same height.
      const gap = () => ({ text: ' ', fontSize: 6 });
      if (ev.subtitle && bullets.length) paras.push(gap());
      bullets.forEach((t) => paras.push({ text: t, fontSize: 11, bullet: true, align: 'left' }));
      paras.push(gap(), { text: timeRange(ev), bold: true, fontSize: 12, align: 'center' });
      paras = fitParas(paras, b.w, b.h);
      els.push({ type: 'rect', ...b, fill: C.meeting, line: C.line, lineWidth: 2, radius: 0.1 });
      els.push({ type: 'text', ...b, paras, valign: 'middle', margin: 3, color: C.text });
      boxes.push({ ...b, id: ev.id });
      return;
    }

    if (ev.type === 'note') {
      const paras0 = [{ text: ev.title || 'Note', bold: true, fontSize: 12, align: 'center' }];
      if (ev.showTime) paras0.push({ text: ev.start, bold: true, fontSize: 12, align: 'center' });
      const b = { x: lx + 0.1, y: y1, w: lw - 0.2, h: ev.showTime ? 0.46 : 0.3 };
      els.push({ type: 'rect', ...b, fill: C.meeting, line: C.line, lineWidth: 2, radius: 0.05 });
      els.push({ type: 'text', ...b, paras: fitParas(paras0, b.w, b.h), valign: 'middle', margin: 2, color: C.text });
      boxes.push({ ...b, id: ev.id });
      return;
    }

    // Travel: green arrow for the duration down the left edge, yellow label box
    // starting at the departure time, icon above the box.
    const ax = lx + 0.06;
    const ay1 = y1 + 0.03, ay2 = Math.max(y2, y1 + 0.3);
    els.push({ type: 'arrow', x: ax, y1: ay1, y2: ay2, color: C.arrow, width: 3 });
    const icon = SlideIcons.get(ev.type === 'flight' ? 'plane' : ev.type);
    const ih = ICON_H[ev.type];
    const addIcon = (iy) => {
      if (icon) els.push({ type: 'image', x: ax + 0.1, y: iy, w: (ih * icon.w) / icon.h, h: ih, data: icon.data, imgW: icon.w, imgH: icon.h });
    };
    boxes.push({ x: lx, y: ay1 - 0.1, w: 0.2, h: ay2 - ay1 + 0.1, id: ev.id });
    if (!seg.first) { addIcon(ay1 - 0.02); return; } // overnight continuation: icon at the top

    let paras = [];
    if (ev.type === 'flight') {
      if (ev.label) paras.push({ text: ev.label, bold: true, fontSize: 11, align: 'center' });
      if (ev.flightNo) paras.push({ text: ev.flightNo, bold: true, fontSize: 11, align: 'center' });
      if (ev.route) paras.push({ text: ev.route, fontSize: 10, align: 'center' });
      paras.push({ text: timeRange(ev), bold: true, fontSize: 11, align: 'center' });
    } else {
      paras.push({ text: timeRange(ev), bold: true, fontSize: 10, align: 'center' });
      if (ev.label) paras.push({ text: ev.label, bold: true, fontSize: 9, align: 'center' });
    }
    // Narrow lanes let the box grow taller (text wraps) rather than shrinking the text.
    const bw = Math.max(0.42, Math.min(lw - 0.15, 1.35));
    paras = fitParas(paras, bw, Math.max(ay2 - ay1, 0.75));
    const bh = Math.max(0.28, parasHeight(paras, bw));
    const by = Math.min(y1, GRID_BOTTOM - bh - 0.02);
    const b = { x: ax + 0.08, y: by, w: bw, h: bh };
    els.push({ type: 'rect', ...b, fill: C.travel, line: C.line, lineWidth: 2, radius: 0.05 });
    els.push({ type: 'text', ...b, paras, valign: 'middle', margin: 1, color: C.text });
    // Icon sits just above the box; only at 06:00 (no room above the grid) does it go underneath.
    const iy = by - ih - 0.03 >= GRID_TOP ? by - ih - 0.03 : by + bh + 0.04;
    addIcon(iy);
    boxes.push({ x: b.x, y: Math.min(by, iy), w: bw, h: bh + 0.03 + ih, id: ev.id });
  }

  function slideTitle(week) {
    if (state.title) return state.title;
    return `${state.name || 'Trip'} | Schedule | ${rangeLabel(week)}:`;
  }

  function buildWeek(week, segs) {
    const n = week.length, dayW = (G.w - G.timeW) / n;
    const colX = (i) => G.x0 + G.timeW + i * dayW;
    const info = (d) => state.days[d] || {};
    const cell = (text, extra = {}) => ({ text: text || '', align: 'center', color: C.text, ...extra });
    const rows = [
      [cell('Time', { rowspan: 2, fontSize: 12 }), cell('Date', { colspan: n, fontSize: 12 })],
      week.map((d) => cell(dayLabel(d), { fontSize: 11 })),
      ...Array.from({ length: HOURS }, (_, i) => [cell(String(FIRST_HOUR + i), { fontSize: 11 }), ...week.map(() => cell(''))]),
      [cell('Plant Location', { bold: true, fontSize: 9 }), ...week.map((d) => cell(info(d).plant, { fontSize: 8 }))],
      [cell('Stay', { bold: true, fontSize: 9 }), ...week.map((d) => cell(info(d).stay, { fontSize: 9 }))],
      [cell('Hotel', { bold: true, fontSize: 9 }), ...week.map((d) => cell(info(d).hotel, { fontSize: 7 }))],
      [cell('Address', { bold: true, fontSize: 9 }), ...week.map((d) => cell(info(d).address, { fontSize: 7 }))],
    ];
    const els = [
      { type: 'text', x: G.x0, y: 0.06, w: 10.8, h: 0.52, text: slideTitle(week), fontSize: 22, bold: true, color: C.text, valign: 'middle', margin: 0 },
      {
        type: 'table', x: G.x0, y: G.tableY, w: G.w, colW: [G.timeW, ...week.map(() => dayW)],
        rowH: [...G.headH, ...Array(HOURS).fill(G.hourH), ...G.footH], rows, borderColor: C.grid, fontSize: 10,
      },
    ];
    if (state.logo) els.push({ type: 'image', x: 11.2, y: 0.05, w: 1.98, h: 0.52, data: state.logo.data, imgW: state.logo.w, imgH: state.logo.h });

    const boxes = [];
    // Travel last, so arrows and time boxes are never hidden behind a meeting.
    week.forEach((d, i) => [...segs[d]].sort((a, b) => isTravel(a.ev) - isTravel(b.ev))
      .forEach((seg) => drawSegment(els, boxes, seg, colX(i), dayW)));

    const notes = state.events
      .filter((ev) => week.includes(ev.date) && ev.details)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .map((ev) => `${dayLabel(ev.date)} ${timeRange(ev)} ${eventName(ev)}: ${ev.details}`);
    return { slide: { elements: els, notes: notes.join('\n') }, boxes };
  }

  function buildSlides() {
    const days = tripDays();
    hits = [];
    if (!days.length) {
      return [{ elements: [{ type: 'text', x: 0.5, y: 3, w: 12.3, h: 1, text: 'Set the trip start and end dates to see the schedule.', align: 'center', valign: 'middle', fontSize: 20, color: '6B7280' }] }];
    }
    const segs = segmentsFor(days);
    return chunk(days, 7).map((week) => {
      const { slide, boxes } = buildWeek(week, segs);
      hits.push(boxes);
      return slide;
    });
  }

  // ---------- Preview clicks ----------
  function onPreviewClick(si, x, y) {
    const days = tripDays();
    if (!days.length) return;
    const hit = (hits[si] || []).slice().reverse().find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (hit) { openEvent(state.events.find((e) => e.id === hit.id)); return; }
    const week = chunk(days, 7)[si];
    const dayW = (G.w - G.timeW) / week.length;
    const di = Math.floor((x - G.x0 - G.timeW) / dayW);
    if (di < 0 || di >= week.length) return;
    if (y >= GRID_TOP && y < GRID_BOTTOM) {
      const h = FIRST_HOUR + Math.floor((y - GRID_TOP) / G.hourH);
      openEvent(null, { date: week[di], start: fromMin(h * 60), end: fromMin(Math.min(h + 1, 24) * 60) });
    } else if (y >= GRID_BOTTOM && y < FOOT_BOTTOM) {
      openDay(week[di]);
    }
  }

  // ---------- Event dialog ----------
  let editingId = null;
  const EV_FIELDS = {
    type: 'evType', title: 'evTitle', subtitle: 'evSubtitle', bullets: 'evBullets', flightNo: 'evFlightNo', route: 'evRoute',
    from: 'evFrom', to: 'evTo', label: 'evLabel', date: 'evDate', start: 'evStart', endDate: 'evEndDate', end: 'evEnd', details: 'evDetails',
  };
  const TYPE_NAMES = { meeting: 'Meeting', note: 'Note', flight: 'Flight', train: 'Train', car: 'Car' };

  function eventName(ev) {
    if (ev.type === 'flight') return [ev.label, ev.flightNo, ev.route].filter(Boolean).join(' · ') || 'Flight';
    if (ev.type === 'train' || ev.type === 'car') {
      return [ev.from && ev.to ? `${ev.from} → ${ev.to}` : '', ev.label].filter(Boolean).join(' · ') || TYPE_NAMES[ev.type];
    }
    return ev.title || TYPE_NAMES[ev.type];
  }

  function showTypeFields() {
    const t = $('evType').value;
    document.querySelectorAll('#evForm [data-types]').forEach((el) => { el.hidden = !el.dataset.types.split(' ').includes(t); });
  }

  function openEvent(ev, preset = {}) {
    editingId = ev ? ev.id : null;
    const data = ev || { type: 'meeting', ...preset, endDate: preset.date };
    Object.entries(EV_FIELDS).forEach(([k, id]) => { $(id).value = data[k] || ''; });
    if (!data.type) $('evType').value = 'meeting';
    $('evShowTime').checked = !!data.showTime;
    $('evHeading').textContent = ev ? `Edit ${TYPE_NAMES[ev.type].toLowerCase()}` : 'Add event';
    $('evDelete').hidden = !ev;
    $('evResults').innerHTML = '';
    setSearchStatus('');
    $('evSearchTime').value = data.end || data.start || '';
    showTypeFields();
    $('evDialog').showModal();
  }

  function saveEvent() {
    const ev = { id: editingId || uid(), showTime: $('evShowTime').checked };
    Object.entries(EV_FIELDS).forEach(([k, id]) => { ev[k] = $(id).value.trim(); });
    if (!ev.date || !ev.start) { App.toast('Please set a date and start time.', 'error'); return false; }
    if (ev.type === 'flight') {
      if (!ev.endDate || ev.endDate < ev.date) ev.endDate = ev.date;
      if (ev.end && ev.endDate === ev.date && ev.end < ev.start) ev.endDate = addDays(ev.date, 1); // overnight
    } else {
      ev.endDate = ev.date;
    }
    if (ev.type === 'note') ev.end = '';
    else if (!ev.end || (ev.endDate === ev.date && ev.end < ev.start)) ev.end = fromMin(Math.min(toMin(ev.start) + 60, DAY_END));
    const i = state.events.findIndex((e) => e.id === ev.id);
    if (i >= 0) state.events[i] = ev; else state.events.push(ev);
    const days = tripDays();
    if (days.length && (ev.date < days[0] || ev.date > days[days.length - 1])) App.toast('Saved, but this date is outside the trip dates so it is not on the slide.');
    refresh();
    return true;
  }

  // ---------- Google Routes: train / car options ----------
  function setSearchStatus(msg, isError) {
    const s = $('evSearchStatus');
    s.textContent = msg;
    s.classList.toggle('error', !!isError);
  }
  const secs = (d) => parseInt(String(d || '0').replace('s', ''), 10) || 0;
  function fmtDur(s) {
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  }

  function transitOption(route) {
    const steps = (route.legs || []).flatMap((l) => l.steps || []);
    const idx = steps.map((s, i) => (s.transitDetails ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const first = steps[idx[0]].transitDetails, last = steps[idx[idx.length - 1]].transitDetails;
    const walk = (list) => list.reduce((a, s) => a + secs(s.staticDuration), 0);
    const dep = new Date(Date.parse(first.stopDetails.departureTime) - walk(steps.slice(0, idx[0])) * 1000);
    const arr = new Date(Date.parse(last.stopDetails.arrivalTime) + walk(steps.slice(idx[idx.length - 1] + 1)) * 1000);
    const summary = idx.map((i) => {
      const t = steps[i].transitDetails, line = t.transitLine || {}, sd = t.stopDetails || {};
      const name = line.nameShort || line.name || 'Train';
      return `${name}: ${sd.departureStop && sd.departureStop.name} ${utcToZoned(new Date(sd.departureTime)).time} → ${sd.arrivalStop && sd.arrivalStop.name} ${utcToZoned(new Date(sd.arrivalTime)).time}`;
    }).join('; ');
    return { dep, arr, summary };
  }

  function driveOption(route, mode, when) {
    const dur = secs(route.duration);
    const dep = mode === 'arrive' ? new Date(when.getTime() - dur * 1000) : when;
    return { dep, arr: new Date(dep.getTime() + dur * 1000), summary: `Drive about ${fmtDur(dur)}` };
  }

  async function searchOptions() {
    const key = App.store.get(API_KEY, '');
    const type = $('evType').value, from = $('evFrom').value.trim(), to = $('evTo').value.trim();
    const date = $('evDate').value, time = $('evSearchTime').value, mode = $('evSearchMode').value;
    if (!key) { setSearchStatus('Add your Google Maps API key at the top of the page first.', true); return; }
    if (!from || !to || !date || !time) { setSearchStatus('Fill in From, To, Date and the time to search for.', true); return; }

    const when = zonedToUtc(date, time);
    const body = { origin: { address: from }, destination: { address: to }, travelMode: type === 'train' ? 'TRANSIT' : 'DRIVE', languageCode: 'en' };
    if (type === 'train') {
      body.computeAlternativeRoutes = true;
      body[mode === 'arrive' ? 'arrivalTime' : 'departureTime'] = when.toISOString();
    } else if (mode === 'leave' && when > new Date()) {
      body.departureTime = when.toISOString();
      body.routingPreference = 'TRAFFIC_AWARE';
    }
    setSearchStatus('Searching…');
    $('evResults').innerHTML = '';
    try {
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'routes.duration,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json.error && json.error.message) || res.statusText);
      const options = (json.routes || []).map((r) => (type === 'train' ? transitOption(r) : driveOption(r, mode, when))).filter(Boolean);
      if (!options.length) { setSearchStatus('No options found for that time.', true); return; }
      setSearchStatus(`${options.length} option${options.length > 1 ? 's' : ''}. Using one adds ${state.buffer} min buffer (half before, half after) and rounds to 15 min.`);
      options.forEach((o) => {
        const d = utcToZoned(o.dep), a = utcToZoned(o.arr);
        $('evResults').appendChild(App.el('div', { class: 'result' },
          App.el('div', {}, App.el('b', {}, `${d.time} → ${a.time}`), ` (${fmtDur((o.arr - o.dep) / 1000)})`, App.el('div', { class: 'muted' }, o.summary)),
          App.el('button', { type: 'button', class: 'btn small', onclick: () => applyOption(o) }, 'Use')));
      });
    } catch (err) {
      setSearchStatus('Google Maps: ' + err.message, true);
    }
  }

  function applyOption(o) {
    const half = (Number(state.buffer) || 0) / 2;
    const s = utcToZoned(new Date(o.dep.getTime() - half * 60000));
    const e = utcToZoned(new Date(o.arr.getTime() + half * 60000));
    $('evDate').value = s.date;
    $('evStart').value = fromMin(Math.floor(toMin(s.time) / 15) * 15);
    $('evEnd').value = e.date > s.date ? '24:00' : fromMin(Math.min(Math.ceil(toMin(e.time) / 15) * 15, DAY_END));
    $('evDetails').value = o.summary;
    setSearchStatus('Times filled in. Press Save to keep them.');
  }

  // ---------- Day dialog ----------
  let editingDay = null;
  const DAY_FIELDS = { plant: 'dayPlant', stay: 'dayStay', hotel: 'dayHotel', address: 'dayAddress' };
  function openDay(d) {
    editingDay = d;
    $('dayHeading').textContent = dayLabel(d);
    const info = state.days[d] || {};
    Object.entries(DAY_FIELDS).forEach(([k, id]) => { $(id).value = info[k] || ''; });
    $('dayDialog').showModal();
  }

  // ---------- Event list ----------
  function renderList() {
    const tbody = $('eventList');
    tbody.innerHTML = '';
    const sorted = [...state.events].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    if (!sorted.length) tbody.appendChild(App.el('tr', {}, App.el('td', { colspan: 6, class: 'muted' }, 'No events yet — click the schedule above to add one.')));
    sorted.forEach((ev) => {
      tbody.appendChild(App.el('tr', {},
        App.el('td', {}, ev.date ? dayLabel(ev.date) : ''),
        App.el('td', { class: 'time' }, ev.type === 'note' ? ev.start : `${ev.start} – ${ev.end}${ev.endDate && ev.endDate !== ev.date ? ' (+1)' : ''}`),
        App.el('td', {}, TYPE_NAMES[ev.type]),
        App.el('td', {}, eventName(ev)),
        App.el('td', { class: 'muted' }, ev.details || ''),
        App.el('td', { class: 'row-actions' },
          App.el('button', { class: 'btn small', onclick: () => openEvent(ev) }, 'Edit'),
          App.el('button', { class: 'btn icon', title: 'Delete', onclick: () => { state.events = state.events.filter((e) => e.id !== ev.id); refresh(); } }, '✕'))));
    });
  }

  // ---------- Page ----------
  const refresh = App.debounce(() => {
    App.store.set(KEY, state);
    SlideKit.renderPreview($('preview'), buildSlides(), { onClick: onPreviewClick });
    renderList();
    $('logoRemove').hidden = !state.logo;
  }, 100);

  const SETTINGS = { name: 'tripName', start: 'tripStart', end: 'tripEnd', tz: 'tripTz', buffer: 'tripBuffer', title: 'tripTitle' };
  const syncSettings = () => Object.entries(SETTINGS).forEach(([k, id]) => { $(id).value = state[k] ?? ''; });

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => resolve({ data: r.result, w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('Not a valid image'));
        img.src = r.result;
      };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function exampleTrip() {
    const ev = (o) => ({ id: uid(), endDate: o.date, ...o });
    const kawagoe = { stay: 'Saitama', hotel: 'Hotel Kawagoe Tobu (Universal Double room)', address: 'https://en.tobuhotel.co.jp/kawagoe2020/rooms/universal_double/' };
    const plant = 'https://maps.app.goo.gl/iayHxskDdvZR7Qy4A';
    return {
      ...defaults(), name: 'Mahindra Visit', start: '2026-09-19', end: '2026-09-25', tz: 'Asia/Tokyo', logo: state.logo,
      title: 'Mahindra Visit | Schedule | Sep 19 - 25:',
      days: {
        '2026-09-19': { stay: 'Transit' },
        '2026-09-20': { ...kawagoe },
        '2026-09-21': { ...kawagoe, plant },
        '2026-09-22': { ...kawagoe, plant },
        '2026-09-23': { plant, stay: 'Tochigi', hotel: 'Richmond Hotel Utsunomiya', address: 'https://richmondutsunomiyaekimae.com-hotel.info/' },
        '2026-09-25': { stay: 'Transit' },
      },
      events: [
        ev({ type: 'flight', date: '2026-09-19', start: '19:30', endDate: '2026-09-20', end: '07:50', flightNo: 'NH 830', route: 'BOM - NRT' }),
        ev({ type: 'note', date: '2026-09-20', start: '07:50', title: 'Arrival in Japan', showTime: true }),
        ev({ type: 'train', date: '2026-09-20', start: '10:00', end: '11:30' }),
        ev({ type: 'note', date: '2026-09-20', start: '12:45', title: 'Hotel Arrival' }),
        ev({ type: 'meeting', date: '2026-09-21', start: '10:00', end: '17:00', title: 'Pre-Meeting for Workshop at Yachiyo', bullets: 'MY Capability\nTailgate Capability\nJapan visit to MRV' }),
        ev({ type: 'meeting', date: '2026-09-22', start: '09:00', end: '17:00', title: 'MY Saitama R&D', bullets: 'Technical Presentation\nTailgate Workshop\nPilot Line Visit\nTesting Facility Visit' }),
        ev({ type: 'car', date: '2026-09-22', start: '17:30', end: '18:00' }),
        ev({ type: 'meeting', date: '2026-09-23', start: '09:00', end: '13:00', title: 'MY Saitama', subtitle: 'Design Workshop' }),
        ev({ type: 'car', date: '2026-09-23', start: '13:30', end: '15:30' }),
        ev({ type: 'meeting', date: '2026-09-23', start: '15:30', end: '18:00', title: 'MY Tochigi R&D', subtitle: 'Plant Visit' }),
        ev({ type: 'car', date: '2026-09-24', start: '06:00', end: '08:00', label: 'Narita Airport' }),
        ev({ type: 'train', date: '2026-09-24', start: '08:30', end: '10:30' }),
        ev({ type: 'meeting', date: '2026-09-24', start: '11:00', end: '17:00', title: 'Motherson Hamamatsu Plant Visits', subtitle: '(Atsumitec / Yutaka)' }),
        ev({ type: 'flight', date: '2026-09-24', start: '11:40', end: '17:50', label: 'Vishnu san travel', flightNo: 'NH 829', route: 'NRT - BOM' }),
        ev({ type: 'meeting', date: '2026-09-25', start: '09:00', end: '17:00', title: 'MY Saitama', subtitle: 'Summary Meeting' }),
      ],
    };
  }

  function init() {
    try { $('tzList').append(...Intl.supportedValuesOf('timeZone').map((z) => App.el('option', { value: z }))); } catch { /* older browsers */ }
    syncSettings();
    Object.entries(SETTINGS).forEach(([k, id]) => $(id).addEventListener('input', () => {
      state[k] = k === 'buffer' ? Number($(id).value) || 0 : $(id).value;
      if (k === 'start' && state.start && (!state.end || state.end < state.start)) { state.end = addDays(state.start, 6); $('tripEnd').value = state.end; }
      refresh();
    }));

    const key = $('apiKey');
    key.value = App.store.get(API_KEY, '');
    key.addEventListener('input', () => App.store.set(API_KEY, key.value.trim()));

    $('logoUpload').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) { try { state.logo = await readImage(f); refresh(); } catch (err) { App.toast(err.message, 'error'); } }
      e.target.value = '';
    });
    $('logoRemove').addEventListener('click', () => { state.logo = null; refresh(); });
    $('addEvent').addEventListener('click', () => openEvent(null, { date: state.start, start: '09:00', end: '10:00' }));
    $('loadExample').addEventListener('click', () => {
      if (state.events.length && !confirm('Replace the current schedule with the example?')) return;
      state = exampleTrip();
      syncSettings();
      refresh();
    });
    $('clearAll').addEventListener('click', () => {
      if (!confirm('Clear the whole schedule?')) return;
      state = { ...defaults(), logo: state.logo };
      syncSettings();
      refresh();
    });
    $('download').addEventListener('click', async () => {
      try { await SlideKit.exportPptx(buildSlides(), `${state.name || 'Trip'} Schedule`); }
      catch (err) { App.toast('Could not create the file: ' + err.message, 'error'); }
    });

    $('evType').addEventListener('change', showTypeFields);
    $('evForm').addEventListener('submit', (e) => { if (!saveEvent()) e.preventDefault(); });
    $('evCancel').addEventListener('click', () => $('evDialog').close());
    $('evDelete').addEventListener('click', () => {
      state.events = state.events.filter((e) => e.id !== editingId);
      $('evDialog').close();
      refresh();
    });
    $('evSearch').addEventListener('click', searchOptions);

    $('dayForm').addEventListener('submit', () => {
      state.days[editingDay] = Object.fromEntries(Object.entries(DAY_FIELDS).map(([k, id]) => [k, $(id).value.trim()]));
      refresh();
    });
    $('dayCancel').addEventListener('click', () => $('dayDialog').close());
    $('dayCopyPrev').addEventListener('click', () => {
      const prev = state.days[addDays(editingDay, -1)] || {};
      Object.entries(DAY_FIELDS).forEach(([k, id]) => { $(id).value = prev[k] || ''; });
    });

    refresh();
    SlideIcons.ready.then(refresh);
  }

  init();
})();
