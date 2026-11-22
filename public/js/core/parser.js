// Rule-based route-prompt parser. Works offline with no API key.
// "avoid tolls and stay off I-95, I'm 13'6 grossing 78k" ->
//   { avoidTolls: true, avoidRoads: ['I-95'], heightIn: 162, weightLbs: 78000 }
// Output always goes through sanitizeOptions().

import { sanitizeOptions } from './options.js';
import { parseHeightToInches } from './units.js';

const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "eighty thousand" -> "80000", "thirteen six" stays "13 6". Only handles what speech-to-text emits. */
export function wordsToDigits(text) {
  const words = text.split(/(\s+|-)/);
  const out = [];
  let cur = null; // running number for a run of number words
  let gap = ''; // whitespace seen inside a number run; re-emitted if the run ends
  const flush = () => { if (cur !== null) { out.push(String(cur)); cur = null; } if (gap) { out.push(gap); gap = ''; } };
  for (const tok of words) {
    const w = tok.toLowerCase();
    if (/^\s+$|^-$/.test(tok)) { if (cur === null) out.push(tok); else gap = tok; continue; }
    if (w in SMALL || w in TENS) {
      const v = SMALL[w] ?? TENS[w];
      gap = '';
      if (cur === null) cur = v;
      else if (cur % 100 >= 20 && cur % 10 === 0 && v < 10) cur += v; // "eighty two"
      else if (cur >= 100 && cur % 100 === 0 && v < 100) cur += v; // "one hundred five"
      else { flush(); out.push(' '); cur = v; }                          // "thirteen six" -> two numbers
      continue;
    }
    if (w === 'hundred' && cur !== null) { cur *= 100; gap = ''; continue; }
    if (w === 'thousand' && cur !== null) { cur *= 1000; gap = ''; continue; }
    if (w === 'and' && cur !== null && cur >= 100) { gap = ''; continue; }
    flush();
    out.push(tok);
  }
  flush();
  return out.join('').replace(/ {2,}/g, ' ');
}

