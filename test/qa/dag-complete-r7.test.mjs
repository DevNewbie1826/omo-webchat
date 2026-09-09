import assert from 'node:assert/strict';
import test from 'node:test';
import { mixedTaskCase, assertMixedSubagents, taskHistoryFields } from './dag-complete-r7.mjs';
import { rehydrateREST } from './dag-complete-r5.mjs';
import { transcript } from './dag-complete-fixture.mjs';
import { bounded } from './dag-complete-controls.mjs';
import english from '../../frontend/src/i18n/locales/en.json' with { type: 'json' };

test('F4 mixed wire uses one full task identity and only the same DAG child loses identity authority', () => {
  let sequence = 0;
  for (const taskState of ['running', 'completed']) for (const truncated of [false, true]) {
    const input = mixedTaskCase({ taskState, truncated, sequence: sequence++ });
    const task = input.task.tasks[0], old = input.exact.runs[0], lossy = input.lossy.runs[0], recovered = input.recovered.runs[0];
    assert.equal(input.task.truncated_tasks, false); assert.equal(input.task.tasks.length, 1);
    assert.deepEqual(taskHistoryFields(undefined), {});
    assert.deepEqual(taskHistoryFields(input.task), { task: input.task, task_digest: undefined });
    const wireBody = JSON.parse(JSON.stringify({ task_digest: { tasks: [], truncated: false }, ...taskHistoryFields(input.task) }));
    assert.deepEqual(wireBody, { task: input.task });
    assert.equal(Buffer.byteLength(task.task_id), 601); assert.equal(task.status, taskState);
    assert.equal(old.nodes[0].task_id, task.task_id); assert.equal(recovered.nodes[0].task_id, task.task_id);
    assert.equal(Buffer.byteLength(lossy.nodes[0].task_id), 512);
    assert.equal(lossy.nodes[0].task_id_truncated, true); assert.ok(task.task_id.startsWith(lossy.nodes[0].task_id));
    assert.equal(lossy.truncated_nodes, truncated);
    for (const snapshot of [input.exact, input.lossy, input.recovered]) {
      assert.equal(snapshot.truncated_runs, false); assert.equal(snapshot.runs.length, 1);
      assert.equal(snapshot.runs[0].nodes.length, 1); assert.equal(snapshot.runs[0].nodes[0].state, 'running');
      assert.deepEqual(snapshot.runs[0].counts, { total: 1, running: 1 });
    }
    assert.deepEqual(lossy.nodes[0], { ...old.nodes[0], task_id: task.task_id.slice(0, 512), task_id_truncated: true });
    assert.deepEqual(recovered, { ...old, updated_at: recovered.updated_at });
    assert.ok(Date.parse(old.updated_at) < Date.parse(lossy.updated_at));
    assert.ok(Date.parse(lossy.updated_at) < Date.parse(recovered.updated_at));
    assert.ok(Date.parse(input.baselineTask.tasks[0].updated_at) < Date.parse(task.updated_at));
    assert.equal(input.exactCount, taskState === 'running' ? '1/1' : '0/1');
    assert.equal(input.partialCount, taskState === 'running' ? '1+' : '?');
  }
});

