// RigRoute UI. Network data is only ever rendered with textContent / DOM nodes
// (never innerHTML), and only http(s) links are made clickable.

import { connect } from './api.js';
import { listenOnce, speak, voiceSupported } from './voice.js';
import { nightify, isLightStyle } from './night.js';
import { planRoute, isNoPath } from './core/planner.js';
import { parsePrompt } from './core/parser.js';
import { DEFAULT_PROFILE, sanitizeProfile, sanitizeOptions, describeOptions, removeChip } from './core/options.js';
import { fmtFeetIn, M_PER_MI } from './core/units.js';

const $ = (id) => document.getElementById(id);
const PROFILE_KEY = 'rigroute.profile.v1';
const SVGNS = 'http://www.w3.org/2000/svg';
const state = {
  api: null, config: null, map: null, mapReady: false, markers: [],
  profile: loadProfile(), options: {}, parsedFor: null, notes: [],
  stops: { from: null, to: null }, seeds: [], tips: [], plan: null, busy: false, spoke: false,
};

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null && k !== false) n.append(k);
  return n;
}
function icon(name, cls = 'ic') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
}
function link(text, href) {
  const h = safeUrl(href);
  return h ? el('a', { href: h, target: '_blank', rel: 'noopener noreferrer', text, onclick: (e) => e.stopPropagation() }) : el('span', { text });
}
const miles = (m) => (m / M_PER_MI < 10 ? (m / M_PER_MI).toFixed(1) : Math.round(m / M_PER_MI).toLocaleString('en-US'));
const kLbs = (lbs) => (lbs >= 10000 ? `${Math.round(lbs / 100) / 10}k` : lbs.toLocaleString('en-US'));
function hm(s) { const m = Math.round(s / 60); return m < 60 ? { h: null, m } : { h: Math.floor(m / 60), m: m % 60 }; }
const show = (id, on = true) => { $(id).hidden = !on; };
function setError(msg) { $('error').textContent = msg || ''; show('error', !!msg); }
function setProgress(msg) { if (msg) $('progress').textContent = msg; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const isPhone = () => !window.matchMedia('(min-width: 900px), (orientation: landscape) and (max-height: 560px)').matches;

function view(name) {
  for (const v of ['plan', 'busy', 'results']) show(v, v === name);
  $('sheetBody').scrollTop = 0;
}

// ---------- bottom sheet ----------
const SNAPS = ['peek', 'half', 'full'];
function snap(s) { $('sheet').dataset.snap = s; }
function wireSheet() {
  const sheet = $('sheet'), grab = $('grab');
  let startY = 0, startH = 0, moved = false, dragging = false;
  grab.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; startY = e.clientY; startH = sheet.getBoundingClientRect().height;
    grab.setPointerCapture(e.pointerId); sheet.classList.add('dragging');
  });
  grab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 6) moved = true;
    if (moved) sheet.style.height = `${Math.max(120, Math.min(window.innerHeight - 70, startH + dy))}px`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false; sheet.classList.remove('dragging');
    if (!moved) { snap(sheet.dataset.snap === 'peek' ? 'half' : sheet.dataset.snap === 'half' ? 'full' : 'half'); return; }
    const h = sheet.getBoundingClientRect().height, vh = window.innerHeight;
    sheet.style.height = '';
    snap(h < vh * 0.36 ? 'peek' : h < vh * 0.78 ? 'half' : 'full');
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  grab.addEventListener('keydown', (e) => {
    const i = SNAPS.indexOf(sheet.dataset.snap);
    if (e.key === 'ArrowUp') { snap(SNAPS[Math.min(2, i + 1)]); e.preventDefault(); }
    if (e.key === 'ArrowDown') { snap(SNAPS[Math.max(0, i - 1)]); e.preventDefault(); }
  });
  // Typing on a phone: give the form the whole screen so the keyboard doesn't bury it.
  for (const id of ['to', 'from', 'prompt']) $(id).addEventListener('focus', () => { if (isPhone()) snap('full'); });
}

