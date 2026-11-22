// Geometry helpers. Coordinates are [lat, lon] unless a name says otherwise.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Decode Google-style encoded polyline (Valhalla uses precision 6). Returns [[lat, lon], ...]. */
export function decodePolyline(str, precision = 6) {
  if (typeof str !== 'string') return [];
  const factor = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        if (i >= str.length) return out; // truncated input: stop cleanly
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && shift < 35);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

export function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let pLat = 0, pLon = 0, out = '';
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, lo] of points) {
    const lat = Math.round(la * factor), lon = Math.round(lo * factor);
    out += enc(lat - pLat) + enc(lon - pLon);
    pLat = lat; pLon = lon;
  }
  return out;
}

/** Cumulative distance (m) at each vertex. */
export function cumulative(line) {
  const d = new Float64Array(line.length);
  for (let i = 1; i < line.length; i++) d[i] = d[i - 1] + haversine(line[i - 1], line[i]);
  return d;
}

/** Distance (m) from p to segment ab, plus fraction t along ab. Local flat-earth, fine under ~50 km. */
function pointSeg(p, a, b) {
  const kx = Math.cos(rad(p[0])) * 111320, ky = 110540;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { dist: Math.hypot(x, y), t };
}

export function bboxOf(line, padDeg = 0) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of line) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return [s - padDeg, w - padDeg, n + padDeg, e + padDeg];
}

/**
 * Nearest approach of point p to polyline. Returns {dist, along, index}.
 * `cum` (from cumulative()) is optional but avoids recomputation.
 * Uses a cheap degree-distance prefilter so 50k-vertex routes stay fast.
 */
export function nearestOnLine(p, line, cum = cumulative(line), maxDist = Infinity) {
  let best = { dist: Infinity, along: 0, index: -1 };
  const degCut = maxDist === Infinity ? Infinity : maxDist / 80000 + 0.01;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    if (degCut !== Infinity) {
      const minLat = Math.min(a[0], b[0]) - degCut, maxLat = Math.max(a[0], b[0]) + degCut;
      const minLon = Math.min(a[1], b[1]) - degCut * 1.6, maxLon = Math.max(a[1], b[1]) + degCut * 1.6;
      if (p[0] < minLat || p[0] > maxLat || p[1] < minLon || p[1] > maxLon) continue;
    }
    const r = pointSeg(p, a, b);
    if (r.dist < best.dist) best = { dist: r.dist, along: cum[i] + r.t * (cum[i + 1] - cum[i]), index: i };
  }
  if (line.length === 1) best = { dist: haversine(p, line[0]), along: 0, index: 0 };
  return best;
}

/** Douglas–Peucker simplification with tolerance in metres. Keeps endpoints. */
export function simplify(line, tolM) {
  if (line.length < 3) return line.slice();
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSeg(line[i], line[s], line[e]).dist;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return line.filter((_, i) => keep[i]);
}

/** Simplify until at most maxPts points remain (doubling tolerance). */
export function simplifyTo(line, maxPts, startTol = 25) {
  let tol = startTol, out = simplify(line, tol);
  while (out.length > maxPts && tol < 1e6) { tol *= 2; out = simplify(line, tol); }
  return out;
}

/** Split a line into consecutive chunks of about `chunkM` metres (shared endpoints). */
export function chunkLine(line, chunkM) {
  const chunks = [];
  let cur = [line[0]], acc = 0;
  for (let i = 1; i < line.length; i++) {
    acc += haversine(line[i - 1], line[i]);
    cur.push(line[i]);
    if (acc >= chunkM && i < line.length - 1) { chunks.push(cur); cur = [line[i]]; acc = 0; }
  }
  if (cur.length > 1 || !chunks.length) chunks.push(cur);
  return chunks;
}

/** Square ring around a point, half-size in metres. Returns [[lon,lat],...] (Valhalla/GeoJSON order). */
export function squareRing(lat, lon, halfM) {
  const dLat = halfM / 110540, dLon = halfM / (111320 * Math.cos(rad(lat)));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]];
}

/** Bounding-box ring [[lon,lat],...] from [s,w,n,e]. */
export function bboxRing([s, w, n, e]) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

/**
 * Grid index over route segments so "how far is this point from the route" stays fast
 * on 50k-vertex cross-country routes. Cell ~0.01° (~1 km).
 */
export function makeLineIndex(line, cum = cumulative(line)) {
  const CELL = 0.01;
  const grid = new Map();
  const key = (la, lo) => `${Math.floor(la / CELL)}:${Math.floor(lo / CELL)}`;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const la0 = Math.floor(Math.min(a[0], b[0]) / CELL), la1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const lo0 = Math.floor(Math.min(a[1], b[1]) / CELL), lo1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let x = la0; x <= la1; x++) for (let y = lo0; y <= lo1; y++) {
      const k = `${x}:${y}`;
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(i);
    }
  }
  return {
    line, cum,
    /** Nearest approach within maxDist (m, <= ~3 km for exactness). */
    nearest(p, maxDist = 500) {
      const r = Math.ceil(maxDist / 1000) + 1;
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      let best = { dist: Infinity, along: 0, index: -1 };
      const seen = new Set();
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
        const arr = grid.get(`${x}:${y}`);
        if (!arr) continue;
        for (const i of arr) {
          if (seen.has(i)) continue;
          seen.add(i);
          const s = pointSeg(p, line[i], line[i + 1]);
          if (s.dist < best.dist) best = { dist: s.dist, along: cum[i] + s.t * (cum[i + 1] - cum[i]), index: i };
        }
      }
      if (line.length === 1) best = { dist: haversine(p, line[0]), along: 0, index: 0 };
      return best;
    },
  };
}
