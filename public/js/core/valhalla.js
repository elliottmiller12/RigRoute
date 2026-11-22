// Builds Valhalla truck requests and reads responses. Shared by the server proxy
// (which rebuilds every request itself — clients never send raw Valhalla JSON)
// and the static "direct" mode.

import { decodePolyline, encodePolyline, cumulative, haversine, simplifyTo } from './geo.js';
import { inToM, lbsToTonnes, ftToM, M_PER_MI } from './units.js';
import { sanitizeProfile, sanitizeOptions, effectiveProfile } from './options.js';

const okLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const okLon = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

export function sanitizeLocations(locs) {
  if (!Array.isArray(locs) || locs.length < 2 || locs.length > 6) throw new Error('Need 2 to 6 stops');
  return locs.map((l) => {
    if (!l || !okLat(l.lat) || !okLon(l.lon)) throw new Error('Bad stop coordinates');
    return { lat: Math.round(l.lat * 1e6) / 1e6, lon: Math.round(l.lon * 1e6) / 1e6, type: 'break' };
  });
}

function sanitizeRings(rings, maxRings = 60) {
  if (!Array.isArray(rings)) return [];
  const out = [];
  for (const ring of rings.slice(0, maxRings)) {
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 64) continue;
    const pts = ring.filter((p) => Array.isArray(p) && okLon(p[0]) && okLat(p[1])).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
    if (pts.length !== ring.length) continue;
    // Refuse giant polygons (>~60 km span): they wreck routing and aren't what any option means.
    const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    if (Math.max(...lons) - Math.min(...lons) > 0.8 || Math.max(...lats) - Math.min(...lats) > 0.6) continue;
    out.push(pts);
  }
  return out;
}

function sanitizePoints(pts, max = 40) {
  if (!Array.isArray(pts)) return [];
  return pts.slice(0, max).filter((p) => p && okLat(p.lat) && okLon(p.lon)).map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }));
}

/**
 * @param {object} args
 *  locations: [{lat,lon}], profile, options, excludePolygons: [[[lon,lat]...]],
 *  excludeLocations: [{lat,lon}], hardTolls: bool (try a hard toll exclusion first)
 */
export function buildRouteRequest({ locations, profile, options, excludePolygons, excludeLocations, hardTolls }) {
  const o = sanitizeOptions(options);
  const p = effectiveProfile(sanitizeProfile(profile), o);
  const truck = {
    height: +(inToM(p.heightIn + p.clearanceMarginIn)).toFixed(2),
    width: +inToM(p.widthIn).toFixed(2),
    length: +ftToM(p.lengthFt).toFixed(2),
    weight: +lbsToTonnes(p.weightLbs).toFixed(2),
    axle_load: +lbsToTonnes(p.axleLoadLbs).toFixed(2),
    axle_count: p.axles,
    hazmat: !!p.hazmat,
    use_tolls: o.avoidTolls ? 0 : 0.5,
    use_highways: o.avoidHighways ? 0 : 1,
    use_ferry: o.avoidFerries ? 0 : 0.3,
    use_truck_route: o.preferTruckRoutes ? 1 : 0.3,
    low_class_penalty: o.avoidResidential ? 300 : 60, // residential/service roads (seconds)
    use_living_streets: 0,
    exclude_unpaved: !!o.avoidUnpaved,
  };
  if (o.avoidTunnels) truck.exclude_tunnels = true;
  if (o.avoidTolls && hardTolls) truck.exclude_tolls = true;
  const req = {
    locations: sanitizeLocations(locations),
    costing: 'truck',
    costing_options: { truck },
    units: 'miles',
    language: 'en-US',
    directions_type: 'instructions',
    alternates: 0,
  };
  const polys = sanitizeRings(excludePolygons);
  if (polys.length) req.exclude_polygons = polys;
  const ex = sanitizePoints(excludeLocations);
  if (ex.length) req.exclude_locations = ex;
  return req;
}