// ---------- profile ----------
function loadProfile() {
  try { return sanitizeProfile(JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')); } catch { return { ...DEFAULT_PROFILE }; }
}
function saveProfile(p) {
  state.profile = sanitizeProfile(p);
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); } catch { /* private mode */ }
  renderProfileSummary();
}
function renderProfileSummary() {
  const p = state.profile;
  const box = $('profileSummary');
  box.replaceChildren(`${fmtFeetIn(p.heightIn)} · ${kLbs(p.weightLbs)} lbs`);
  if (p.hazmat) box.append(el('span', { class: 'hm', text: 'HM' }));
  $('profileBtn').setAttribute('aria-label', `Your rig: ${fmtFeetIn(p.heightIn)}, ${p.weightLbs} pounds${p.hazmat ? ', hazmat' : ''}. Edit`);
}
const PRESETS = [
  { label: "53' dry van", p: { heightIn: 162, lengthFt: 73, widthIn: 102, weightLbs: 80000, axles: 5, hazmat: false } },
  { label: "53' reefer", p: { heightIn: 162, lengthFt: 73, widthIn: 102, weightLbs: 80000, axles: 5, hazmat: false } },
  { label: 'Tanker, hazmat', p: { heightIn: 144, lengthFt: 70, widthIn: 102, weightLbs: 80000, axles: 5, hazmat: true } },
  { label: "Car hauler 14'", p: { heightIn: 168, lengthFt: 75, widthIn: 102, weightLbs: 80000, axles: 5, hazmat: false } },
  { label: '26 ft box truck', p: { heightIn: 150, lengthFt: 35, widthIn: 102, weightLbs: 26000, axles: 2, hazmat: false } },
];
function fillProfileForm(p) {
  const f = $('profileForm').elements;
  f.hFt.value = Math.floor(p.heightIn / 12);
  f.hIn.value = Math.round((p.heightIn % 12) * 10) / 10;
  f.weightLbs.value = p.weightLbs;
  f.lengthFt.value = p.lengthFt;
  f.widthIn.value = p.widthIn;
  f.axles.value = p.axles;
  f.clearanceMarginIn.value = p.clearanceMarginIn;
  f.hazmat.checked = !!p.hazmat;
}
function openProfile() { fillProfileForm(state.profile); $('profileDlg').showModal(); }
function onProfileClose() {
  if ($('profileDlg').returnValue !== 'save') return;
  const f = $('profileForm').elements;
  saveProfile({
    heightIn: Number(f.hFt.value) * 12 + Number(f.hIn.value || 0), weightLbs: Number(f.weightLbs.value), lengthFt: Number(f.lengthFt.value),
    widthIn: Number(f.widthIn.value), axles: Number(f.axles.value), clearanceMarginIn: Number(f.clearanceMarginIn.value), hazmat: f.hazmat.checked,
  });
}

// ---------- prompt ----------
function renderChips() {
  $('chips').replaceChildren(...describeOptions(state.options).map((chip) => el('span', { class: 'chip' }, chip.label,
    el('button', { type: 'button', 'aria-label': `Remove ${chip.label}`, onclick: () => { state.options = removeChip(state.options, chip); renderChips(); } }, icon('x')))));
  const note = state.notes.join(' ');
  $('promptNote').textContent = note;
  show('promptNote', !!note);
}

async function parseNow() {
  const text = $('prompt').value.trim();
  if (text === state.parsedFor) return;
  state.parsedFor = text;
  if (!text) { state.options = {}; state.notes = []; renderChips(); return; }
  let res;
  try { res = await state.api.parse(text); } catch { res = parsePrompt(text); }
  if ($('prompt').value.trim() !== text) return;
  state.options = sanitizeOptions(res.options);
  state.notes = Array.isArray(res.notes) ? res.notes.map(String).slice(0, 4) : [];
  renderChips();
}
const parseSoon = debounce(parseNow, 600);

function setMic(listening) {
  $('micBtn').classList.toggle('listening', listening);
  $('micBtn').setAttribute('aria-label', listening ? 'Stop listening' : 'Tap and say how to run it');
  $('micLabel').textContent = listening ? 'Listening… tap to stop' : 'Tap and say how to run it';
}
async function onMic() {
  if ($('micBtn').classList.contains('listening')) { listenOnce.stop?.(); return; }
  setError('');
  setMic(true);
  try {
    const text = await listenOnce({ onInterim: (t) => { $('prompt').value = t; } });
    if (text) {
      $('prompt').value = text;
      await parseNow();
      state.spoke = true;
      const labels = describeOptions(state.options).map((c) => c.label);
      speak(labels.length ? `Got it: ${labels.join(', ')}.` : 'I didn’t catch any route settings in that.');
    }
  } catch (e) { setError(e.message); }
  finally { setMic(false); }
}

