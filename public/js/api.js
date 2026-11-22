// Two ways to reach the routing/map services:
//  - proxy (default): same-origin /api/* on our server, which validates and
//    rebuilds every upstream request and holds any keys.
//  - direct: when there's no server (static hosting/demo), call the public
//    Valhalla / Overpass / Nominatim endpoints straight from the browser using
//    the same request builders. Prompt parsing is rules-only in this mode.

import { buildRouteRequest, heightRequest } from './core/valhalla.js';
import { buildRestrictionQuery, buildPoiQuery } from './core/overpass.js';
import { parsePrompt } from './core/parser.js';

const DIRECT = {
  valhalla: 'https://valhalla1.openstreetmap.de',
  overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  // Photon (komoot) is built for type-ahead search; Nominatim's policy forbids search-as-you-type.
  photon: 'https://photon.komoot.io/api/',
  nominatim: 'https://nominatim.openstreetmap.org/search',
  mapStyle: 'https://tiles.openfreemap.org/styles/liberty',
};
const TIMEOUT_MS = 30000;

async function fetchJson(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { referrerPolicy: 'no-referrer', ...init, signal: ctl.signal, credentials: 'same-origin', redirect: 'error' });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = (body && (body.error || body.error_message)) || `Request failed (${res.status})`;
      const err = new Error(String(msg).slice(0, 200));
      err.status = res.status;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The map service took too long. Try again.');
    throw e;
  } finally { clearTimeout(t); }
}

// Public Valhalla: GET ?json= (what openstreetmap.org's own directions use from the browser),
// falling back to a text/plain POST for long bodies. Both are "simple" CORS requests, so the
// browser sends no preflight the public server might not answer.
const MAX_GET_URL = 6000;
export function valhallaUrl(base, action, body) {
  const u = `${base}/${action}?json=${encodeURIComponent(JSON.stringify(body))}`;
  return u.length <= MAX_GET_URL ? u : null;
}
function valhalla(action, body) {
  const u = valhallaUrl(DIRECT.valhalla, action, body);
  if (u) return fetchJson(u);
  return fetchJson(`${DIRECT.valhalla}/${action}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
}

/** Photon GeoJSON -> our {label, lat, lon, bbox} results (US, Canada, Mexico). */
export function readPhoton(raw) {
  const feats = raw && Array.isArray(raw.features) ? raw.features : [];
  return feats.map((f) => {
    const p = (f && f.properties) || {};
    const c = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
    if (p.countrycode && !['US', 'CA', 'MX'].includes(String(p.countrycode).toUpperCase())) return null;
    const street = p.street ? `${p.housenumber ? `${p.housenumber} ` : ''}${p.street}` : '';
    const parts = [p.name, street, p.city || p.county, p.state].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
    const label = [...new Set(parts)].join(', ').slice(0, 160);
    const ex = Array.isArray(p.extent) && p.extent.length === 4 ? p.extent.map(Number) : null;
    return { label, lat: +c[1], lon: +c[0], bbox: ex && ex.every(Number.isFinite) ? [ex[3], ex[0], ex[1], ex[2]] : null };
  }).filter((r) => r && r.label && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180).slice(0, 5);
}

const post = (url, data) => fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function proxyApi() {
  return {
    mode: 'proxy',
    route: (args) => post('api/route', args),
    height: (line) => post('api/height', { line }),
    overpass: (kind, line) => post('api/overpass', { kind, line }),
    geocode: (q) => fetchJson(`api/geocode?q=${encodeURIComponent(q)}`),
    parse: (text) => post('api/parse', { text }),
  };
}

function directApi() {
  const geoCache = new Map();
  return {
    mode: 'direct',
    route: (args) => valhalla('route', buildRouteRequest(args)),
    height: (line) => valhalla('height', heightRequest(line)),
    overpass: async (kind, line) => {
      const q = kind === 'pois' ? buildPoiQuery(line) : buildRestrictionQuery(line);
      // Public Overpass servers turn busy clients away (429/504). Wait and retry once,
      // then try the mirror, before reporting the section as unchecked.
      const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: q }).toString() };
      let lastErr;
      for (const [url, waitMs] of [[DIRECT.overpass[0], 0], [DIRECT.overpass[0], 2500], [DIRECT.overpass[1], 0]]) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        try {
          const data = await fetchJson(url, init, 60000);
          return { elements: Array.isArray(data && data.elements) ? data.elements : [] };
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
    // suggest=true is type-ahead: Photon only. A real search (pressing Route it) falls back to
    // Nominatim once if Photon is down; Nominatim's policy rules it out for type-ahead.
    geocode: async (q, { suggest = false } = {}) => {
      const key = q.trim().toLowerCase();
      if (geoCache.has(key)) return geoCache.get(key);
      let out;
      try {
        const u = new URL(DIRECT.photon);
        u.search = new URLSearchParams({ q, limit: '8', lang: 'en', bbox: '-170,14,-50,72' }).toString();
        out = readPhoton(await fetchJson(u, { referrerPolicy: 'strict-origin-when-cross-origin' }, 15000));
      } catch (e) {
        if (suggest) throw e;
        const u = new URL(DIRECT.nominatim);
        u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '5', countrycodes: 'us,ca,mx' }).toString();
        const raw = await fetchJson(u, { referrerPolicy: 'strict-origin-when-cross-origin' }, 15000);
        out = (Array.isArray(raw) ? raw : []).slice(0, 5).map((r) => {
          const bb = (r.boundingbox || []).map(Number);
          return { label: String(r.display_name || '').slice(0, 160), lat: +r.lat, lon: +r.lon,
            bbox: bb.length === 4 && bb.every(Number.isFinite) ? [bb[0], bb[2], bb[1], bb[3]] : null };
        }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
      }
      geoCache.set(key, out);
      return out;
    },
    parse: async (text) => ({ ...parsePrompt(text), engine: 'rules' }),
  };
}

/** Pick proxy mode if our server answers, otherwise go direct. */
export async function connect() {
  try {
    const cfg = await fetchJson('api/config', {}, 5000);
    if (cfg && cfg.mode === 'proxy') return { api: proxyApi(), config: { mapStyle: cfg.mapStyle || DIRECT.mapStyle, llm: !!cfg.llm, mode: 'proxy' } };
  } catch { /* no server */ }
  return { api: directApi(), config: { mapStyle: DIRECT.mapStyle, llm: false, mode: 'direct' } };
}
