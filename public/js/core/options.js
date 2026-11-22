// Truck profile + route-option schema. Everything that reaches routing goes
// through sanitize*() first: whitelisted keys, clamped numbers, short strings.
// The LLM parser's output is run through the same gate, so a bad model reply
// can never inject anything the rule parser couldn't.

import { fmtFeetIn, fmtLbs } from './units.js';

export const DEFAULT_PROFILE = Object.freeze({
  heightIn: 162,      // 13'6" (standard dry van)
  widthIn: 102,       // 8'6"
  lengthFt: 72,       // tractor + 53' trailer
  weightLbs: 80000,   // federal gross limit
  axles: 5,
  axleLoadLbs: 20000, // per single axle, federal
  hazmat: false,
  clearanceMarginIn: 3,
});

const LIMITS = {
  heightIn: [72, 180], widthIn: [60, 144], lengthFt: [15, 130], weightLbs: [5000, 200000],
  axles: [2, 13], axleLoadLbs: [5000, 40000], clearanceMarginIn: [0, 24],
};

function num(v, [lo, hi]) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (n < lo || n > hi) return undefined; // reject, don't clamp: out-of-range = misparse
  return Math.round(n * 10) / 10;
}

export function sanitizeProfile(p) {
  const out = { ...DEFAULT_PROFILE };
  if (!p || typeof p !== 'object') return out;
  for (const k of Object.keys(LIMITS)) {
    const v = num(p[k], LIMITS[k]);
    if (v !== undefined) out[k] = k === 'axles' ? Math.round(v) : v;
  }
  if (typeof p.hazmat === 'boolean') out.hazmat = p.hazmat;
  return out;
}

const BOOL_KEYS = ['avoidTolls', 'avoidHighways', 'avoidFerries', 'avoidUnpaved', 'avoidTunnels',
  'preferTruckRoutes', 'avoidResidential', 'avoidMountainPasses', 'hazmat',
  'showParking', 'showWeighStations'];
const NUM_KEYS = { heightIn: LIMITS.heightIn, weightLbs: LIMITS.weightLbs, lengthFt: LIMITS.lengthFt,
  clearanceMarginIn: LIMITS.clearanceMarginIn };

// Road/place names: letters, digits, spaces and a little punctuation. Nothing else gets through.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .'&\-]{0,47}$/;

function cleanList(list, max) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!NAME_RE.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Returns a new object containing only valid, known option keys. */
export function sanitizeOptions(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of BOOL_KEYS) if (typeof o[k] === 'boolean') out[k] = o[k];
  for (const [k, lim] of Object.entries(NUM_KEYS)) {
    const v = num(o[k], lim);
    if (v !== undefined) out[k] = v;
  }
  const roads = cleanList(o.avoidRoads, 8);
  if (roads.length) out.avoidRoads = roads;
  const places = cleanList(o.avoidPlaces, 4);
  if (places.length) out.avoidPlaces = places;
  return out;
}

/** Merge parsed prompt options over the saved profile (prompt wins for this trip). */
export function effectiveProfile(profile, options) {
  const p = sanitizeProfile(profile);
  const o = sanitizeOptions(options);
  for (const k of ['heightIn', 'weightLbs', 'lengthFt', 'clearanceMarginIn']) if (o[k] !== undefined) p[k] = o[k];
  if (typeof o.hazmat === 'boolean') p.hazmat = o.hazmat;
  return p;
}

/** Short human-readable chips so the driver can confirm what was understood. */
export function describeOptions(o) {
  const chips = [];
  const yesNo = (k, yes, no) => { if (o[k] === true) chips.push({ key: k, label: yes }); else if (o[k] === false && no) chips.push({ key: k, label: no }); };
  yesNo('avoidTolls', 'No tolls', 'Tolls OK');
  yesNo('avoidHighways', 'Avoid interstates/highways', 'Highways OK');
  yesNo('avoidFerries', 'No ferries');
  yesNo('avoidUnpaved', 'No dirt/gravel roads');
  yesNo('avoidTunnels', 'No tunnels');
  yesNo('preferTruckRoutes', 'Stick to truck routes');
  yesNo('avoidResidential', 'Stay out of neighborhoods');
  yesNo('avoidMountainPasses', 'Avoid mountain passes/steep grades');
  yesNo('hazmat', 'Hauling hazmat', 'Not hazmat');
  yesNo('showParking', 'Show truck parking');
  yesNo('showWeighStations', 'Show weigh stations');
  if (o.heightIn) chips.push({ key: 'heightIn', label: `Height ${fmtFeetIn(o.heightIn)}` });
  if (o.weightLbs) chips.push({ key: 'weightLbs', label: `Weight ${fmtLbs(o.weightLbs)}` });
  if (o.lengthFt) chips.push({ key: 'lengthFt', label: `Length ${o.lengthFt} ft` });
  if (o.clearanceMarginIn !== undefined) chips.push({ key: 'clearanceMarginIn', label: `Clearance buffer ${o.clearanceMarginIn}"` });
  for (const r of o.avoidRoads || []) chips.push({ key: 'avoidRoads', value: r, label: `Avoid ${r}` });
  for (const p of o.avoidPlaces || []) chips.push({ key: 'avoidPlaces', value: p, label: `Stay out of ${p}` });
  return chips;
}

/** Remove one chip's effect from an options object (driver taps the x on a chip). */
export function removeChip(options, chip) {
  const o = { ...options };
  if (chip.key === 'avoidRoads' || chip.key === 'avoidPlaces') {
    o[chip.key] = (o[chip.key] || []).filter((v) => v !== chip.value);
    if (!o[chip.key].length) delete o[chip.key];
  } else delete o[chip.key];
  return o;
}

/** JSON schema handed to the LLM (structured output) — mirrors sanitizeOptions. */
export const OPTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(BOOL_KEYS.map((k) => [k, { type: 'boolean' }])),
    heightIn: { type: 'number', description: 'Truck height in inches, only if the driver states it' },
    weightLbs: { type: 'number', description: 'Gross weight in pounds, only if stated' },
    lengthFt: { type: 'number', description: 'Overall length in feet, only if stated' },
    clearanceMarginIn: { type: 'number', description: 'Extra clearance buffer in inches, only if asked' },
    avoidRoads: { type: 'array', items: { type: 'string' }, description: 'Roads to avoid, normalized like I-95, US-1, SR-408, or a street name' },
    avoidPlaces: { type: 'array', items: { type: 'string' }, description: 'Cities/areas to stay out of, e.g. Downtown Atlanta' },
  },
  required: [],
};