// ---------- places ----------
function wireSuggest(inputId, listId, key) {
  const input = $(inputId), list = $(listId);
  const close = () => { list.hidden = true; list.replaceChildren(); };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3 || q === 'My location') return close();
    try {
      const res = await state.api.geocode(q, { suggest: true });
      if (input.value.trim() !== q || document.activeElement !== input) return;
      list.replaceChildren(...res.map((r) => el('li', { role: 'option', text: r.label, onpointerdown: (e) => {
        e.preventDefault();
        input.value = r.label; state.stops[key] = { lat: r.lat, lon: r.lon, label: r.label }; close();
      } })));
      list.hidden = !res.length;
    } catch { close(); }
  }, 350);
  input.addEventListener('input', () => { state.stops[key] = null; search(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location isn’t available here. Type a starting point.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'My location' }),
      () => reject(new Error('Couldn’t get your location. Type a starting point.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}
async function useMyLocation() {
  $('locBtn').disabled = true;
  try { state.stops.from = await locate(); $('from').value = 'My location'; setError(''); }
  catch (e) { setError(e.message); }
  finally { $('locBtn').disabled = false; }
}

async function resolveStop(key, inputId) {
  if (state.stops[key]) return state.stops[key];
  const q = $(inputId).value.trim();
  if (!q) {
    if (key === 'from') { state.stops.from = await locate(); $('from').value = 'My location'; return state.stops.from; }
    throw new Error('Where are you headed? Enter a destination.');
  }
  const res = await state.api.geocode(q);
  if (!res.length) throw new Error(`Couldn't find "${q}". Try a city and state.`);
  state.stops[key] = { lat: res[0].lat, lon: res[0].lon, label: res[0].label };
  $(inputId).value = res[0].label;
  return state.stops[key];
}

// ---------- map ----------
const KIND_ICON = { low_clearance: 'bridge', weight_limit: 'weight', no_trucks: 'notruck', hazmat: 'hazmat', grade: 'grade', steep_grade: 'grade',
  chain_law: 'snow', high_wind: 'wind', avoid_road: 'route', caution: 'warn' };
const POI_ICON = { parking: 'parking', truckstop: 'fuel', rest: 'bed', weigh: 'scale' };
const POI_LABEL = { parking: 'Truck parking', truckstop: 'Truck stop', rest: 'Rest area', weigh: 'Weigh station' };
const SEV_WORD = { danger: 'Must-know', caution: 'Heads-up', info: 'FYI' };
const poiTitle = (p) => (p.name ? `${p.name}` : POI_LABEL[p.kind]);

// ---------- day / night ----------
const MODE_KEY = 'rigroute.mode';
const MODE_THEME = { night: '#0a1820', day: '#6ccbeb' };
const currentMode = () => (document.documentElement.dataset.mode === 'day' ? 'day' : 'night');
const MAP_COLORS = {
  night: { route: '#f2862a', casing: '#0d2531', poi: '#6ccbeb', weigh: '#e8ec4a', poiStroke: '#0d2531' },
  day: { route: '#f2862a', casing: '#0d2531', poi: '#1683ab', weigh: '#e0505e', poiStroke: '#ffffff' },
};

function applyModeChrome(mode) {
  document.documentElement.dataset.mode = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', MODE_THEME[mode]);
  const btn = $('modeBtn');
  if (btn) btn.setAttribute('aria-label', mode === 'day' ? 'Switch to night mode' : 'Switch to day mode');
}

async function toggleMode() {
  const mode = currentMode() === 'day' ? 'night' : 'day';
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode: still switch for this visit */ }
  applyModeChrome(mode);
  if (state.map) {
    state.mapReady = false;
    state.map.setStyle(await styleFor(mode));
  }
}

const styleCache = {};
async function styleFor(mode) {
  const url = state.config.mapStyle;
  if (!styleCache.raw) {
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      styleCache.raw = await res.json();
    } catch { return url; }
  }
  const raw = styleCache.raw;
  if (mode === 'night') return isLightStyle(raw) ? nightify(structuredClone(raw)) : raw;
  return raw;
}

function addMapLayers(map) {
  const c = MAP_COLORS[currentMode()];
  const empty = { type: 'FeatureCollection', features: [] };
  if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: empty });
  if (!map.getSource('pois')) map.addSource('pois', { type: 'geojson', data: empty });
  const line = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: line, paint: { 'line-color': c.casing, 'line-width': 10 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: line, paint: { 'line-color': c.route, 'line-width': 6 } });
  map.addLayer({ id: 'pois', type: 'circle', source: 'pois', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 8], 'circle-color': ['match', ['get', 'kind'], 'weigh', c.weigh, c.poi], 'circle-stroke-width': 2, 'circle-stroke-color': c.poiStroke } });
}

