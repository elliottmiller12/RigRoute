import test from 'node:test';
import assert from 'node:assert/strict';
import { llmParse } from '../src/llm.js';

const reply = (text, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text }] });
function client({ beta, plain }) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(['beta', req]); return beta(req); } } },
    messages: { create: async (req) => { calls.push(['plain', req]); return plain(req); } },
  };
}

test('structured output is sanitized; the key never leaves the server module', async () => {
  const c = client({ beta: () => reply(JSON.stringify({ avoidTolls: true, avoidRoads: ['I-95', 'DROP TABLE;'], heightIn: 1 })) });
  const o = await llmParse('no tolls stay off 95', { model: 'claude-opus-5-5', client: c });
  assert.deepEqual(o, { avoidTolls: true, avoidRoads: ['I-95'] });
  const req = c.calls[0][1];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual(req.messages, [{ role: 'user', content: 'no tolls stay off 95' }]);
});

test('falls back to a plain call when the fallback beta is rejected', async () => {
  const c = client({ beta: () => { throw Object.assign(new Error('bad'), { status: 400 }); }, plain: () => reply('{"hazmat":true}') });
  assert.deepEqual(await llmParse('hazmat', { model: 'm', client: c }), { hazmat: true });
  assert.equal(c.calls[1][0], 'plain');
});

test('refusals, truncation and junk return null (rules take over)', async () => {
  for (const r of [reply('{}', 'refusal'), reply('{"avoid', 'max_tokens'), reply('not json'), { stop_reason: 'end_turn', content: [] }]) {
    assert.equal(await llmParse('x', { model: 'm', client: client({ beta: () => r }) }), null);
  }
  assert.equal(await llmParse('x', {}), null); // no key, no client
});
