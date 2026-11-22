// OpenStreetMap (Overpass API) queries for live restriction + truck-POI data along a route.
// Queries are always built here from numbers; nobody passes raw Overpass QL through the proxy.

import { simplifyTo, chunkLine, haversine } from './geo.js';
import { parseHeightToInches, parseWeightToLbs } from './units.js';

const fmt = (n) => (Math.round(n * 1e5) / 1e5).toString();
const lineArg = (pts) => pts.map(([la, lo]) => `${fmt(la)},${fmt(lo)}`).join(',');

function validLine(pts, max) {
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > max) throw new Error('Bad line');
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) throw new Error('Bad point');
  }
  return pts;
}

/** Split a route into the polylines the client will send (each one query). */
export function restrictionChunks(line, { chunkM = 60000, perChunkPts = 220 } = {}) {
  return chunkLine(line, chunkM).map((c) => simplifyTo(c, perChunkPts, 6));
}
export function poiChunks(line, { chunkM = 250000, perChunkPts = 200 } = {}) {
  return chunkLine(line, chunkM).map((c) => simplifyTo(c, perChunkPts, 150));
}

export function buildRestrictionQuery(pts) {
  const a = `(around:30,${lineArg(validLine(pts, 400))})`;
  return `[out:json][timeout:25][maxsize:67108864];
(
  way${a}["highway"]["maxheight"];
  way${a}["highway"]["maxheight:physical"];
  node${a}["maxheight"];
  way${a}["highway"]["maxweight"];
  way${a}["highway"]["maxweight:hgv"];
  way${a}["highway"]["hgv"="no"];
  way${a}["highway"]["hazmat"="no"];
);
out tags geom qt 800;`;
}

export function buildPoiQuery(pts) {
  const a = `(around:1500,${lineArg(validLine(pts, 400))})`;
  return `[out:json][timeout:25][maxsize:67108864];
(
  nwr${a}["amenity"="parking"]["hgv"~"^(yes|designated)$"];
  nwr${a}["highway"="rest_area"];
  nwr${a}["highway"="services"];
  nwr${a}["amenity"="fuel"]["hgv"~"^(yes|designated)$"];
  nwr${a}["amenity"="weighbridge"];
  nwr${a}["name"~"weigh station",i];
);
out tags center qt 400;`;
}

const pick = (tags, keys) => Object.fromEntries(keys.filter((k) => tags[k] != null).map((k) => [k, String(tags[k]).slice(0, 80)]));
const TAG_KEYS = ['name', 'ref', 'highway', 'bridge', 'tunnel', 'maxheight', 'maxheight:physical', 'maxweight', 'maxweight:hgv', 'hgv', 'hazmat', 'amenity', 'capacity:hgv', 'opening_hours', 'fee', 'operator', 'brand', 'access'];

function bearing(a, b) {
  const y = Math.sin((b[1] - a[1]) * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180);
  const x = Math.cos(a[0] * Math.PI / 180) * Math.sin(b[0] * Math.PI / 180) - Math.sin(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.cos((b[1] - a[1]) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); }; // undirected

/**
 * Is this OSM way actually part of the route, or just crossing it (e.g. a road under an overpass we drive over)?
 * `idx` comes from makeLineIndex(routeLine).
 * On-route means: some vertex/segment within `tol` m of the route AND aligned within 30°.
 */
export function wayOnRoute(geom, idx, tol = 18) {
  const line = idx.line;
  if (!Array.isArray(geom) || geom.length < 2) return null;
  let best = null;
  for (let i = 0; i < geom.length - 1; i++) {
    const a = geom[i], b = geom[i + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const p of [a, mid, b]) {
      const n = idx.nearest(p, 200);
      if (n.dist > tol || n.index < 0) continue;
      const rb = bearing(line[n.index], line[Math.min(n.index + 1, line.length - 1)]);
      const wb = bearing(a, b);
      if (haversine(a, b) < 3 || angDiff(rb, wb) <= 30) {
        if (!best || n.dist < best.dist) best = { ...n, at: p };
      }
    }
  }
  return best;
}

/** Parse restriction query JSON into features positioned along the route. */
export function readRestrictions(json, idx) {
  const out = [];
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    let near = null;
    if (el.type === 'node' && Number.isFinite(el.lat)) {
      const n = idx.nearest([el.lat, el.lon], 200);
      if (n.dist <= 15) near = { ...n, at: [el.lat, el.lon] };
    } else if (el.type === 'way' && Array.isArray(el.geometry)) {
      near = wayOnRoute(el.geometry.map((g) => [g.lat, g.lon]), idx);
    }
    if (!near) continue;
    const heightRaw = tags['maxheight:physical'] ?? tags.maxheight;
    const weightRaw = tags['maxweight:hgv'] ?? tags.maxweight;
    out.push({
      id: `osm:${el.type}/${el.id}`,
      source: 'osm',
      lat: near.at[0], lon: near.at[1], alongM: near.along,
      name: tags.name || tags.ref || '',
      tags: pick(tags, TAG_KEYS),
      heightIn: heightRaw != null ? parseHeightToInches(heightRaw) : undefined,
      heightRaw, weightRaw,
      weightLbs: weightRaw != null ? parseWeightToLbs(weightRaw) : undefined,
      hgvNo: tags.hgv === 'no',
      hazmatNo: tags.hazmat === 'no',
    });
  }
  return out;
}

/** Parse POI query JSON. */
export function readPois(json, idx) {
  const out = [];
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let kind = 'parking';
    if (tags.amenity === 'weighbridge' || /weigh station/i.test(tags.name || '')) kind = 'weigh';
    else if (tags.amenity === 'fuel' || tags.highway === 'services') kind = 'truckstop';
    else if (tags.highway === 'rest_area') kind = 'rest';
    const n = idx.nearest([lat, lon], 2600);
    if (n.dist > 2500) continue;
    out.push({ id: `osm:${el.type}/${el.id}`, kind, lat, lon, alongM: n.along, offRouteM: Math.round(n.dist), name: tags.name || tags.brand || tags.operator || '', tags: pick(tags, TAG_KEYS) });
  }
  // Dedupe near-identical points (same place mapped as node + area).
  const seen = new Set();
  return out.filter((p) => { const k = `${p.kind}:${p.lat.toFixed(3)}:${p.lon.toFixed(3)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.alongM - b.alongM);
}
