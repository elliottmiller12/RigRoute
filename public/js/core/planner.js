// Route planning loop: route -> check against driver asks, seed intel, live OSM
// restrictions and grades -> exclude what conflicts -> reroute (bounded).
// `api` is injected so the same logic runs through the server proxy, direct
// public endpoints, or test fakes.

import { readTrip, findAvoidedRoadUse, simplifyForHeight, analyzeGrades } from './valhalla.js';
import { restrictionChunks, poiChunks, readRestrictions, readPois } from './overpass.js';
import { evaluate, countBySeverity } from './hazards.js';
import { makeLineIndex, haversine } from './geo.js';
import { effectiveProfile, sanitizeOptions, sanitizeProfile } from './options.js';

const MAX_REROUTES = 4;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

/** Routing engine said there's no path (vs. a network/server failure). */
export function isNoPath(err) {
  return !!err && (err.status === 422 || /no path|no suitable edges|failed to find a route|no route/i.test(String(err.message || '')));
}

const ringKey = (r) => r[0].map((v) => v.toFixed(4)).join(',');
const locKey = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/** Route points inside a place's bbox (away from the stops), for exclude_locations. */
function placeHits(trip, places, stops) {
  const pts = [];
  const hits = [];
  for (const pl of places) {
    const [s, w, n, e] = pl.bbox;
    let first = -1, last = -1;
    for (let i = 0; i < trip.line.length; i++) {
      const [la, lo] = trip.line[i];
      if (la >= s && la <= n && lo >= w && lo <= e) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) continue;
    const span = last - first;
    const cand = [];
    for (let k = 1; k <= 8; k++) cand.push(trip.line[first + Math.round((span * k) / 9)]);
    const usable = cand.filter((p) => stops.every((st) => haversine(p, [st.lat, st.lon]) > 3000));
    if (!usable.length) continue;
    hits.push({ name: pl.name, alongM: trip.cum[first], lengthM: trip.cum[last] - trip.cum[first] });
    for (const [lat, lon] of usable) pts.push({ lat, lon });
  }
  return { hits, points: pts };
}

/**
 * @param {object} a
 *   stops [{lat,lon,label}], profile, options, seeds, api {route, overpass, height, geocode}, onProgress(msg)
 */
