import { encodePolyline, cumulative } from '../public/js/core/geo.js';

const MI = 1609.344;

/** Straight line of n points from a to b ([lat, lon]). */
export function line(a, b, n = 40) {
  const out = [];
  for (let i = 0; i < n; i++) { const f = i / (n - 1); out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
  return out;
}

/** Fake Valhalla /route response for a polyline, with optional maneuvers [{streets, from, to, toll}]. */
export function valhallaResponse(pts, { maneuvers, hasToll = false } = {}) {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const ms = (maneuvers || [{ streets: ['Main Street'], from: 0, to: pts.length - 1 }]).map((m) => ({
    instruction: `Drive on ${m.streets[0] || 'road'}`, street_names: m.streets, length: (cum[m.to] - cum[m.from]) / MI, time: 60,
    begin_shape_index: m.from, end_shape_index: m.to, toll: !!m.toll, highway: true,
  }));
  return { trip: { legs: [{ shape: encodePolyline(pts, 6), maneuvers: ms }], summary: { length: total / MI, time: total / 25, has_toll: hasToll } } };
}

/** Fake api object for planRoute. Each handler can be overridden. */
export function fakeApi(h = {}) {
  const calls = { route: [], overpass: [], height: [], geocode: [] };
  return {
    calls,
    route: async (args) => { calls.route.push(args); return h.route(args, calls.route.length); },
    overpass: async (kind, pts) => { calls.overpass.push({ kind, pts }); return h.overpass ? h.overpass(kind, pts) : { elements: [] }; },
    height: async (pts) => { calls.height.push(pts); return h.height ? h.height(pts) : { range_height: [] }; },
    geocode: async (q) => { calls.geocode.push(q); return h.geocode ? h.geocode(q) : []; },
  };
}

export const noPath = () => Object.assign(new Error('No path could be found for input'), { status: 422 });
