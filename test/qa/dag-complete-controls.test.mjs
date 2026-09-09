import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponseGate, assertComplete, parseArgs } from './dag-complete-controls.mjs';

const request = id => new Request(`http://127.0.0.1/api/workspaces/qa-dag/chats/qa-chat/dag-runs/${id}`);
const response = generation => new Response(JSON.stringify({ generation }), { status: 202, headers: { 'x-fixture-version': String(generation) } });

test('CLI requires one evidence directory and rejects ambiguous flags', () => {
  assert.equal(parseArgs(['--evidence-dir', '/tmp/proof']).evidenceDir, '/tmp/proof');
  for (const args of [[], ['--evidence-dir'], ['--other', 'x'], ['--evidence-dir', 'x', '--evidence-dir', 'y']]) assert.throws(() => parseArgs(args));
});

test('held real upstream responses retain independent status headers and body across reverse release', async () => {
  let generation = 0;
  const gate = createResponseGate(async () => response(++generation));
  const a = gate.arm('dense-64'), b = gate.arm('other');
  const first = gate.handle(request('dense-64')), second = gate.handle(request('other'));
  await Promise.all([a.captured, b.captured]);
  assert.equal(a.receipt.body, '{"generation":1}');
  assert.equal(b.receipt.status, 202);
  assert.equal(b.receipt.headers['x-fixture-version'], '2');
  b.release(); assert.equal(await (await second).text(), '{"generation":2}');
  assert.equal(a.state, 'held');
  a.release(); assert.equal(await (await first).text(), '{"generation":1}');
  assert.throws(() => a.release());
  assert.equal((await gate.stop()).pending, 0);
});

test('upstream errors reach waiter and handler; teardown resolves held responses and cancels unused barriers', async () => {
  const gate = createResponseGate(async req => { if (req.url.endsWith('bad')) throw new Error('source failed'); return response(1); });
  const bad = gate.arm('bad');
  await Promise.all([assert.rejects(bad.captured, /source failed/), assert.rejects(gate.handle(request('bad')), /source failed/)]);
  const held = gate.arm('dense-64'), unused = gate.arm('unused');
  const handled = gate.handle(request('dense-64')); await held.captured;
  const cancelled = assert.rejects(unused.captured, /stopped/);
  const receipt = await gate.stop(); await cancelled;
  assert.equal((await handled).status, 503); assert.equal(receipt.pending, 0);
});

test('initial-discovery wildcard claims the incoming detail request synchronously', async () => {
  const gate = createResponseGate(async () => response(1)), held = gate.arm('*');
  const handled = gate.handle(request('discovered'));
  try { assert.equal(held.state, 'fetching'); }
  finally { await gate.stop(); await handled; }
});

test('complete validator detects identity/dependency/text/state/count loss, not only node length', () => {
  const expected = { run_id: 'r', counts: { total: 2 }, nodes: [
    { id: 'a', depends_on: [], prompt: 'x'.repeat(2048), state: 'completed', attempt: 1 },
    { id: 'b', depends_on: ['a'], prompt: 'y'.repeat(2048), state: 'running', attempt: 2 }], edges: [{ from: 'a', to: 'b' }] };
  const complete = { complete: true, content_token: 'a'.repeat(64), run: structuredClone(expected) };
  assertComplete(complete, expected);
  for (const mutate of [value => value.run.nodes.pop(), value => value.run.nodes[1].depends_on = [],
    value => value.run.nodes[0].prompt = 'x', value => value.run.nodes[1].state = 'pending',
    value => value.run.counts.total = 1, value => value.complete = false,
    value => value.run.nodes[1].id = 'a', value => value.run.edges = []]) {
    const value = structuredClone(complete); mutate(value); assert.throws(() => assertComplete(value, expected));
  }
});
