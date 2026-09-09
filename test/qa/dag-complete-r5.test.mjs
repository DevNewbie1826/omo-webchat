import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareF1Source, rawLoss, taskTransition, rehydrateREST } from './dag-complete-r5.mjs';
import { transcript } from './dag-complete-fixture.mjs';
import { bounded } from './dag-complete-controls.mjs';

test('F1 owned source is first in both source orderings without losing dense topology or fixture lookup', async () => {
  const source = { runId: 'dense-64', runKey: 'dense-64', name: 'dense-64',
    createdAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:01:00Z',
    definition: { nodes: [{ id: 'node-00', dependsOn: [], prompt: 'x'.repeat(2048) }] },
    nodes: [{ id: 'node-00', taskId: 'old', state: 'completed', attempt: 2 }] };
  const original = structuredClone(source), writes = [];
  const earlier = 'a'.repeat(600) + '0';
  const fixture = {
    manifest: { runs: [earlier, 'dense-64', 'history-002'], files: {
      [earlier]: 'record-long.json', 'dense-64': 'record-dense.json', 'history-002': 'record-history.json',
    } },
    source: async id => { assert.equal(id, 'dense-64'); return source; },
    replace: async (id, value) => { writes.push({ path: fixture.manifest.files[id], value: structuredClone(value) }); },
  };
  const next = await prepareF1Source(fixture);
  assert.equal(next.runId, '000-f1-dense-64'); assert.equal(next.runKey, next.runId);
  assert.equal(fixture.manifest.runs[0], next.runId);
  assert.equal(fixture.manifest.runs.length, 3);
  assert.equal(fixture.manifest.files[next.runId], 'record-dense.json');
  assert.equal(fixture.manifest.files['dense-64'], undefined);
  assert.equal(fixture.manifest.files[earlier], 'record-long.json');
  assert.deepEqual(writes, [{ path: 'record-dense.json', value: next }]);
  assert.ok(next.createdAt > original.createdAt); assert.equal(next.updatedAt, next.createdAt);
  assert.equal(Buffer.byteLength(next.nodes[0].taskId), 601);
  assert.deepEqual(next.definition, original.definition);
  assert.deepEqual({ ...next.nodes[0], taskId: 'old' }, original.nodes[0]);
  assert.equal(next.name, original.name); assert.deepEqual(source, original);
});

test('raw loss inputs leave aggregate false and preserve independent parser failure classes', () => {
  const full = { run_id: 'r', counts: { total: 2, running: 2 }, nodes: [
    { id: 'a', prompt: 'a', state: 'running', depends_on: [] },
    { id: 'b', prompt: 'b', state: 'running', depends_on: ['a'] },
  ], edges: [{ from: 'a', to: 'b' }] };
  const original = structuredClone(full);
  const malformed = rawLoss(full, 'malformed');
  assert.equal(malformed.truncated_runs, false); assert.equal(malformed.runs[0].truncated_nodes, false);
  assert.deepEqual(malformed.runs[0].nodes[0], full.nodes[0]);
  assert.equal('depends_on' in malformed.runs[0].nodes[1], false);
  const zero = rawLoss(full, 'zero');
  assert.equal(zero.truncated_runs, false); assert.equal(zero.runs[0].truncated_nodes, false);
  assert.equal(zero.runs[0].nodes.length, 2);
  assert.ok(zero.runs[0].nodes.every(node => !('depends_on' in node)));
  const local = rawLoss(full, 'run-local');
  assert.equal(local.truncated_runs, false); assert.equal(local.runs[0].truncated_nodes, true);
  assert.deepEqual(local.runs[0].counts, { total: 1, running: 1 });
  assert.deepEqual(local.runs[0].nodes, [full.nodes[0]]);
  assert.deepEqual(rawLoss(full, 'lost-run'), { parent_session_id: 'qa-chat', truncated_runs: false, runs: [null] });
  assert.throws(() => rawLoss(full, 'unknown'));
  assert.deepEqual(full, original);
});

