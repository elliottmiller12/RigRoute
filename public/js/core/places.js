// Place search results, made consistent and ranked.
// Every geocoder (Photon, Nominatim) is mapped to one shape and one format:
//   title: "Amped Fitness"        sub: "1300 State Rd 436, Casselberry, FL"
//   short (what goes in the box): "Amped Fitness, Casselberry, FL"
// Ranking is typo-tolerant ("cassleberry" still matches Casselberry) and prefers places
// near the point the search is biased to (your location, your other stop, the map).
// Pure functions: shared by the browser, server.js and tests.

const REGION_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON', 'prince edward island': 'PE',
  quebec: 'QC', 'québec': 'QC', saskatchewan: 'SK', 'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
};
export const regionAbbr = (s) => {
  const t = String(s || '').trim();
  return REGION_ABBR[t.toLowerCase()] || t;
};

const SUFFIX = {
  avenue: 'Ave', street: 'St', drive: 'Dr', road: 'Rd', boulevard: 'Blvd', highway: 'Hwy', lane: 'Ln', court: 'Ct',
  parkway: 'Pkwy', place: 'Pl', circle: 'Cir', trail: 'Trl', terrace: 'Ter', expressway: 'Expy', freeway: 'Fwy',
  turnpike: 'Tpke', square: 'Sq', way: 'Way', point: 'Pt',
};
const DIR = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };

// "North Federal Highway" -> "N Federal Hwy"; "East Bay Drive" -> "E Bay Dr". Leaves "North Street" alone.
export function abbrevStreet(s) {
  const t = String(s || '').trim()
    .replace(/^State (Road|Route|Highway) (\d+\w?)$/i, 'SR $2')
    .replace(/^County (Road|Route) (\w+)$/i, 'CR $2')
    .replace(/^(U\.?S\.?|United States) (Highway|Route) (\d+\w?)$/i, 'US $3')
    .replace(/^Interstate (\d+\w?)$/i, 'I-$1');
  const w = t.split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  const lastIdx = w.length - 1;
  return w.map((word, i) => {
    const k = word.toLowerCase();
    if (i === lastIdx && i > 0 && SUFFIX[k]) return SUFFIX[k];
    if (i === lastIdx - 1 && i > 0 && SUFFIX[k] && DIR[w[lastIdx].toLowerCase()]) return SUFFIX[k]; // "Main Street North"
    if ((i === 0 || i === lastIdx) && w.length > 2 && DIR[k]) return DIR[k];
    return word;
  }).join(' ');
}

const SMALL = new Set(['of', 'and', 'the', 'at', 'on', 'in', 'for', 'de', 'la']);
// Fix names typed by mappers in all-lowercase or ALL CAPS. Mixed case ("McDonald's") is left alone.
export function tidyName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const letters = t.replace(/[^A-Za-z]/g, '');
  const allLower = letters && letters === letters.toLowerCase();
  const allUpper = letters.length > 4 && letters === letters.toUpperCase();
  if (!allLower && !allUpper) return t;
  return t.toLowerCase().split(' ').map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function kindOf(key, value, type) {
  const k = String(key || ''), v = String(value || ''), ty = String(type || '');
  if (v === 'fuel' || v === 'truck_stop') return 'fuel';
  if (k === 'place' || ['city', 'town', 'village', 'hamlet', 'county', 'state', 'district', 'locality', 'suburb'].includes(ty)) return 'city';
  if (k === 'highway' || ty === 'street') return 'road';
  if (ty === 'house' || k === 'building' || v === 'house' || v === 'residential') return 'address';
  return 'place';
}

// One normalized record from raw address parts.
export function makePlace(p) {
  const name = tidyName(p.name);
  const streetName = abbrevStreet(tidyName(p.street));
  const street = streetName ? `${p.housenumber ? `${String(p.housenumber).trim()} ` : ''}${streetName}` : '';
  const city = tidyName(p.city || p.town || p.village || p.locality || p.district || p.county || '');
  const region = regionAbbr(p.state);
  const kind = kindOf(p.osm_key, p.osm_value, p.type);
  let title, subParts;
  if (kind === 'city') {
    title = name || city;
    subParts = [p.county && tidyName(p.county) !== title ? tidyName(p.county) : '', region];
  } else if (name && name.toLowerCase() !== streetName.toLowerCase()) {
    title = name;
    subParts = [street, city, region];
  } else if (street) {
    title = street;
    subParts = [city, region];
  } else {
    title = name || city;
    subParts = [city !== title ? city : '', region];
  }
  const sub = [...new Set(subParts.filter(Boolean))].join(', ');
  const shortParts = kind === 'city' ? [title, region] : [title, city !== title ? city : '', region];
  const short = [...new Set(shortParts.filter(Boolean))].join(', ');
  return { title: title.slice(0, 120), sub: sub.slice(0, 160), short: short.slice(0, 160), label: short.slice(0, 160), kind };
}

const okCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const NA = ['US', 'CA', 'MX', 'PR'];