/** Normalize a Valhalla /route response into what the app needs. Throws on bad shape. */
export function readTrip(resp) {
  const trip = resp && resp.trip;
  if (!trip || !Array.isArray(trip.legs) || !trip.legs.length) throw new Error('No route in response');
  const line = [];
  const maneuvers = [];
  for (const leg of trip.legs) {
    const pts = decodePolyline(leg.shape, 6);
    const offset = line.length ? line.length - 1 : 0;
    if (line.length) pts.shift(); // legs share an endpoint
    line.push(...pts);
    for (const m of leg.maneuvers || []) {
      maneuvers.push({
        instruction: String(m.instruction || '').slice(0, 300),
        streets: Array.isArray(m.street_names) ? m.street_names.map((s) => String(s).slice(0, 80)).slice(0, 5) : [],
        lengthM: (+m.length || 0) * M_PER_MI,
        timeS: +m.time || 0,
        begin: offset + (m.begin_shape_index | 0),
        end: offset + (m.end_shape_index | 0),
        toll: !!m.toll, highway: !!m.highway, rough: !!m.rough, ferry: !!m.ferry,
      });
    }
  }
  const s = trip.summary || {};
  const cum = cumulative(line);
  for (const m of maneuvers) m.alongM = cum[Math.min(m.begin, cum.length - 1)] || 0;
  return {
    line, cum, maneuvers,
    lengthM: (+s.length || 0) * M_PER_MI,
    timeS: +s.time || 0,
    hasToll: !!s.has_toll, hasHighway: !!s.has_highway, hasFerry: !!s.has_ferry,
    warnings: Array.isArray(trip.warnings) ? trip.warnings.map((w) => String(w.text || w).slice(0, 200)).slice(0, 5) : [],
  };
}

// ---- road-name avoidance -------------------------------------------------

