import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatServerFrame } from '../../frontend/src/lib/chatWsParse.ts';
import { parseTaskUpdated } from '../../frontend/src/features/split/activityParseTask.ts';
import { stages, summaryInput, summaryFrame, startSummaryFixture } from './dag-summary-fixture.mjs';
import { assertSummaryDOM } from './dag-summary-surface.mjs';
import { parseArgs, run } from './dag-summary.mjs';
import { confirmPortReleased } from './dag-state-ordering.mjs';

const copy = { 'sidebar.tm.runningAgents': 'exact:{n}', 'sidebar.tm.runningAgentsPartial': 'partial:{n}',
  'sidebar.tm.runningAgentsUnknown': 'unknown', 'overview.runningAria': 'exact:{n}',
  'overview.runningAriaPartial': 'partial:{n}', 'overview.runningAriaUnknown': 'unknown' };
const dom = (text, aria) => ({ sidebar: { text, aria }, overview: { text, aria } });

test('summary scenario inputs preserve original running2, retained1, zero-retained and complete topology', () => {
  assert.deepEqual(stages, ['partial-retained1', 'incomplete-retained0', 'malformed-node', 'complete2']);
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
    assert.deepEqual(parsed.snapshots.find(s => s.name === 'omo.dag.updated').data, input.dag);
    const tasks = parseTaskUpdated(input.task).tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'pending');
    assert.equal(tasks[0].liveProgress.lastAssistantLine, input.marker);
    assert.ok(input.dag.runs[0].nodes.every(n => n.task_id !== tasks[0].taskId));
  }
});

test('binary oracle rejects falsely exact partial counts, zero, absent badges and mismatched accessible qualification', () => {
  for (const stage of stages.slice(0, -1)) {
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
