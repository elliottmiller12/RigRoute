import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, isLightStyle, nightify } from '../public/js/night.js';

const light = {
  version: 8, sources: {},
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    { id: 'water', type: 'fill', paint: { 'fill-color': 'rgb(158,189,255)' } },
    { id: 'road', type: 'line', paint: { 'line-color': ['match', ['get', 'k'], 'a', '#ffffff', 'hsl(48, 100%, 83%)'] } },
    { id: 'label', type: 'symbol', paint: { 'text-color': '#333', 'text-halo-color': 'white' } },
    { id: 'zoomed', type: 'line', paint: { 'line-color': { stops: [[5, '#eee'], [12, '#ddd']] } } },
  ],
};
const lum = (c) => { const [r, g, b] = parseColor(c); return (Math.max(r, g, b) + Math.min(r, g, b)) / 510; };

test('parseColor reads hex, rgb, hsl and names', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)').slice(0, 3), [255, 0, 0]);
  assert.deepEqual(parseColor('white'), [255, 255, 255, 1]);
  assert.equal(parseColor('not a color'), null);
});

test('nightify turns a light style dark without touching the original', () => {
  assert.equal(isLightStyle(light), true);
  const night = nightify(light);
  assert.equal(isLightStyle(night), false);
  assert.equal(light.layers[0].paint['background-color'], '#f8f4f0');
  const p = Object.fromEntries(night.layers.map((l) => [l.id, l.paint]));
  assert.ok(lum(p.bg['background-color']) < 0.15);
  assert.ok(lum(p.water['fill-color']) < 0.3);
  const [, , , white, hsl] = p.road['line-color'];
  assert.ok(lum(white) < 0.5 && lum(hsl) < 0.5, 'colors inside expressions are mapped');
  assert.ok(lum(p.label['text-color']) > 0.6, 'dark text becomes light');
  assert.ok(lum(p.label['text-halo-color']) < 0.15, 'halos go dark');
  assert.ok(p.zoomed['line-color'].stops.every(([, c]) => lum(c) < 0.5));
});
