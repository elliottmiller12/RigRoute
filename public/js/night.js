// Turns a light vector map style into a dim night style, in place, by rewriting
// every color in its paint properties (including inside zoom expressions).
// Lets us use the free OpenFreeMap "liberty" tiles without a second style.

const COLOR_PROPS = {
  background: ['background-color'],
  fill: ['fill-color', 'fill-outline-color'],
  'fill-extrusion': ['fill-extrusion-color'],
  line: ['line-color'],
  symbol: ['text-color', 'text-halo-color', 'icon-color', 'icon-halo-color'],
  circle: ['circle-color', 'circle-stroke-color'],
};

const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };

/** Parse a CSS color string into [r,g,b,a] (0-255, alpha 0-1), or null. */
export function parseColor(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t].slice();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = t.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], alpha(m[4])];
  m = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[ ,]+([\d.]+)%[ ,]+([\d.]+)%(?:[ ,/]+([\d.]+%?))?\s*\)$/);
  if (m) return [...hslToRgb(+m[1], +m[2] / 100, +m[3] / 100), alpha(m[4])];
  return null;
}
const alpha = (a) => (a == null ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : +a);

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** How each kind of paint maps lightness at night. */
const MAPPERS = {
  area: (l) => 0.045 + (1 - l) * 0.42,  // light land/water/parks -> near-black, keeps relative order
  line: (l) => 0.16 + l * 0.24,          // white roads -> mid grey, casings darker
  text: (l) => 0.93 - l * 0.45,          // dark labels -> light
  halo: () => 0.06,
};

function shift(str, kind) {
  const c = parseColor(str);
  if (!c) return str;
  const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
  const nl = Math.max(0, Math.min(1, MAPPERS[kind](l)));
  const ns = kind === 'line' ? s * 0.55 : s * 0.5;
  const [r, g, b] = hslToRgb(h, ns, nl);
  return `rgba(${r}, ${g}, ${b}, ${+c[3].toFixed(3)})`;
}

function mapValue(v, kind) {
  if (typeof v === 'string') return shift(v, kind);
  if (Array.isArray(v)) return v.map((x) => mapValue(x, kind));
  if (v && typeof v === 'object' && Array.isArray(v.stops)) return { ...v, stops: v.stops.map(([z, c]) => [z, mapValue(c, kind)]) };
  return v;
}

function kindFor(layerType, prop) {
  if (prop === 'text-halo-color' || prop === 'icon-halo-color') return 'halo';
  if (layerType === 'symbol') return 'text';
  if (layerType === 'line') return 'line';
  return 'area';
}

/** Is this a light style (background lighter than mid grey)? */
export function isLightStyle(style) {
  const bg = (style.layers || []).find((l) => l.type === 'background');
  const v = bg && bg.paint && bg.paint['background-color'];
  const c = parseColor(typeof v === 'string' ? v : Array.isArray(v) ? v.find((x) => parseColor(x)) : null);
  return !c || rgbToHsl(c[0], c[1], c[2])[2] > 0.5;
}

/** Returns a new style object with night colors. */
export function nightify(style) {
  const out = { ...style, layers: (style.layers || []).map((layer) => {
    const props = COLOR_PROPS[layer.type];
    if (!props || !layer.paint) return layer;
    const paint = { ...layer.paint };
    for (const p of props) if (p in paint) paint[p] = mapValue(paint[p], kindFor(layer.type, p));
    if (layer.type === 'background') paint['background-color'] = '#0b1a22';
    if (layer.type === 'fill-extrusion' && 'fill-extrusion-opacity' in paint) paint['fill-extrusion-opacity'] = 0.5;
    return { ...layer, paint };
  }) };
  return out;
}