export async function planRoute(a) {
  const { stops, seeds = [], api } = a;
  const options = sanitizeOptions(a.options);
  const profile = effectiveProfile(sanitizeProfile(a.profile), options);
  const progress = a.onProgress || (() => {});
  const notes = [];
  const excludeRings = [];
  const excludeLocations = [];
  const addRings = (rs) => { let n = 0; for (const r of rs) if (!excludeRings.some((x) => ringKey(x) === ringKey(r))) { excludeRings.push(r); n++; } return n; };
  const addLocs = (ps) => { let n = 0; for (const p of ps) if (excludeLocations.length < 40 && !excludeLocations.some((x) => locKey(x) === locKey(p))) { excludeLocations.push(p); n++; } return n; };

  // Places to stay out of -> bounding boxes.
  const places = [];
  for (const name of options.avoidPlaces || []) {
    try {
      const res = await api.geocode(name);
      const hit = res && res[0];
      if (hit && hit.bbox) {
        const [s, w, n, e] = hit.bbox;
        if (n - s > 1.2 || e - w > 1.5) notes.push(`"${name}" is too big an area to route around; skipped.`);
        else places.push({ name, bbox: hit.bbox });
      } else notes.push(`Couldn't find "${name}" to route around it.`);
    } catch { notes.push(`Couldn't look up "${name}".`); }
  }

  let hardTolls = !!options.avoidTolls;
  const route = async () => {
    const args = { locations: stops, profile, options, excludePolygons: excludeRings, excludeLocations, hardTolls };
    try {
      return readTrip(await api.route(args));
    } catch (err) {
      if (!isNoPath(err)) throw err; // outages aren't "no route": don't silently loosen anything
      if (hardTolls) {
        hardTolls = false;
        notes.push('No toll-free truck route exists, so tolls are minimized instead of banned.');
        return readTrip(await api.route({ ...args, hardTolls }));
      }
      if (excludeLocations.length || excludeRings.length) {
        notes.push('Avoiding everything made the trip impossible, so this route keeps some flagged spots. Check the alerts.');
        return readTrip(await api.route({ ...args, excludePolygons: [], excludeLocations: [] }));
      }
      throw err;
    }
  };

  const checkLive = async (trip, idx) => {
    const chunks = restrictionChunks(trip.line);
    let failed = 0;
    const results = await mapLimit(chunks, 2, async (pts) => {
      try { return readRestrictions(await api.overpass('restrictions', pts), idx); }
      catch { failed++; return []; }
    });
    return { osm: results.flat(), failed, total: chunks.length };
  };

  const namedHits = (t) => [
    ...findAvoidedRoadUse(t, options.avoidRoads).hits,
    ...placeHits(t, places, stops).hits.map((h) => ({ road: h.name, alongM: h.alongM, lengthM: h.lengthM })),
  ];

  progress('Routing with your truck profile…');
  let trip = await route();
  let reroutes = 0;
  let avoidRoadHits = [];

  // 1) Driver-named roads and places.
  while (reroutes < 2) {
    const roads = findAvoidedRoadUse(trip, options.avoidRoads);
    const pl = placeHits(trip, places, stops);
    avoidRoadHits = [...roads.hits, ...pl.hits.map((h) => ({ road: h.name, alongM: h.alongM, lengthM: h.lengthM }))];
    if (!avoidRoadHits.length) break;
    if (!addLocs([...roads.points, ...pl.points])) break;
    progress('Rerouting around the roads you asked to avoid…');
    reroutes++;
    trip = await route();
  }
  avoidRoadHits = namedHits(trip);

  // 2) Live restrictions + seed intel, reroute around hard conflicts.
  let idx, live, ev;
  for (;;) {
    idx = makeLineIndex(trip.line, trip.cum);
    progress('Checking bridges, weight limits and truck bans along the route…');
    live = await checkLive(trip, idx);
    ev = evaluate({ trip, idx, profile, seeds, osm: live.osm, avoidRoadHits });
    const danger = ev.alerts.filter((x) => x.severity === 'danger');
    if (!danger.length || reroutes >= MAX_REROUTES) break;
    const added = addRings(ev.excludeRings) + addLocs(ev.excludeLocations);
    if (!added) break;
    progress(`Found ${danger.length} problem spot${danger.length > 1 ? 's' : ''}; rerouting around ${danger.length > 1 ? 'them' : 'it'}…`);
    reroutes++;
    trip = await route();
    avoidRoadHits = namedHits(trip);
  }
  if (live.failed) notes.push(`Live map check failed for ${live.failed} of ${live.total} route sections; alerts there rely on the routing engine's truck limits and the seed list only.`);

  // 3) Grades (and optional avoidance).
  let grades = [];
  const gradeCheck = async () => {
    try {
      const simple = simplifyForHeight(trip.line);
      const h = await api.height(simple);
      return analyzeGrades(h && h.range_height, simple);
    } catch { notes.push('Grade check unavailable right now.'); return null; }
  };
  progress('Checking grades…');
  grades = (await gradeCheck()) || [];
  if (options.avoidMountainPasses && reroutes < MAX_REROUTES + 1) {
    const steep = grades.filter((g) => Math.abs(g.avgPct) >= 5.5);
    if (steep.length && addLocs(steep.map((g) => ({ lat: g.at[0], lon: g.at[1] })))) {
      progress('Looking for a flatter way around the steep grades…');
      reroutes++;
      trip = await route();
      idx = makeLineIndex(trip.line, trip.cum);
      live = await checkLive(trip, idx);
      grades = (await gradeCheck()) || [];
      const still = grades.filter((g) => Math.abs(g.avgPct) >= 5.5).length;
      if (still) notes.push(`${still} steep stretch${still > 1 ? 'es' : ''} couldn't be avoided without leaving truck routes.`);
    }
  }
  avoidRoadHits = namedHits(trip);
  ev = evaluate({ trip, idx, profile, seeds, osm: live.osm, grades, avoidRoadHits });

  // 4) Truck parking / weigh stations.
  let pois = [];
  const wantPois = options.showParking !== false || options.showWeighStations;
  if (wantPois) {
    progress('Finding truck parking along the way…');
    const chunks = poiChunks(trip.line);
    const res = await mapLimit(chunks, 2, async (pts) => {
      try { return readPois(await api.overpass('pois', pts), idx); } catch { return []; }
    });
    pois = res.flat().filter((p) => (p.kind === 'weigh' ? options.showWeighStations !== false : options.showParking !== false));
    const seen = new Set();
    pois = pois.filter((p) => (seen.has(p.id) ? false : seen.add(p.id))).sort((x, y) => x.alongM - y.alongM);
  }

  if (trip.hasToll && options.avoidTolls) notes.push('This route still uses a toll road: there was no truck-legal way around it.');

  return { trip, profile, options, alerts: ev.alerts, counts: countBySeverity(ev.alerts), pois, grades, notes, reroutes };
}