const AVOID = /\b(avoid|avoiding|no|skip|without|dodge|bypass|stay (?:off|away from|out of)|keep (?:me )?(?:off|out of|away from)|don'?t (?:take|use|want|go (?:on|through|thru|into))|not? (?:on|through|thru)|go around|steer clear of|hate|nothing with)\b/;
const PREFER = /\b(stick to|stay on|prefer|use|take|only|keep (?:me )?on)\b/;

const ROAD_PATTERNS = [
  [/\b(?:i|interstate)\s?-?\s?(\d{1,3})\b(?!\s*(?:'|ft|feet|foot|"|in\b|inch|k\b|lbs?|pounds|tons?|thousand|percent|%))/g, (n) => `I-${n}`],
  [/\b(?:us|u\.s\.)\s?-?\s?(?:hwy |highway |route )?(\d{1,3})\b/g, (n) => `US-${n}`],
  [/\b(?:sr|state road|state route|state highway)\s?-?\s?(\d{1,4})\b/g, (n) => `SR-${n}`],
  [/\b(?:route|rt|hwy|highway)\s?-?\s?(\d{1,4})\b/g, (n) => `Route ${n}`],
];
const NAMED_ROAD = /\b((?:[a-z0-9']+ ){0,2}[a-z0-9']+) (street|st|avenue|ave|road|rd|parkway|pkwy|drive|dr|boulevard|blvd|bridge|expressway|expy|tunnel|beltway|bypass|lane|ln|turnpike|pike|causeway|freeway)\b/g;
const STOP = new Set(['the', 'avoid', 'avoiding', 'take', 'any', 'no', 'off', 'of', 'out', 'on', 'stay', 'keep', 'me', 'away', 'from', 'and', 'use', 'a', 'that', 'this', 'skip', 'dodge', 'bypass', 'go', 'around', 'through', 'thru', "don't", 'dont', 'want', 'please', 'yo', 'bro', 'also', 'clear', 'steer', 'hate', 'with', 'nothing', 'into', 'without']);
const SUFFIX = { st: 'St', street: 'Street', ave: 'Ave', avenue: 'Avenue', rd: 'Rd', road: 'Road', pkwy: 'Pkwy', parkway: 'Parkway', dr: 'Dr', drive: 'Drive', blvd: 'Blvd', boulevard: 'Boulevard', bridge: 'Bridge', expy: 'Expy', expressway: 'Expressway', tunnel: 'Tunnel', beltway: 'Beltway', bypass: 'Bypass', lane: 'Lane', ln: 'Ln', turnpike: 'Turnpike', pike: 'Pike', causeway: 'Causeway', freeway: 'Freeway' };

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Generic nouns that mean a feature, not a place.
const GENERIC = /\b(tolls?|toll roads?|highways?|interstates?|freeways?|expressways?|ferr(?:y|ies)|dirt|gravel|unpaved|tunnels?|mountains?|passes|grades?|steep|hills?|neighbou?rhoods?|residential|side streets|back roads|city streets|traffic|construction|scales|weigh stations?|low (?:bridges?|clearances?)|bridges|hazmat|parking|truck stops?|downtown)\b/;

function extractRoads(clause) {
  const roads = [];
  for (const [re, fmt] of ROAD_PATTERNS) for (const m of clause.matchAll(re)) roads.push(fmt(m[1]));
  for (const m of clause.matchAll(NAMED_ROAD)) {
    const words = m[1].split(' ').filter((w) => !STOP.has(w));
    if (!words.length || words.every((w) => /^\d+$/.test(w))) continue;
    if (/^(?:i|us|sr|route|rt|hwy|highway|interstate)$/.test(words[0])) continue; // numbered, handled above
    roads.push(`${titleCase(words.join(' '))} ${SUFFIX[m[2]]}`);
  }
  if (/\bturnpike\b/.test(clause) && !roads.some((r) => /turnpike/i.test(r))) roads.push('Turnpike');
  return roads;
}

function parseHeight(t) {
  // Needs an explicit height context so "53 foot trailer" isn't read as height.
  const ctx = /(?:height|tall|high|clearance|i'?m|im|we'?re|truck(?:'s| is)|running|sitting at|rig is|trailer is)\D{0,12}?(\d{1,2}\s*(?:'|ft|feet|foot)\s*(?:\d{1,2}(?:\.\d)?\s*(?:"|in\b|inch(?:es)?)?)?|\d{1,2}\s+\d{1,2}\b|\d(?:\.\d+)?\s*(?:m|meters?|metres?))/;
  const after = /(\d{1,2}\s*(?:'|ft|feet|foot)\s*(?:\d{1,2}\s*(?:"|in\b|inch(?:es)?)?)?|\b\d{1,2}\s+\d{1,2})\s*(?:tall|high)\b/;
  const m = t.match(after) || t.match(ctx);
  if (!m) return undefined;
  let raw = m[1].trim();
  const pair = raw.match(/^(\d{1,2})\s+(\d{1,2})$/); // "13 6" from speech
  if (pair) raw = `${pair[1]}'${pair[2]}`;
  const inches = parseHeightToInches(raw, 'ft');
  return inches && inches >= 96 && inches <= 180 ? Math.round(inches * 10) / 10 : undefined;
}

function parseWeight(t) {
  let m = t.match(/(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:lbs?|pounds)\b/);
  if (m) return +m[1].replace(/,/g, '');
  m = t.match(/(?:weigh(?:ing|s|t)?|gross(?:ing)?(?: weight)?|loaded (?:at|to)|scaled (?:at|out at))\s*(?:is |of |at )?(\d{1,3}(?:,\d{3})+|\d{4,6})\b(?!\s*(?:'|ft|feet|foot|"|in\b|inch))/);
  if (m) { const v = +m[1].replace(/,/g, ''); if (v >= 5000 && v <= 200000) return v; }
  m = t.match(/(?:weigh(?:ing|s)?|gross(?:ing)?|loaded (?:at|to)|i'?m at|at|heavy at|scaled (?:at|out at))\s*(\d{2,3}(?:\.\d)?)\s*(k|thousand)\b/);
  if (m) return Math.round(+m[1] * 1000);
  m = t.match(/\b(\d{2,3}(?:\.\d)?)\s*k\s*(?:lbs?|pounds)?\b/);
  if (m && +m[1] >= 10) return Math.round(+m[1] * 1000);
  m = t.match(/(?:weigh(?:ing|s)?|gross(?:ing)?|loaded (?:at|to)|i'?m at|scaled (?:at|out at))\s*(\d{1,3}(?:\.\d)?)\s*tons?\b/);
  if (m) return Math.round(+m[1] * 2000);
  return undefined;
}

function parseLength(t) {
  let m = t.match(/(\d{2,3})\s*(?:'|ft|feet|foot)[- ]?(?:long|overall)/);
  if (m) return +m[1];
  m = t.match(/(\d{2})\s*(?:'|ft|feet|foot)[- ]?(?:trailer|box|reefer|van|flatbed|step ?deck)/);
  if (m) return +m[1] + 20; // trailer + typical tractor/coupling (~20 ft)
  return undefined;
}

/**
 * Parse a spoken/typed route request.
 * @returns {{options: object, notes: string[]}}
 */
export function parsePrompt(input) {
  const notes = [];
  if (typeof input !== 'string') return { options: {}, notes };
  let t = wordsToDigits(input.slice(0, 500)).toLowerCase()
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/\binterstate (\d)/g, 'i-$1');
  const o = {};

  // Whole-text numeric facts first (they can span clause splits like "13, 6").
  const h = parseHeight(t); if (h) o.heightIn = h;
  const w = parseWeight(t); if (w) o.weightLbs = w;
  const len = parseLength(t); if (len) o.lengthFt = len;
  const margin = t.match(/(\d{1,2})\s*(?:"|in\b|inch(?:es)?)\s*(?:of\s*)?(?:extra\s*)?(?:buffer|margin|cushion|clearance buffer|extra)/)
    || t.match(/extra\s*(\d{1,2})\s*(?:"|in\b|inch(?:es)?)/);
  if (margin) o.clearanceMarginIn = +margin[1];

  // Hazmat (carrying vs not).
  if (/\b(hazmat|haz mat|placard(?:ed|s)?|hazardous)\b/.test(t)) {
    o.hazmat = !/\b(no|not|non|ain'?t|empty|without)\b[^.,;]{0,12}\b(hazmat|haz mat|placard|hazardous)/.test(t);
  }

  // Clause-level intents.
  const clauses = t.split(/[,;.!?]|\band\b|\bbut\b|\balso\b|\bthen\b|\bplus\b/).map((c) => c.trim()).filter(Boolean);
  let lastVerbAvoid = false;
  for (const c of clauses) {
    const avoidHere = AVOID.test(c);
    // "avoid tolls and I-95": the second clause inherits the avoid verb.
    const avoid = avoidHere || (lastVerbAvoid && !PREFER.test(c));
    if (avoidHere) lastVerbAvoid = true; else if (PREFER.test(c)) lastVerbAvoid = false;

    if (/\btolls?\b|\btoll roads?\b/.test(c)) {
      if (/\b(ok|okay|fine|good|cool)\b|\b(take|use|pay)\b[^,]{0,10}\btolls?\b|don'?t avoid/.test(c)) o.avoidTolls = false;
      else if (avoid) o.avoidTolls = true;
    }
    if (/\b(highways|interstates|freeways|expressways)\b/.test(c)) {
      if (/\b(stick to|stay on|only|prefer|keep (?:me )?on)\b/.test(c)) { o.avoidHighways = false; o.avoidResidential = true; }
      else if (avoid) o.avoidHighways = true;
    }
    if (/\bferr(?:y|ies)\b/.test(c) && avoid) o.avoidFerries = true;
    if (/\b(dirt|gravel|unpaved)\b/.test(c) && avoid) o.avoidUnpaved = true;
    if (/\btunnels\b|\b(?:no|avoid|any) tunnel\b/.test(c) && avoid) o.avoidTunnels = true;
    if (/\btruck routes?\b/.test(c) && !avoidHere) o.preferTruckRoutes = true;
    if (/\b(neighbou?rhoods?|residential|side streets|back roads|city streets|surface streets)\b/.test(c) && avoid) o.avoidResidential = true;
    if (/\b(mountains?|mountain passes|passes|grades?|steep|hills?)\b/.test(c) && avoid) o.avoidMountainPasses = true;
    if (/\b(parking|truck stops?|place to (?:sleep|park|shut down)|rest areas?|somewhere to (?:sleep|park))\b/.test(c)) o.showParking = true;
    if (/\b(weigh stations?|scales|chicken coops?)\b/.test(c)) o.showWeighStations = true;

    if (avoid) {
      const roads = extractRoads(c);
      if (roads.length) (o.avoidRoads ||= []).push(...roads);
      // Anything left after the verb that isn't a road or a generic feature is a place.
      const pm = c.match(/\b(?:stay out of|keep (?:me )?out of|avoid|avoiding|go around|bypass|not through|don'?t go (?:through|into)|steer clear of)\s+(?:the\s+)?(downtown\s+)?([a-z][a-z .']{2,30})$/);
      if (pm && !roads.length && !GENERIC.test(pm[2]) && !/\d/.test(pm[2])) {
        const place = titleCase(`${pm[1] || ''}${pm[2]}`.trim());
        if (place.split(' ').length <= 4) (o.avoidPlaces ||= []).push(place);
      } else if (!roads.length && /\bdowntown\s*$/.test(c)) {
        // "avoid downtown" alone: can't place it without a city.
        notes.push('Say which city for "downtown", e.g. "avoid downtown Atlanta".');
      }
    }
  }
  const options = sanitizeOptions(o);
  return { options, notes };
}