async function initMap() {
  const ml = globalThis.maplibregl;
  if (!ml) { setError('The map didn’t load. Routing still works; refresh to try again.'); return; }
  ml.setWorkerUrl('vendor/maplibre-gl-csp-worker.js');
  const style = await styleFor(currentMode());
  const map = new ml.Map({ container: 'map', style, center: [-96, 38.5], zoom: 3.3, attributionControl: { compact: true }, pitchWithRotate: false, dragRotate: false });
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  // style.load fires on first load and after every setStyle (which drops our layers).
  map.on('style.load', () => {
    addMapLayers(map);
    state.mapReady = true;
    if (state.plan) drawPlan(state.plan, { fit: false });
  });
  map.on('click', 'pois', (e) => { const f = e.features && e.features[0]; if (f) popup(f.geometry.coordinates, f.properties.title, f.properties.detail); });
  map.on('mouseenter', 'pois', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'pois', () => { map.getCanvas().style.cursor = ''; });
  state.map = map;
}

function popup(lngLat, title, detail) {
  const ml = globalThis.maplibregl;
  if (!state.map || !ml) return;
  const node = el('div', {}, el('div', { class: 'popup-t', text: String(title || '') }), detail ? el('div', { class: 'popup-d', text: String(detail) }) : null);
  new ml.Popup({ closeButton: true, maxWidth: '300px', offset: 24 }).setLngLat(lngLat).setDOMContent(node).addTo(state.map);
}

function flyTo(lat, lon, title, detail) {
  if (lat == null || !state.map) return;
  if (isPhone()) snap('peek');
  state.map.flyTo({ center: [lon, lat], zoom: 15, padding: isPhone() ? { bottom: 180 } : { left: 460 } });
  popup([lon, lat], title, detail);
}

function marker(cls, iconName, label, lat, lon, onclick) {
  const ml = globalThis.maplibregl;
  const node = el('button', { type: 'button', class: `mk ${cls}`, 'aria-label': label, onclick }, iconName ? icon(iconName) : null);
  const m = new ml.Marker({ element: node }).setLngLat([lon, lat]).addTo(state.map);
  state.markers.push(m);
}

function fitPadding() {
  return isPhone() ? { top: 90, bottom: Math.round(window.innerHeight * 0.64), left: 40, right: 40 } : { top: 90, bottom: 40, left: 480, right: 60 };
}

function drawPlan(plan, { fit = true } = {}) {
  const map = state.map;
  if (!map || !state.mapReady) return;
  for (const m of state.markers) m.remove();
  state.markers = [];
  const coords = plan.trip.line.map(([la, lo]) => [lo, la]);
  map.getSource('route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  map.getSource('pois').setData({ type: 'FeatureCollection', features: plan.pois.map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { kind: p.kind, title: `${POI_LABEL[p.kind]}${p.name ? `: ${p.name}` : ''}`, detail: `Mile ${miles(p.alongM)} · ${miles(p.offRouteM)} mi off route` },
  })) });
  const [s, e] = [coords[0], coords[coords.length - 1]];
  marker('end', null, 'Start', s[1], s[0]);
  marker('end dest', null, 'Destination', e[1], e[0]);
  // Danger on top: add info, then caution, then danger.
  const order = { info: 0, caution: 1, danger: 2 };
  for (const a of plan.alerts.filter((x) => x.lat != null).sort((x, y) => order[x.severity] - order[y.severity])) {
    marker(a.severity, KIND_ICON[a.kind] || 'warn', a.title, a.lat, a.lon, () => flyTo(a.lat, a.lon, a.title, a.detail));
  }
  const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
  if (fit) map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: fitPadding(), duration: 700, maxZoom: 14 });
}

// ---------- results ----------
function osmUrl(id) {
  const m = /^osm:(node|way|relation)\/(\d+)$/.exec(String(id || ''));
  return m ? `https://www.openstreetmap.org/${m[1]}/${m[2]}` : null;
}
function shortPlace(label) { return String(label || '').split(',').slice(0, 2).join(',').trim(); }

