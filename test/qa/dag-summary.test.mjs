import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatServerFrame } from '../../frontend/src/lib/chatWsParse.ts';
import { parseTaskUpdated } from '../../frontend/src/features/split/activityParseTask.ts';
import { parseDagUpdated } from '../../frontend/src/features/split/activityParseDag.ts';
import { parseDagDigest } from '../../frontend/src/features/workspace/activityDigest.ts';
import { listLiveSessions } from '../../frontend/src/features/workspace/workspace.ts';
import { stages, summaryInput, summaryFrame, startSummaryFixture, viewports } from './dag-summary-fixture.mjs';
import { assertSummaryDOM } from './dag-summary-surface.mjs';
import { parseArgs, run } from './dag-summary.mjs';
import { confirmPortReleased } from './dag-state-ordering.mjs';

const copy = { 'sidebar.tm.runningAgents': 'exact:{n}', 'sidebar.tm.runningAgentsPartial': 'partial:{n}',
  'sidebar.tm.runningAgentsUnknown': 'unknown', 'overview.runningAria': 'exact:{n}',
  'overview.runningAriaPartial': 'partial:{n}', 'overview.runningAriaUnknown': 'unknown' };
const dom = (text, aria) => ({ sidebar: { text, aria }, overview: { text, aria } });