test('mixed count assertion rejects inflated counts, duplicate rows and leaked qualification after recovery', async () => {
  const previous = globalThis.document;
  const state = { count: '1+', rows: ['wire-task'], partial: english['activity.partial'], explanation: english['activity.partial'] };
  globalThis.document = {
    querySelectorAll: () => state.rows.map(textContent => ({ textContent })),
    querySelector: selector => selector.includes('tab-count') ? { textContent: state.count }
      : selector.includes('th-activity-partial') ? state.partial === null ? null : { textContent: state.partial }
      : { getAttribute: key => key === 'aria-selected' ? 'true' : state.explanation },
  };
  const page = { evaluate: async (fn, args) => fn(args), locator: () => ({ count: async () => 0 }) };
  try {
    const expected = { name: 'wire-task', count: '1+', partial: true };
    await assertMixedSubagents(page, expected);
    for (const count of ['2/2', '2+', '1/2', '1+']) {
      state.count = count;
      await assert.rejects(assertMixedSubagents(page, { ...expected, count: '?' }));
    }
    state.count = '1+'; state.rows.push('duplicate');
    await assert.rejects(assertMixedSubagents(page, expected)); state.rows.pop();
    state.count = '0/1';
    await assert.rejects(assertMixedSubagents(page, { ...expected, count: '0/1', partial: false }));
    state.partial = null; state.explanation = null;
    await assertMixedSubagents(page, { ...expected, count: '0/1', partial: false });
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('mixed REST reconnect subscribes before disconnect, preserves incumbent until fulfillment and cleans its route', async () => {
  const input = mixedTaskCase({ taskState: 'completed', truncated: false, sequence: 0 });
  const wire = [], subscriptions = [], timeline = [], order = [];
  let handler, unroute = 0, resolveResponse, rejectResponse;
  const responseReady = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const entries = [...transcript(), { type: 'message', message: { role: 'assistant', content: 'mixed-tail' } }];
  const original = { task: { tasks: [] }, dag: { runs: [] }, task_oversized: false, task_digest: { tasks: [], truncated: false } };
  const emit = row => {
    timeline.push(row);
    for (const subscription of subscriptions) if (subscription.predicate(row)) subscription.resolve(row);
  };
  const observed = { timeline, wait: predicate => new Promise(resolve => { subscriptions.push({ predicate, resolve }); }) };
  const page = {
    route: async (_, next) => { handler = next; order.push('route'); },
    unroute: async (_, current) => { assert.equal(current, handler); unroute++; },
    waitForResponse: () => { order.push('response-subscription'); return responseReady; },
    evaluate: async (_, args) => {
      if (typeof args === 'object') { assert.equal(args.args.marker, 'mixed-tail'); return 1; }
      assert.equal(args, 1); return true;
    },
  };
  let handling;
  const fixture = { transport: { disconnect: id => {
    assert.equal(id, 'qa-chat'); assert.equal(subscriptions.length, 4);
    assert.deepEqual(order, ['route', 'response-subscription']); order.push('disconnect');
    emit({ kind: 'close', socketId: 'old' });
    emit({ direction: 'sent', socketId: 'new', sequence: 1, frame: { type: 'chat.create', chatId: 'qa-chat' } });
    emit({ direction: 'received', socketId: 'new', sequence: 2, frame: { type: 'ready', sessionId: 'qa-chat' } });
    emit({ direction: 'received', socketId: 'new', sequence: 3, frame: { type: 'entries', final: true, sessionId: 'qa-chat', entries } });
    handling = handler({ fetch: async () => ({ status: () => 200, json: async () => original }),
      fulfill: async ({ json }) => {
        assert.equal(order.at(-1), 'incumbent'); order.push('fulfill');
        assert.deepEqual(json.task, input.task); assert.deepEqual(json.dag, input.lossy);
        assert.deepEqual(json.task_digest, taskHistoryFields(input.task).task_digest);
        resolveResponse({ status: () => 200, json: async () => json });
      } });
    handling.catch(rejectResponse);
  } } };
  const result = await bounded(rehydrateREST({ page, observed, fixture, raw: input.lossy, task: input.task, wire,
    beforeFulfill: async () => { assert.equal(order.at(-1), 'disconnect'); order.push('incumbent'); } }), 'mixed REST machinery');
  await handling;
  assert.equal(unroute, 1); assert.equal(result.oldSocket, 'old'); assert.equal(result.socketId, 'new');
  assert.equal(result.tail.marker, 'mixed-tail'); assert.equal(wire.length, 1);
  assert.deepEqual(wire[0].original.task.tasks, []); assert.deepEqual(wire[0].delivered.task, input.task);
});