function mileCell(alongM) { return el('div', { class: 'mi' }, el('b', { text: miles(alongM) }), el('span', { text: 'mile' })); }

function alertCard(a) {
  const src = el('div', { class: 'src' });
  if (Array.isArray(a.sources)) for (const s of a.sources.slice(0, 2)) src.append(link(s.title || 'Source', s.url));
  const o = osmUrl(a.id); if (o) src.append(link('Map data', o));
  const go = () => flyTo(a.lat, a.lon, a.title, a.detail);
  return el('li', { class: `card ${a.severity}`, tabindex: '0', role: 'button', onclick: go, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } },
    el('div', { class: 'tile' }, icon(KIND_ICON[a.kind] || 'warn')),
    el('div', {}, el('div', { class: 'sev', text: SEV_WORD[a.severity] }), el('div', { class: 't', text: a.title }), a.detail ? el('div', { class: 'd', text: a.detail }) : null, src.childNodes.length ? src : null),
    mileCell(a.alongM));
}

function renderResults(plan) {
  const { trip, counts, alerts, pois, notes, profile } = plan;
  const t = hm(trip.timeS);
  $('resDest').textContent = `To ${shortPlace(state.stops.to.label)}`;
  $('summary').replaceChildren(
    el('span', { class: 'big' }, miles(trip.lengthM), el('span', { class: 'unit', text: 'mi' })),
    el('span', { class: 'big' }, ...(t.h != null ? [String(t.h), el('span', { class: 'unit', text: 'h' }), ` ${t.m}`, el('span', { class: 'unit', text: 'min' })] : [String(t.m), el('span', { class: 'unit', text: 'min' })])),
  );

  const need = fmtFeetIn(profile.heightIn + (profile.clearanceMarginIn || 0));
  const v = $('verdict');
  if (counts.danger) {
    v.className = 'verdict danger';
    v.replaceChildren(icon('warn'), el('div', {}, `${counts.danger} must-know spot${counts.danger > 1 ? 's' : ''} on this route`,
      el('span', { class: 'sub', text: plan.reroutes ? `Rerouted ${plan.reroutes}× and still couldn't avoid ${counts.danger > 1 ? 'them' : 'it'}. Check before you roll.` : 'Check these before you roll.' })));
  } else {
    v.className = 'verdict ok';
    v.replaceChildren(icon('check'), el('div', {}, `Clear for your ${fmtFeetIn(profile.heightIn)} rig`,
      el('span', { class: 'sub', text: `No bridges under ${need}, weight limits or truck bans found${plan.reroutes ? ` (rerouted around ${plan.reroutes})` : ''}.${counts.caution ? ` ${counts.caution} heads-up below.` : ''}` })));
  }

  const total = trip.lengthM || 1;
  const pct = (m) => `${Math.max(0, Math.min(100, (m / total) * 100)).toFixed(2)}%`;
  const ticks = [
    ...pois.map((p) => el('span', { class: 'tick park', style: null, 'data-l': pct(p.alongM) })),
    ...alerts.filter((a) => a.severity !== 'info').sort((a) => (a.severity === 'danger' ? 1 : -1)).map((a) => el('span', { class: `tick ${a.severity}`, 'data-l': pct(a.alongM) })),
  ];
  for (const k of ticks) k.style.left = k.dataset.l; // CSSOM, not inline style attributes (CSP)
  $('strip').replaceChildren(...ticks);
  $('stripEnd').textContent = `${miles(total)} mi`;
  $('notes').replaceChildren(...notes.map((n) => el('li', {}, icon('info'), el('span', { text: n }))));

  $('cntAlerts').textContent = alerts.length ? String(alerts.length) : '';
  $('cntParking').textContent = pois.length ? String(pois.length) : '';
  $('tab-alerts').replaceChildren(...(alerts.length ? alerts.map(alertCard) : [el('li', { class: 'empty', text: 'Nothing flagged. Still watch the signs.' })]));

  $('tab-parking').replaceChildren(...(pois.length ? pois.map((p) => {
    const go = () => flyTo(p.lat, p.lon, poiTitle(p), `${miles(p.offRouteM)} mi off route`);
    return el('li', { class: 'card ok', tabindex: '0', role: 'button', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
      el('div', { class: 'tile' }, icon(POI_ICON[p.kind])),
      el('div', {}, el('div', { class: 'sev', text: POI_LABEL[p.kind] }), el('div', { class: 't', text: poiTitle(p) }), el('div', { class: 'd', text: `${miles(p.offRouteM)} mi off route · mapped, not live availability` })),
      mileCell(p.alongM));
  }) : [el('li', { class: 'empty', text: 'No mapped truck parking near this route.' })]));

  $('tab-intel').replaceChildren(...state.tips.map((tip) => {
    const src = el('div', { class: 'src' });
    for (const s of (tip.sources || []).slice(0, 2)) src.append(link(s.title || 'Source', s.url));
    return el('li', { class: 'card tip' }, el('div', { class: 'tile' }, icon('truck')), el('div', {}, el('div', { class: 't', text: tip.text }), src));
  }));

  const dest = state.stops.to;
  $('scoutBtn').href = `https://www.google.com/maps/@?api=1&map_action=map&center=${dest.lat.toFixed(6)},${dest.lon.toFixed(6)}&zoom=18&basemap=satellite`;
  selectTab('alerts');
  view('results');
}

function selectTab(name) {
  for (const t of document.querySelectorAll('.seg-btn')) { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); }
  for (const n of ['alerts', 'parking', 'intel']) show(`tab-${n}`, n === name);
}

