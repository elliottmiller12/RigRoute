// Two ways to reach the routing/map services:
//  - proxy (default): same-origin /api/* on our server, which validates and
//    rebuilds every upstream request and holds any keys.
//  - direct: when there's no server (static hosting/demo), call the public
//    Valhalla / Overpass / Nominatim endpoints straight from the browser using
//    the same request builders. Prompt parsing is rules-only in this mode.

import { buildRouteRequest, heightRequest } from './core/valhalla.js';
import { buildRestrictionQuery, buildPoiQuery } from './core/overpass.js';
import { parsePrompt } from './core/parser.js';
import { fromPhoton, fromNominatim, rankPlaces, textScore, fallbackQuery } from './core/places.js';

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
// Kept for older callers and tests: Photon GeoJSON -> normalized places.
export const readPhoton = (raw) => fromPhoton(raw).slice(0, 6);

const post = (url, data) => fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function proxyApi() {
  return {
    mode: 'proxy',
    route: (args) => post('api/route', args),
    height: (line) => post('api/height', { line }),
    overpass: (kind, line) => post('api/overpass', { kind, line }),
    geocode: (q, { near = null } = {}) => fetchJson(`api/geocode?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat.toFixed(4)}&lon=${near.lon.toFixed(4)}` : ''}`),
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
    // near = {lat, lon}: results around there rank first (your location, your other stop, the map).
    geocode: async (q, { suggest = false, near = null } = {}) => {
      const nearKey = near ? `${near.lat.toFixed(1)},${near.lon.toFixed(1)}` : '';
      const key = `${q.trim().toLowerCase()}|${nearKey}`;
      if (geoCache.has(key)) return geoCache.get(key);
      const photon = async (text) => {
        const u = new URL(DIRECT.photon);
        const params = { q: text, limit: '15', lang: 'en', bbox: '-170,14,-50,72' };
        if (near) Object.assign(params, { lat: near.lat.toFixed(4), lon: near.lon.toFixed(4), zoom: '10', location_bias_scale: '0.3' });
        u.search = new URLSearchParams(params).toString();
        return fromPhoton(await fetchJson(u, { referrerPolicy: 'strict-origin-when-cross-origin' }, 15000));
      };
      let out;
      try {
        let found = await photon(q);
        // Nothing matching every word? The last word is often a misspelled town ("cassleberry").
        const fb = fallbackQuery(q);
        if (fb && !found.some((p) => textScore(q, p) >= 0.99)) {
          try { found = found.concat(await photon(fb)); } catch { /* keep what we have */ }
        }
        out = rankPlaces(found, q, near);
      } catch (e) {
        if (suggest) throw e;
        const u = new URL(DIRECT.nominatim);
        u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '8', countrycodes: 'us,ca,mx,pr', addressdetails: '1' }).toString();
        out = rankPlaces(fromNominatim(await fetchJson(u, { referrerPolicy: 'strict-origin-when-cross-origin' }, 15000)), q, near);
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