test('summary scenario inputs preserve original running2, retained1, zero-retained and complete topology', () => {
  assert.deepEqual(stages, ['partial-retained1', 'incomplete-retained0', 'malformed-node', 'complete2',
    'compact-duplicate-ids', 'compact-no-ids', 'complete2-empty-optional-ids', 'compact-mixed-ids',
    'required-empty-run-id', 'required-empty-node-id', 'canceled-retained-running2', 'complete2-recovery']);
  assert.deepEqual(viewports, [{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
  assert.equal(stages.length * viewports.length * 2, 48);
  const partial = summaryInput(stages[0]);
  assert.equal(partial.dag.runs[0].counts.running, 2);
  assert.equal(partial.dag.runs[0].counts.total, 2);
  assert.equal(partial.dag.runs[0].nodes.length, 1);
  assert.equal(partial.dag.truncated_runs, true);
  const empty = summaryInput(stages[1]);
  assert.equal(empty.dag.runs[0].nodes.length, 0);
  assert.equal(empty.dag.runs[0].counts.running, 0);
  assert.equal(empty.dag.truncated_runs, true);
  const malformed = summaryInput(stages[2]);
  assert.equal(malformed.dag.truncated_runs, false);
  assert.equal(malformed.dag.runs[0].nodes.length, 2);
  assert.equal(Object.hasOwn(malformed.dag.runs[0].nodes[1], 'depends_on'), false);
  const full = summaryInput(stages[3]);
  assert.equal(full.dag.truncated_runs, false);
  assert.equal(full.dag.runs[0].counts.running, 2);
  assert.deepEqual(full.dag.runs[0].nodes.map(n => [n.id, n.state, n.depends_on]), [['a', 'running', []], ['b', 'running', ['a']]]);
  partial.dag.runs[0].nodes.length = 0;
  assert.equal(summaryInput(stages[0]).dag.runs[0].nodes.length, 1, 'fresh input per call');
  assert.throws(() => summaryInput('other'));
});

test('marker is accepted by the actual parser and contributes no running task; native frame preserves DAG bytes', () => {
  for (const stage of stages) {
    const input = summaryInput(stage), frame = summaryFrame(stage);
    const parsed = parseChatServerFrame(frame);
    assert.equal(parsed?.type, 'sessions.activity');
    assert.equal(parsed.sessionId, input.id);
    const dag = parsed.snapshots.find(s => s.name === 'omo.dag.updated');
    assert.equal(dag.oversized, input.dag_oversized === true);
    if (input.dag_oversized) {
      assert.equal(Object.hasOwn(dag, 'data'), false, 'compact-only WS must not inject a rich graph');
      assert.deepEqual(parsed.dagDigest, input.dag_digest);
      assert.ok(parseDagDigest(parsed.dagDigest), 'actual compact parser accepts wire shape');
    } else assert.deepEqual(dag.data, input.dag);
    const tasks = parseTaskUpdated(input.task).tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'pending');
    assert.equal(tasks[0].liveProgress.lastAssistantLine, input.marker);
    const ids = input.dag_oversized ? input.dag_digest.runs.flatMap(r => r.running_task_ids)
      : input.dag.runs.flatMap(r => r.nodes.map(n => n.task_id));
    assert.ok(ids.every(id => id !== tasks[0].taskId));
  }
});

test('binary oracle rejects falsely exact partial counts, zero, absent badges and mismatched accessible qualification', () => {
  for (const stage of [...stages.slice(0, 3), 'required-empty-run-id', 'required-empty-node-id']) {
    for (const bad of [dom('1', 'exact:1'), dom('0', 'exact:0'), dom('2', 'exact:2'), dom(null, null), dom('1+', 'exact:1'), dom('?', 'exact:0'), dom('3+', 'partial:3')]) {
      assert.throws(() => assertSummaryDOM(bad, stage, copy));
    }
    for (const good of [dom('?', 'unknown'), dom('1+', 'partial:1'), dom('2+', 'partial:2')]) {
      const result = assertSummaryDOM(good, stage, copy);
      assert.equal(result.sidebar.qualified, true); assert.equal(result.overview.falseExact, false);
    }
  }
  assertSummaryDOM(dom('2', 'exact:2'), 'complete2', copy);
  for (const bad of [dom('1', 'exact:1'), dom('?', 'unknown'), dom('2+', 'partial:2')]) assert.throws(() => assertSummaryDOM(bad, 'complete2', copy));
  assert.throws(() => assertSummaryDOM({ sidebar: dom('2', 'exact:2').sidebar, overview: null }, 'complete2', copy));
});

test('compact stages use actual snake_case poll and camelCase WS digest envelopes without rich topology', async () => {
  const expected = [
    ['compact-duplicate-ids', false, [['task-a', 'task-b'], ['task-a', 'task-b']]],
    ['compact-no-ids', true, [[]]],
    ['compact-mixed-ids', true, [['task-a']]],
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const [stage, truncated, ids] of expected) {
      const input = summaryInput(stage), frame = parseChatServerFrame(summaryFrame(stage));
      assert.equal(input.dag, null); assert.equal(input.dag_oversized, true);
      assert.equal(input.dag_digest.truncated, truncated);
      assert.deepEqual(input.dag_digest.runs.map(r => r.running_task_ids), ids);
      const { marker, ...session } = input;
      globalThis.fetch = async (path, init) => {
        assert.equal(path, '/api/sessions/live'); assert.equal(init.method, 'GET');
        return Response.json({ sessions: [session] });
      };
      const [parsed] = await listLiveSessions();
      assert.equal(parsed.dagOversized, true); assert.equal(parsed.dag, null);
      assert.deepEqual(parsed.dagDigest, parseDagDigest(frame.dagDigest));
      assert.equal(parseTaskUpdated(parsed.task).tasks[0].liveProgress.lastAssistantLine, marker);
    }
  } finally { globalThis.fetch = originalFetch; }
  const recovered = summaryInput('complete2-recovery');
  assert.equal(recovered.dag_oversized, undefined); assert.equal(recovered.dag_digest, undefined);
  assert.equal(recovered.dag.truncated_runs, false); assert.equal(recovered.dag.runs[0].nodes.length, 2);
  assert.ok(recovered.dag.runs[0].updated_at > summaryInput('complete2').dag.runs[0].updated_at);
});

test('compact boundary oracle requires exact2, unknown, qualified1, then exact2 recovery on both surfaces', () => {
  for (const [stage, text, aria] of [
    ['compact-duplicate-ids', '2', 'exact:2'], ['compact-no-ids', '?', 'unknown'],
    ['complete2-empty-optional-ids', '2', 'exact:2'],
    ['compact-mixed-ids', '1+', 'partial:1'], ['complete2-recovery', '2', 'exact:2'],
  ]) {
    const result = assertSummaryDOM(dom(text, aria), stage, copy);
    assert.equal(result.sidebar.falseExact, false); assert.equal(result.overview.impliesZero, false);
    for (const [other, otherAria] of [['0', 'exact:0'], ['1', 'exact:1'], ['4', 'exact:4'],
      ['2', 'exact:2'], ['?', 'unknown'], ['1+', 'partial:1'], ['2+', 'partial:2']]) {
      if (other !== text) assert.throws(() => assertSummaryDOM(dom(other, otherAria), stage, copy));
    }
    assert.throws(() => assertSummaryDOM({ sidebar: { text, aria }, overview: null }, stage, copy));
  }
});

test('rich identity fixtures preserve literal empty IDs through actual REST, WS and DAG parsers', async () => {
  assert.equal(stages[stages.indexOf('compact-no-ids') + 1], 'complete2-empty-optional-ids');
  const originalFetch = globalThis.fetch;
  try {
    for (const stage of ['complete2-empty-optional-ids', 'required-empty-run-id', 'required-empty-node-id']) {
      const { marker, ...session } = summaryInput(stage);
      assert.equal(session.dag_oversized, undefined); assert.equal(session.dag_digest, undefined);
      assert.equal(session.dag.truncated_runs, false);
      const run = session.dag.runs[0];
      assert.equal(run.counts.total, 2); assert.equal(run.counts.running, 2);
      assert.equal(run.nodes.length, 2);
      assert.deepEqual(run.nodes.map(n => n.state), ['running', 'running']);
      assert.equal(run.run_id, stage === 'required-empty-run-id' ? '' : 'summary-run');
      assert.deepEqual(run.nodes.map(n => n.id), ['a', stage === 'required-empty-node-id' ? '' : 'b']);
      assert.deepEqual(run.nodes.map(n => n.depends_on), [[], ['a']]);
      assert.deepEqual(run.edges, [{ from: run.nodes[0].id, to: run.nodes[1].id }]);
      assert.deepEqual(run.waves, [{ index: 0, node_ids: [run.nodes[0].id] }, { index: 1, node_ids: [run.nodes[1].id] }]);
      for (const node of run.nodes) {
        assert.equal(Object.hasOwn(node, 'task_id'), stage === 'complete2-empty-optional-ids');
        if (stage === 'complete2-empty-optional-ids') assert.equal(node.task_id, '');
      }
      globalThis.fetch = async (path, init) => {
        assert.equal(path, '/api/sessions/live'); assert.equal(init.method, 'GET');
        return Response.json({ sessions: [session] });
      };
      const [rest] = await listLiveSessions();
      const ws = parseChatServerFrame(JSON.parse(JSON.stringify(summaryFrame(stage))));
      const wsDag = ws.snapshots.find(s => s.name === 'omo.dag.updated').data;
      assert.deepEqual(rest.dag, session.dag); assert.deepEqual(wsDag, session.dag);
      assert.equal(parseTaskUpdated(rest.task).tasks[0].liveProgress.lastAssistantLine, marker);
      for (const raw of [rest.dag, wsDag]) {
        const parsed = parseDagUpdated(raw).runs[0];
        assert.equal(parsed.runId, run.run_id);
        assert.deepEqual(parsed.nodes.map(n => n.id), run.nodes.map(n => n.id));
        assert.deepEqual(parsed.nodes.map(n => n.taskId), stage === 'complete2-empty-optional-ids' ? ['', ''] : [undefined, undefined]);
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('canceled retained-running input survives actual REST, WS and DAG parsers before active exact2 recovery', async () => {
  assert.deepEqual(stages.slice(-2), ['canceled-retained-running2', 'complete2-recovery']);
  const originalFetch = globalThis.fetch;
  try {
    for (const stage of stages.slice(-2)) {
      const { marker, ...session } = summaryInput(stage), run = session.dag.runs[0];
      assert.equal(run.status, stage === 'canceled-retained-running2' ? 'canceled' : 'running');
      assert.equal(session.dag.truncated_runs, false);
      assert.equal(session.dag_oversized, undefined); assert.equal(session.dag_digest, undefined);
      const full = summaryInput('complete2').dag.runs[0];
      for (const key of ['run_id', 'counts', 'nodes', 'edges', 'waves']) assert.deepEqual(run[key], full[key]);
      globalThis.fetch = async (path, init) => {
        assert.equal(path, '/api/sessions/live'); assert.equal(init.method, 'GET');
        return Response.json({ sessions: [session] });
      };
      const [rest] = await listLiveSessions();
      const ws = parseChatServerFrame(JSON.parse(JSON.stringify(summaryFrame(stage))));
      const wsDag = ws.snapshots.find(s => s.name === 'omo.dag.updated').data;
      assert.deepEqual(rest.dag, session.dag); assert.deepEqual(wsDag, session.dag);
      assert.equal(parseTaskUpdated(rest.task).tasks[0].liveProgress.lastAssistantLine, marker);
      for (const raw of [rest.dag, wsDag]) {
        const parsed = parseDagUpdated(raw);
        assert.equal(parsed.truncatedRuns, false); assert.equal(parsed.runs.length, 1);
        assert.equal(parsed.runs[0].status, run.status);
        assert.equal(parsed.runs[0].counts.running, 2);
        assert.equal(parsed.runs[0].counts.total, 2);
        assert.deepEqual(parsed.runs[0].nodes.map(n => [n.id, n.state, n.dependsOn]),
          [['a', 'running', []], ['b', 'running', ['a']]]);
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('terminal oracle requires mounted sessions with absent badges, never running2 or hidden/zero/unknown badges', () => {
  const stage = 'canceled-retained-running2';
  const zero = { sidebar: null, overview: null, rows: { sidebar: {}, overview: {} } };
  const result = assertSummaryDOM(zero, stage, copy);
  for (const surface of ['sidebar', 'overview']) {
    assert.equal(result[surface].zeroRunning, true); assert.equal(result[surface].exact2, false);
    assert.equal(result[surface].falseExact, false);
    for (const [text, aria] of [['2', 'exact:2'], ['1', 'exact:1'], ['0', 'exact:0'],
      ['?', 'unknown'], ['1+', 'partial:1'], ['2+', 'partial:2'], ['', null]]) {
      assert.throws(() => assertSummaryDOM({ ...zero, [surface]: { text, aria, visible: false } }, stage, copy));
    }
    assert.throws(() => assertSummaryDOM({ ...zero, [surface]: undefined }, stage, copy));
    assert.throws(() => assertSummaryDOM({ ...zero, rows: { ...zero.rows, [surface]: null } }, stage, copy));
  }
  for (const active of stages.filter(value => value !== stage)) {
    assert.throws(() => assertSummaryDOM(zero, active, copy), 'badge absence remains forbidden outside terminal stage');
  }
  assertSummaryDOM(dom('2', 'exact:2'), 'complete2-recovery', copy);
});

test('every stage has a valid strictly increasing revision, including double-digit minutes', () => {
  let previous = -Infinity;
  for (const stage of stages) {
    const input = summaryInput(stage), at = input.task.tasks[0].updated_at;
    const ms = Date.parse(at);
    assert.ok(Number.isFinite(ms)); assert.ok(ms > previous); previous = ms;
    assert.equal(input.dag_oversized ? input.dag_digest.received_at : input.dag.runs[0].updated_at, at);
  }
});

test('CLI accepts only an evidence directory', () => {
  assert.deepEqual(parseArgs(['--evidence-dir', '/tmp/dag-proof']), { evidenceDir: '/tmp/dag-proof' });
  for (const args of [[], ['--evidence-dir'], ['--port', '123'], ['--evidence-dir', '--bad'], ['--evidence-dir', '/tmp/x', '--extra', 'x']]) assert.throws(() => parseArgs(args));
});

function nextFrame(socket, predicate) {
  const controller = new AbortController();
  const promise = new Promise((resolve, reject) => {
    const finish = (error, frame) => { clearTimeout(timer); controller.abort(); error ? reject(error) : resolve(frame); };
    const timer = setTimeout(() => finish(new Error('native fixture frame deadline')), 8000);
    socket.addEventListener('message', event => { const frame = JSON.parse(String(event.data)); if (predicate(frame)) finish(null, frame); }, { signal: controller.signal });
    socket.addEventListener('error', () => finish(new Error('native fixture socket error')), { signal: controller.signal });
  });
  promise.catch(() => {}); return promise;
}

test('isolated fixture serves HTTP and delivers each scenario on its native overview socket, then releases both ports', { timeout: 20000 }, async () => {
  const assets = await mkdtemp(join(tmpdir(), 'dag-summary-test-'));
  let fixture, socket;
  try {
    await writeFile(join(assets, 'index.html'), '<!doctype html><title>fixture</title>');
    fixture = startSummaryFixture({ assetsDir: assets });
    assert.equal((await fetch(fixture.url)).status, 200);
    socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws');
    const hello = nextFrame(socket, f => f.type === 'hello'); await hello;
    const subscribed = fixture.base.wait('frame', f => f.type === 'sessions.subscribe');
    socket.send(JSON.stringify({ type: 'sessions.subscribe', mode: 'all_live' })); await subscribed;
    for (const stage of stages) {
      const frame = summaryFrame(stage), received = nextFrame(socket, f => f.type === 'sessions.activity');
      fixture.overview(frame);
      const wire = await received; assert.deepEqual(wire, frame);
      const parsed = parseChatServerFrame(wire);
      assert.equal(parsed.type, 'sessions.activity');
      if (stage === 'canceled-retained-running2' || stage === 'complete2-recovery') {
        const run = parseDagUpdated(parsed.snapshots.find(s => s.name === 'omo.dag.updated').data).runs[0];
        assert.equal(run.status, stage === 'canceled-retained-running2' ? 'canceled' : 'running');
        assert.equal(run.counts.running, 2);
        assert.deepEqual(run.nodes.map(n => n.state), ['running', 'running']);
      }
    }
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.base.unexpected, []);
  } finally {
    socket?.close();
    if (fixture) {
      const receipt = await fixture.stop(); assert.equal(receipt.pendingWebSockets, 0);
      assert.deepEqual(receipt.errors, []);
      await Promise.all([fixture.url, fixture.base.url].map(url => confirmPortReleased(Number(new URL(url).port))));
    }
    await rm(assets, { recursive: true, force: true });
  }
});

test('runner launch failure is not a product pass and still writes cleanup with released ports and removed temp data', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dag-summary-failure-test-'));
  try {
    const assetsDir = join(directory, 'assets'), evidenceDir = join(directory, 'evidence');
    await mkdir(assetsDir); await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>not product QA</title>');
    await assert.rejects(run({ assetsDir, evidenceDir, chromium: { launchPersistentContext: async () => { throw new Error('intentional launch failure'); } } }), /intentional launch failure/);
    const cleanup = JSON.parse(await readFile(join(evidenceDir, 'cleanup.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(evidenceDir, 'C3-actions.json'), 'utf8'));
    assert.equal(report.passed, false); assert.deepEqual(cleanup.errors, []);
    assert.equal(cleanup.assetsRemoved, true);
    assert.equal(cleanup.cases.length, 1); assert.equal(cleanup.cases[0].profileRemoved, true);
    assert.deepEqual(cleanup.cases[0].portsReleased, [true, true]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
