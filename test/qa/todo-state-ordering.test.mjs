import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProjection, bounded, completion, custom, legacy, parseArgs, phase, startOwnedFixture } from './todo-state-ordering.mjs';

const binding = 'bound-1';
const ready = (phases, source = {}) => ({ type: 'chat.todo', sessionId: 'todo-qa-chat', durableSessionId: 'todo-qa-durable', bindingId: binding,
  requestGeneration: 1, status: 'ready', phases,
  source: { leafId: 'leaf-1', entryId: 'entry-1', entryIndex: 2, kind: 'custom', ...source } });

test('CLI requires explicit candidate binary and evidence paths; rejects ambiguity', () => {
  assert.deepEqual(parseArgs(['--fixture-bin', '/tmp/candidate', '--evidence-dir', '/tmp/evidence']), { fixtureBin: '/tmp/candidate', evidenceDir: '/tmp/evidence' });
  for (const args of [[], ['--evidence-dir', '/tmp/evidence'], ['--fixture-bin'], ['--unknown', 'value'],
    ['--fixture-bin', '/a', '--fixture-bin', '/b', '--evidence-dir', '/e']]) assert.throws(() => parseArgs(args));
});
test('canonical receipt validates exact identities rather than trusting matching todo text', () => {
  const phases = phase('task', 'completed');
  assertProjection(ready(phases), binding, phases);
  for (const [key, value] of [['bindingId', 'old-binding'], ['sessionId', 'other-chat'], ['durableSessionId', 'other-durable'],
    ['type', 'entries'], ['status', 'unavailable'], ['requestGeneration', -1], ['requestGeneration', 0.5], ['requestGeneration', Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => assertProjection({ ...ready(phases), [key]: value }, binding, phases), key);
  }
});
test('source branch indexes describe provenance, not a global monotonic revision', () => {
  const phases = phase('reopened', 'in_progress');
  assertProjection(ready(phases, { leafId: 'older-looking', entryId: 'opaque', entryIndex: 0 }), binding, phases);
  for (const source of [{ kind: 'invented' }, { entryId: null }, { entryIndex: -1 }, { leafId: 12 }]) {
    assert.throws(() => assertProjection(ready(phases, source), binding, phases));
  }
});
test('whole-list equality catches membership loss, rollback, rename loss and clear confusion', () => {
  const phases = [{ name: 'p', tasks: [{ content: 'one', status: 'pending' }, { content: 'two', status: 'completed' }] }];
  for (const received of [phase('one'), phase('renamed'), [], null]) assert.throws(() => assertProjection(ready(received), binding, phases));
  assertProjection(ready([]), binding, []);
  assertProjection(ready([{ name: 'empty', tasks: [] }]), binding, [{ name: 'empty', tasks: [] }]);
  const absent = ready(null, { kind: 'absent', leafId: null, entryId: null, entryIndex: null });
  assertProjection(absent, binding, null);
  assert.throws(() => assertProjection({ ...absent, phases: [] }, binding, []));
});
test('synthetic completion metadata uses the observed transition-array contract', () => {
  const phases = phase('완료 항목', 'completed'), result = completion(phases);
  assert.deepEqual(result.completedTasks, [{ phase: '검증', content: '완료 항목' }]);
  assert.deepEqual(custom(phases), { type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', phases } });
  const persisted = legacy(phases);
  assert.equal(persisted.message.role, 'toolResult'); assert.equal(persisted.message.toolName, 'todo');
  assert.deepEqual(JSON.parse(persisted.message.content[0].text), persisted.message.details);
  assert.deepEqual(persisted.message.details.phases, phases);
});
test('bounded work retains values and failures from the actual completion signal', async () => {
  let resolve;
  const signal = new Promise(done => { resolve = done; });
  const pending = bounded(signal, 'owned signal'); resolve({ completed: true });
  assert.deepEqual(await pending, { completed: true });
  const original = new Error('source failure');
  await assert.rejects(bounded(Promise.reject(original), 'source failure'), error => error === original);
});
test('fixture launch rejects invalid readiness and still collects process exit logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'todo-runner-helper-'));
  try {
    const executable = join(dir, 'invalid-fixture');
    await writeFile(executable, '#!/bin/sh\nprintf "not-json\\n"\n', { mode: 0o700 });
    await assert.rejects(startOwnedFixture(executable, dir), /Invalid fixture readiness JSON|fixture start and cleanup failed/);
    assert.equal(await readFile(join(dir, 'fixture-stdout.log'), 'utf8'), 'not-json\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
