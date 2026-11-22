// Unit parsing/conversion shared by browser and server. Pure functions, no deps.

export const IN_PER_M = 39.3700787;
export const LBS_PER_TONNE = 2204.62262;
export const M_PER_MI = 1609.344;
export const FT_PER_M = 3.2808399;

/** Inches -> 13'6" style label. */
export function fmtFeetIn(inches) {
  if (!Number.isFinite(inches)) return '?';
  let ft = Math.floor(inches / 12);
  let inch = Math.round(inches - ft * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return `${ft}'${inch}"`;
}

export function fmtLbs(lbs) {
  if (!Number.isFinite(lbs)) return '?';
  return `${Math.round(lbs).toLocaleString('en-US')} lbs`;
}

export function fmtMiles(meters) {
  const mi = meters / M_PER_MI;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/**
 * Parse an OSM-style or spoken height into inches.
 * Accepts: 4.1, "4.1 m", "13'6\"", "13' 6", "13 ft 6 in", "13 feet 6 inches", "13.5 ft", "13'".
 * Bare numbers are metres (OSM default) unless `bareUnit` = 'ft'.
 * Returns null for non-numeric values like "default", "none", "below_default".
 */
export function parseHeightToInches(raw, bareUnit = 'm') {
  if (raw == null) return null;
  if (typeof raw === 'number') return bareUnit === 'ft' ? raw * 12 : raw * IN_PER_M;
  const s = String(raw).trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/''/g, '"');
  if (!s || /^(default|none|below_default|unsigned|no)$/.test(s)) return null;
  let m;
  // feet + inches: 13'6", 13' 6, 13 ft 6 in, 13 feet 6 inches, 13-6
  if ((m = s.match(/^(\d{1,2})\s*(?:'|ft|feet|foot)\s*[-, ]?\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|in|inch|inches)?$/))) {
    const ft = +m[1], inch = +m[2];
    if (inch >= 12) return null;
    return ft * 12 + inch;
  }
  if ((m = s.match(/^(\d{1,2}(?:\.\d+)?)\s*(?:'|ft|feet|foot)$/))) return +m[1] * 12;
  if ((m = s.match(/^(\d{2,3}(?:\.\d+)?)\s*(?:"|in|inch|inches)$/))) return +m[1];
  if ((m = s.match(/^(\d{1,2}(?:[.,]\d+)?)\s*(?:m|meter|meters|metre|metres)?$/))) {
    const n = +m[1].replace(',', '.');
    return bareUnit === 'ft' && !/m/.test(s) ? n * 12 : n * IN_PER_M;
  }
  if ((m = s.match(/^(\d{3})\s*cm$/))) return (+m[1] / 100) * IN_PER_M;
  return null;
}

/**
 * Parse an OSM maxweight value to pounds.
 * Bare numbers are metric tonnes (OSM convention). Supports t, st (short tons), lbs, kg.
 */
export function parseWeightToLbs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw * LBS_PER_TONNE;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '');
  if (!s || /^(default|none|unsigned|no)$/.test(s)) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(t|tonnes?|st|short tons?|tons?|lbs?|pounds?|kg|k)?$/);
  if (!m) return null;
  const n = +m[1];
  switch (m[2]) {
    case undefined: case 't': case 'tonne': case 'tonnes': return n * LBS_PER_TONNE;
    case 'st': case 'short ton': case 'short tons': case 'ton': case 'tons': return n * 2000;
    case 'lb': case 'lbs': case 'pound': case 'pounds': return n;
    case 'kg': return n * 2.20462262;
    case 'k': return n * 1000;
    default: return null;
  }
}

export const inToM = (inches) => inches / IN_PER_M;
export const lbsToTonnes = (lbs) => lbs / LBS_PER_TONNE;
export const ftToM = (ft) => ft / FT_PER_M;