test('duplicate raw identities are unflagged independent run/node failures, never two distinct confirmed nodes', () => {
  const full = { run_id: 'r', updated_at: '2026-09-09T14:00:00Z', counts: { total: 2, running: 2 }, nodes: [
    { id: 'a', task_id: 'ta', state: 'running', depends_on: [] },
    { id: 'b', task_id: 'tb', state: 'running', depends_on: ['a'] },
  ], edges: [{ from: 'a', to: 'b' }] };
  const original = structuredClone(full);
  const runs = rawLoss(full, 'duplicate-run');
  assert.equal(runs.truncated_runs, false); assert.equal(runs.runs.length, 2);
  assert.equal(new Set(runs.runs.map(run => run.run_id)).size, 1);
  assert.equal(new Set(runs.runs.map(run => run.updated_at)).size, 1);
  assert.deepEqual(runs.runs.map(run => run.nodes[0].id), ['a', 'b']);
  for (const run of runs.runs) {
    assert.equal(run.truncated_nodes, false); assert.equal(run.nodes.length, 1);
    assert.deepEqual(run.counts, { total: 1, running: 1 });
    assert.deepEqual(run.nodes[0].depends_on, []);
  }
  const nodes = rawLoss(full, 'duplicate-node');
  assert.equal(nodes.truncated_runs, false); assert.equal(nodes.runs.length, 1);
  assert.equal(nodes.runs[0].truncated_nodes, false);
  assert.equal(nodes.runs[0].nodes.length, 2);
  assert.deepEqual(nodes.runs[0].nodes, [full.nodes[0], full.nodes[0]]);
  assert.notEqual(nodes.runs[0].nodes[0], nodes.runs[0].nodes[1]);
  assert.deepEqual(nodes.runs[0].counts, full.counts);
  assert.deepEqual(full, original);
});

test('task transition changes revision and explicit identity authority while preserving the same node and full source', () => {
  const full = { run_id: 'r', name: 'dense', updated_at: '2026-09-09T16:00:00Z', counts: { total: 64, running: 64 },
    nodes: Array.from({ length: 64 }, (_, i) => ({ id: `node-${String(i).padStart(2, '0')}`, label: `label-${i}`,
      task_id: i === 0 ? 't'.repeat(600) + '1' : `task-${i}`, state: 'running', attempt: 2, depends_on: [] })), edges: [] };
  const original = structuredClone(full), { exact, lossy } = taskTransition(full);
  const old = exact.runs[0], next = lossy.runs[0];
  assert.equal(exact.truncated_runs, false); assert.equal(lossy.truncated_runs, false);
  assert.ok(Date.parse(old.updated_at) < Date.parse(next.updated_at));
  assert.equal(next.updated_at, full.updated_at);
  assert.equal(old.run_id, next.run_id); assert.equal(old.nodes[0].id, next.nodes[0].id);
  assert.equal(old.nodes.length, 1); assert.equal(next.nodes.length, 1);
  assert.equal(old.truncated_nodes, true); assert.equal(next.truncated_nodes, true);
  assert.equal(old.nodes[0].task_id, 'previous-attempt-task');
  assert.equal('task_id_truncated' in old.nodes[0], false);
  assert.equal(next.nodes[0].task_id_truncated, true);
  assert.equal(Buffer.byteLength(next.nodes[0].task_id), 512);
  assert.ok(full.nodes[0].task_id.startsWith(next.nodes[0].task_id));
  assert.notEqual(old.nodes[0].task_id, full.nodes[0].task_id);
  assert.notEqual(old.nodes[0].label, next.nodes[0].label);
  assert.deepEqual(next.nodes[0], { ...full.nodes[0], task_id: full.nodes[0].task_id.slice(0, 512), task_id_truncated: true });
  assert.deepEqual(next.counts, full.counts); assert.deepEqual(full, original);
  assert.throws(() => taskTransition({ ...full, nodes: full.nodes.slice(0, 1) }));
});
