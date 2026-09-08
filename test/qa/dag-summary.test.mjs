import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatServerFrame } from '../../frontend/src/lib/chatWsParse.ts';
import { parseTaskUpdated } from '../../frontend/src/features/split/activityParseTask.ts';
import { parseDagDigest } from '../../frontend/src/features/workspace/activityDigest.ts';
import { listLiveSessions } from '../../frontend/src/features/workspace/workspace.ts';
import { stages, summaryInput, summaryFrame, startSummaryFixture } from './dag-summary-fixture.mjs';
import { assertSummaryDOM } from './dag-summary-surface.mjs';
import { parseArgs, run } from './dag-summary.mjs';
import { confirmPortReleased } from './dag-state-ordering.mjs';

const copy = { 'sidebar.tm.runningAgents': 'exact:{n}', 'sidebar.tm.runningAgentsPartial': 'partial:{n}',
  'sidebar.tm.runningAgentsUnknown': 'unknown', 'overview.runningAria': 'exact:{n}',
  'overview.runningAriaPartial': 'partial:{n}', 'overview.runningAriaUnknown': 'unknown' };
const dom = (text, aria) => ({ sidebar: { text, aria }, overview: { text, aria } });

test('summary scenario inputs preserve original running2, retained1, zero-retained and complete topology', () => {
  assert.deepEqual(stages, ['partial-retained1', 'incomplete-retained0', 'malformed-node', 'complete2',
    'compact-duplicate-ids', 'compact-no-ids', 'compact-mixed-ids', 'complete2-recovery']);
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
  for (const stage of stages.slice(0, 3)) {
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
      fixture.overview(frame); assert.deepEqual(await received, frame);
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