// ---------- go ----------
async function onSubmit(e) {
  e.preventDefault();
  if (state.busy) return;
  document.activeElement?.blur?.();
  state.busy = true;
  setError('');
  try {
    await parseNow();
    const to = await resolveStop('to', 'to');
    const from = await resolveStop('from', 'from');
    view('busy');
    if (isPhone()) snap('peek');
    const plan = await planRoute({ stops: [from, to], profile: state.profile, options: state.options, seeds: state.seeds, api: state.api, onProgress: setProgress });
    state.plan = plan;
    drawPlan(plan);
    renderResults(plan);
    if (isPhone()) snap('half');
    if (state.spoke) {
      const c = plan.counts;
      speak(`${miles(plan.trip.lengthM)} miles. ${c.danger ? `${c.danger} problem spot${c.danger > 1 ? 's' : ''} to check.` : 'No clearance or truck ban conflicts found.'}`);
    }
  } catch (err) {
    view('plan');
    if (isPhone()) snap('half');
    setError(isNoPath(err) ? 'No truck-legal route between those points with your settings. Try removing a setting.' : err.message || 'Something went wrong.');
  } finally {
    state.busy = false;
  }
}

async function loadData() {
  const get = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch { return null; } };
  const [hz, tips] = await Promise.all([get('data/hazards.json'), get('data/tips.json')]);
  state.seeds = Array.isArray(hz && hz.hazards) ? hz.hazards : [];
  state.tips = Array.isArray(tips && tips.tips) ? tips.tips : [];
}

async function main() {
  renderProfileSummary();
  wireSheet();
  $('presets').replaceChildren(...PRESETS.map((pr) => el('button', { type: 'button', text: pr.label, onclick: () => fillProfileForm(sanitizeProfile({ ...state.profile, ...pr.p })) })));
  applyModeChrome(currentMode());
  $('modeBtn').addEventListener('click', toggleMode);
  $('profileBtn').addEventListener('click', openProfile);
  $('profileDlg').addEventListener('close', onProfileClose);
  $('tripForm').addEventListener('submit', onSubmit);
  $('prompt').addEventListener('input', parseSoon);
  $('prompt').addEventListener('change', parseNow);
  $('locBtn').addEventListener('click', useMyLocation);
  $('editBtn').addEventListener('click', () => { setError(''); view('plan'); if (isPhone()) snap('half'); });
  for (const t of document.querySelectorAll('.seg-btn')) t.addEventListener('click', () => selectTab(t.dataset.tab));
  if (voiceSupported) $('micBtn').addEventListener('click', onMic);
  else {
    $('micBtn').disabled = true;
    $('micLabel').textContent = 'Type how to run it';
    $('micBtn').setAttribute('aria-label', 'Voice input isn’t available in this browser');
  }

  const [{ api, config }] = await Promise.all([connect(), loadData()]);
  state.api = api; state.config = config;
  wireSuggest('from', 'fromSuggest', 'from');
  wireSuggest('to', 'toSuggest', 'to');
  initMap();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

main().catch((e) => setError(e.message || 'Failed to start.'));
