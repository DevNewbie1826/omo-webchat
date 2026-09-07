import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationBarrier, assertProjection, bounded, completion, custom, exactKeyRetention, legacy, parseArgs, phase, startOwnedFixture } from './todo-state-ordering.mjs';
import { observeSockets } from './heartbeat-liveness.mjs';

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

test('application barrier ignores retained DOM, old markers and other sockets until a later same-socket marker renders', async () => {
  const page = new EventEmitter(), observed = observeSockets(page);
  const sockets = [new EventEmitter(), new EventEmitter()];
  for (const socket of sockets) { socket.url = () => 'ws://fixture/chat'; page.emit('websocket', socket); }
  const emit = (socket, frame) => sockets[socket - 1].emit('framereceived', { payload: JSON.stringify(frame) });
  const marker = 'qa-render-barrier', frame = { type: 'tool', sessionId: 'todo-qa-chat', toolCallId: marker, phase: 'end' };
  emit(1, frame); // A pre-existing marker cannot certify a later unavailable frame.
  const after = observed.record({ socketId: 1, direction: 'received', frame: { ...ready(phase('retained')), status: 'unavailable' } });
  let armCalled = false, wireDelivered = false, settled = false;
  const dom = Promise.withResolvers(), checkingDOM = Promise.withResolvers(), published = Promise.withResolvers();
  const pending = applicationBarrier(observed, { after, marker }, {
    arm: async () => { armCalled = true; return { signal: dom.promise }; },
    publish: async () => {
      assert.ok(armCalled, 'DOM subscription precedes provider action');
      emit(2, frame); // Matching text on a different socket is not a barrier.
      emit(1, { ...frame, toolCallId: 'unrelated' });
      published.resolve();
    },
    done: async token => {
      assert.ok(wireDelivered, 'unchanged DOM cannot be checked before the exact wire marker');
      checkingDOM.resolve(); await token.signal;
    },
  });
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([published.promise, pending]);
    assert.equal(settled, false, 'wrong-socket and old markers leave the barrier pending');
    wireDelivered = true; emit(1, frame);
    await Promise.race([checkingDOM.promise, pending]);
    assert.equal(settled, false, 'wire receipt alone is not application/render completion');
    dom.resolve(true);
    const receipt = await pending;
    assert.equal(receipt.socketId, after.socketId); assert.ok(receipt.sequence > after.sequence);
    assert.equal(receipt.frame.toolCallId, marker);
  } finally { dom.resolve(true); observed.stop(); }
});

for (const falseClear of [false, true]) test(`exact-key carrier captures post-barrier state before ${falseClear ? 'rejecting a false clear' : 'accepting retention'}`, async () => {
  const page = new EventEmitter(), observed = observeSockets(page), socket = new EventEmitter();
  socket.url = () => 'ws://fixture/chat'; page.emit('websocket', socket);
  const emit = frame => socket.emit('framereceived', { payload: JSON.stringify(frame) });
  emit(ready(phase('incumbent', 'in_progress')));
  const incumbent = observed.timeline.at(-1), entryId = 'malformed-entry';
  const appended = Promise.withResolvers(), checkingDOM = Promise.withResolvers(), dom = Promise.withResolvers();
  let published = false, domCompleted = false, read = false, proof;
  const pending = exactKeyRetention(observed, incumbent, {
    append: async input => {
      assert.deepEqual(input, { entry: { type: 'custom', customType: 'senpi.todo-state', data: { schema: 'v2', Phases: [] } }, persist: true });
      assert.equal(Object.hasOwn(input.entry.data, 'phases'), false);
      appended.resolve(); return { ok: true, entryId };
    },
    barrier: (after, marker) => {
      assert.ok(published, 'canonical publication precedes the App barrier');
      assert.equal(after.frame.source.leafId, entryId);
      return applicationBarrier(observed, { after, marker }, {
        arm: async () => ({ signal: dom.promise }),
        publish: async () => emit({ type: 'tool', sessionId: 'todo-qa-chat', toolCallId: marker, phase: 'end' }),
        done: async () => { checkingDOM.resolve(); await dom.promise; domCompleted = true; },
      });
    },
    read: async () => { assert.ok(domCompleted); read = true; return falseClear ? [] : incumbent.frame.phases; },
    capture: async value => { assert.ok(read); proof = value; },
  });
  // Capture the outcome immediately so an early assertion cannot be unhandled.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  try {
    await bounded(Promise.race([appended.promise, outcome]), 'malformed append');
    // An unchanged source response is not evidence that the malformed leaf was read.
    emit(incumbent.frame);
    published = true;
    emit({ ...ready(falseClear ? [] : incumbent.frame.phases, {
      leafId: entryId, ...(falseClear ? { entryId } : {}),
    }), requestGeneration: 2 });
    await bounded(Promise.race([checkingDOM.promise, outcome]), 'marker DOM subscription');
    assert.equal(read, false); assert.equal(proof, undefined);
    dom.resolve();
    const result = await bounded(outcome, 'post-barrier retention verdict');
    assert.ok(proof, 'malformed input and actual DOM are captured even on RED');
    assert.deepEqual(proof.input.entry.data, { schema: 'v2', Phases: [] });
    assert.equal(proof.marker.socketId, proof.projection.socketId);
    assert.ok(proof.marker.sequence > proof.projection.sequence);
    assert.deepEqual(proof.retained, falseClear ? [] : incumbent.frame.phases);
    if (falseClear) {
      assert.equal(result.error?.code, 'ERR_ASSERTION');
      assert.deepEqual(result.error.actual, []); assert.deepEqual(result.error.expected, incumbent.frame.phases);
    } else {
      assert.equal(result.error, undefined); assert.equal(result.value, proof.projection);
    }
  } finally { dom.resolve(); observed.stop(); }
});