const ABBR = { dr: 'drive', st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', pkwy: 'parkway', pky: 'parkway', blvd: 'boulevard', expy: 'expressway', ln: 'lane', hwy: 'highway', tpke: 'turnpike', fwy: 'freeway', cswy: 'causeway' };
const norm = (s) => s.toLowerCase().replace(/\b([a-z]+)\b\.?/g, (w, x) => ABBR[x] || x).replace(/[^a-z0-9]/g, '');
/** Variants a road name may appear as in OSM street_names: "I-95" ~ "I 95" ~ "Interstate 95". */
export function roadMatcher(name) {
  const n = norm(name);
  const m = name.match(/^(I|US|SR|Route)[- ](\d+)$/i);
  const keys = new Set([n]);
  if (m) {
    const num = m[2], k = m[1].toUpperCase();
    if (k === 'I') ['i' + num, 'interstate' + num].forEach((x) => keys.add(x));
    if (k === 'US') ['us' + num, 'ushighway' + num, 'usroute' + num, 'us' + num + 'business'].forEach((x) => keys.add(x));
    if (k === 'SR') ['sr' + num, 'stateroad' + num, 'stateroute' + num, 'statehighway' + num, 'state' + num].forEach((x) => keys.add(x));
    if (k === 'ROUTE') ['route' + num, 'rt' + num, 'highway' + num, 'hwy' + num, 'sr' + num, 'us' + num].forEach((x) => keys.add(x));
    // Token-boundary match so I-9 doesn't match I-95 and US-1 doesn't match US-17.
    const res = [...keys].map((k2) => new RegExp(`(?:^|[a-z])${k2}(?!\\d)`));
    return (street) => { const s = norm(street); return res.some((re) => re.test(s)); };
  }
  return (street) => norm(street).includes(n);
}

/** Maneuvers that use any avoided road, and sample points on them for exclude_locations. */
export function findAvoidedRoadUse(trip, avoidRoads) {
  if (!avoidRoads?.length) return { hits: [], points: [] };
  const matchers = avoidRoads.map((r) => [r, roadMatcher(r)]);
  const hits = [];
  const points = [];
  for (const m of trip.maneuvers) {
    for (const [name, match] of matchers) {
      if (m.streets.some(match)) {
        hits.push({ road: name, alongM: m.alongM, lengthM: m.lengthM });
        // Sample up to 3 points along this maneuver's stretch (skip its very start, which is the junction).
        const span = Math.max(1, m.end - m.begin);
        for (const f of [0.25, 0.5, 0.75]) {
          const idx = Math.min(trip.line.length - 1, m.begin + Math.max(1, Math.round(span * f)));
          const [lat, lon] = trip.line[idx];
          points.push({ lat, lon });
        }
        break;
      }
    }
  }
  return { hits, points: points.slice(0, 30) };
}

// ---- grades from elevation -------------------------------------------------

/** Simplified copy of the route for the elevation service (<= 1500 points). */
export function simplifyForHeight(line) {
  return simplifyTo(line, 1500, 20);
}

/** Valhalla /height request from a simplified line. Validates input (server rebuilds from this). */
export function heightRequest(simple) {
  if (!Array.isArray(simple) || simple.length < 2 || simple.length > 1600) throw new Error('Bad line');
  for (const p of simple) if (!Array.isArray(p) || !okLat(p[0]) || !okLon(p[1])) throw new Error('Bad point');
  let total = 0;
  for (let i = 1; i < simple.length; i++) total += haversine(simple[i - 1], simple[i]);
  if (total > 6000 * 1609) throw new Error('Line too long');
  const resample = Math.max(100, Math.ceil(total / 4000 / 10) * 10); // <= ~4000 samples
  return { encoded_polyline: encodePolyline(simple, 6), shape_format: 'polyline6', range: true, resample_distance: resample };
}

/**
 * Find sustained steep stretches. `rangeHeight` = [[distM, elevM|null], ...].
 * Reports runs where the 1-mile rolling grade stays >= minPct, length >= minLenM.
 */
export function analyzeGrades(rangeHeight, simpleLine, { minPct = 5, minLenM = 1600 } = {}) {
  const pts = (rangeHeight || []).filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  if (pts.length < 3) return [];
  const W = 1609; // window
  const grades = []; // grade at each sample over the window ahead
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (j < pts.length - 1 && pts[j][0] - pts[i][0] < W) j++;
    const d = pts[j][0] - pts[i][0];
    grades.push(d >= W * 0.8 ? ((pts[j][1] - pts[i][1]) / d) * 100 : 0);
  }
  const cum = cumulative(simpleLine);
  const posAt = (dist) => {
    let k = 1;
    while (k < cum.length && cum[k] < dist) k++;
    if (k >= cum.length) return simpleLine[simpleLine.length - 1];
    const f = (dist - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
    const a = simpleLine[k - 1], b = simpleLine[k];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const out = [];
  let start = -1, sign = 0;
  const close = (endIdx) => {
    const s = pts[start], e = pts[Math.min(endIdx + 0, pts.length - 1)];
    const endD = Math.min(e[0] + W, pts[pts.length - 1][0]);
    const len = endD - s[0];
    const endElev = pts.find((p) => p[0] >= endD)?.[1] ?? pts[pts.length - 1][1];
    const avg = ((endElev - s[1]) / (len || 1)) * 100;
    if (len >= minLenM && Math.abs(avg) >= minPct * 0.85) {
      out.push({ alongM: s[0], lengthM: len, avgPct: +avg.toFixed(1), downhill: avg < 0, at: posAt(s[0]) });
    }
  };
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i], sg = Math.sign(g);
    const steep = Math.abs(g) >= minPct;
    if (steep && start < 0) { start = i; sign = sg; }
    else if (start >= 0 && (!steep || sg !== sign)) { close(i - 1); start = steep ? i : -1; sign = sg; }
  }
  if (start >= 0) close(grades.length - 1);
  return out;
}