export function fromPhoton(raw) {
  const feats = raw && Array.isArray(raw.features) ? raw.features : [];
  const out = [];
  for (const f of feats) {
    const p = (f && f.properties) || {};
    if (p.countrycode && !NA.includes(String(p.countrycode).toUpperCase())) continue;
    const c = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
    const lat = +c[1], lon = +c[0];
    if (!okCoord(lat, lon)) continue;
    const place = makePlace(p);
    if (!place.title) continue;
    const ex = Array.isArray(p.extent) && p.extent.length === 4 ? p.extent.map(Number) : null; // [w, n, e, s]
    out.push({ ...place, lat, lon, bbox: ex && ex.every(Number.isFinite) ? [ex[3], ex[0], ex[1], ex[2]] : null });
  }
  return out;
}

export function fromNominatim(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const lat = +r.lat, lon = +r.lon;
    if (!okCoord(lat, lon)) continue;
    const a = r.address || {};
    const place = makePlace({
      name: r.name || a[r.type] || '', housenumber: a.house_number, street: a.road,
      city: a.city || a.town || a.village || a.hamlet, county: a.county, state: a.state,
      osm_key: r.category || r.class, osm_value: r.type, type: r.addresstype,
    });
    if (!place.title) {
      // No name or address parts (old servers): fall back to the display name, trimmed to the same shape.
      const parts = String(r.display_name || '').split(',').map((x) => x.trim()).filter(Boolean)
        .filter((x) => !/^(United States|USA|Canada|México|Mexico)$/i.test(x) && !/^\d{5}(-\d{4})?$/.test(x));
      if (!parts.length) continue;
      place.title = tidyName(parts[0]).slice(0, 120);
      place.sub = parts.slice(1, 3).map(regionAbbr).join(', ').slice(0, 160);
      place.short = place.label = [place.title, ...parts.slice(1, 3).map(regionAbbr)].join(', ').slice(0, 160);
    }
    const bb = (r.boundingbox || []).map(Number); // [s, n, w, e]
    out.push({ ...place, lat, lon, bbox: bb.length === 4 && bb.every(Number.isFinite) ? [bb[0], bb[2], bb[1], bb[3]] : null });
  }
  return out;
}

// ---------- ranking ----------
export function distanceMi(a, b) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), prev2 = null;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1); // swapped letters
      cur.push(v); rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const FILLER = new Set(['in', 'near', 'at', 'the', 'fl', 'usa', 'us']);

// How well one query word matches a place's words: 1 exact or prefix, 0.85 a near-typo, 0 none.
function wordScore(q, placeWords) {
  let best = 0;
  for (const w of placeWords) {
    if (w === q || (q.length >= 2 && w.startsWith(q))) return 1;
    if (q.length >= 4) {
      const max = q.length >= 8 ? 2 : 1;
      // whole word ("cassleberry" vs "casselberry") or the start of one while still typing ("cassleb")
      if (editDistance(q, w, max) <= max || (w.length > q.length && editDistance(q, w.slice(0, q.length), max) <= max)) best = Math.max(best, 0.85);
    }
  }
  return best;
}

// Share of the query's words that the place matches (0..1).
export function textScore(query, place) {
  const qw = words(query).filter((w) => !FILLER.has(w));
  if (!qw.length) return 0;
  const pw = words(`${place.title} ${place.sub}`);
  const abbr = Object.entries(REGION_ABBR).filter(([, v]) => pw.includes(v.toLowerCase())).flatMap(([k]) => words(k));
  const all = pw.concat(abbr);
  return qw.reduce((s, q) => s + wordScore(q, all), 0) / qw.length;
}

// Rank, de-duplicate, attach distance from `near`. Text match matters most; distance breaks
// near-ties and pushes far-away look-alikes (Plantation, Connecticut) below the local one.
export function rankPlaces(list, query, near, limit = 6) {
  const seen = [];
  const scored = [];
  for (const p of list) {
    const dist = near && okCoord(near.lat, near.lon) ? distanceMi(near, p) : null;
    const text = textScore(query, p);
    const prox = dist == null ? 0 : dist < 15 ? 0.35 : dist < 60 ? 0.25 : dist < 200 ? 0.1 : 0;
    const score = text + prox;
    if (seen.some((s) => s.title.toLowerCase() === p.title.toLowerCase() && distanceMi(s, p) < 0.3)) continue;
    seen.push(p);
    scored.push({ ...p, distMi: dist, score, text });
  }
  return scored.sort((a, b) => b.score - a.score || (a.distMi ?? 1e9) - (b.distMi ?? 1e9)).slice(0, limit);
}

// When nothing matches every word, the last word is often a misspelled town: search without it
// and let the typo-tolerant ranking sort it out.
export function fallbackQuery(query) {
  const w = String(query || '').trim().split(/\s+/);
  return w.length >= 2 ? w.slice(0, -1).join(' ') : null;
}

export function fmtDist(mi) {
  if (mi == null || !Number.isFinite(mi)) return '';
  return mi < 0.1 ? 'here' : mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi).toLocaleString('en-US')} mi`;
}
