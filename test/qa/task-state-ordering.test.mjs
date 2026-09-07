import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activityPath, chat, createTaskRequestGate, pollPath, startTaskFixture } from './task-state-fixture.mjs';
import { armDOM, assertTaskDOM, doneDOM, overviewFrame, parseArgs, readTaskDOM, taskRow, taskSnapshot, transcript } from './task-state-ordering.mjs';
import { confirmPortReleased, installDOMSignals } from './dag-state-ordering.mjs';
import { observeSockets } from './heartbeat-liveness.mjs';
import { parseChatServerFrame } from '../../frontend/src/lib/chatWsParse.ts';

const output = process.env.QA_HELPER_EVIDENCE;
const save = async (name, body) => { if (output) { await mkdir(output, { recursive: true }); await writeFile(resolve(output, name), JSON.stringify(body, null, 2) + '\n'); } };

test('CLI rejects malformed flags without launching a browser; fixtures retain raw wire provenance', () => {
  assert.deepEqual(parseArgs(['--evidence-dir', '/tmp/proof']), { evidenceDir: '/tmp/proof' });
  for (const args of [[], ['--evidence-dir'], ['--other', 'value'], ['--evidence-dir', '--oops'], ['--evidence-dir', 'x', '--evidence-dir', 'y']]) assert.throws(() => parseArgs(args));
  const row = taskRow('completed', 1, { raw_status: 'running' });
  const frame = overviewFrame([], { snapshots: [{ name: 'omo.task.updated', oversized: true }],
    taskDigest: { tasks: [{ task_id: row.task_id, status: row.status, raw_status: row.raw_status, updated_at: row.updated_at }], truncated: true } });
  const parsed = parseChatServerFrame(frame);
  assert.equal(parsed?.type, 'sessions.activity');
  assert.deepEqual(parsed.taskDigest, frame.taskDigest, 'actual production boundary accepts exact compact correction');
  assert.equal(parseChatServerFrame({ ...frame, sessionId: null }), null, 'null routing identity is invalid at actual boundary');
  assert.equal(transcript().length, 160);
  assert.equal(transcript().at(-1).parentId, 'ordering-entry-158');
});

test('REST and overview markers own their tasks without aliasing the target; explicit durable aliases remain valid', () => {
  const rows = [{ task_id: 'marker-1', status: 'running' }];
  assert.equal(taskSnapshot(rows).parent_session_id, chat);
  assert.equal(taskSnapshot(rows, 'newer').parent_session_id, 'newer');
  for (const identity of [{ sessionId: 'newer', durableSessionId: 'newer' }, { sessionId: 'newer' },
    { sessionId: chat, durableSessionId: 'qa-durable', replacesSessionId: 'qa-durable' }]) {
    const frame = overviewFrame(rows, identity), parsed = parseChatServerFrame(frame);
    assert.equal(parsed?.type, 'sessions.activity');
    assert.equal(parsed.sessionId, identity.sessionId);
    assert.equal(parsed.durableSessionId, identity.durableSessionId ?? identity.sessionId);
    assert.equal(parsed.snapshots[0].data.parent_session_id, parsed.durableSessionId);
    assert.deepEqual(parsed.snapshots[0].data.tasks, rows);
    if (identity.replacesSessionId) assert.equal(parsed.replacesSessionId, identity.replacesSessionId);
  }
});

function route(path, options = {}) {
  const calls = [];
  return { calls, request: () => ({ method: () => options.method ?? 'GET', url: () => `http://127.0.0.1:1234${path}` }),
    fallback: async () => calls.push('fallback'), abort: async () => { calls.push('abort'); await options.abort?.(); },
    fulfill: async body => { calls.push(body); await options.fulfill?.(); } };
}
test('request tokens preserve source path, overlap, unclaimed polls and actual completion', async () => {
  const gate = createTaskRequestGate(), unrelated = route('/api/providers');
  await gate.handle(unrelated); assert.deepEqual(unrelated.calls, ['fallback']);
  const post = route(activityPath, { method: 'POST' }); await gate.handle(post); assert.deepEqual(post.calls, ['fallback']);
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const first = route(activityPath), second = route(activityPath + '?generation=2'), poll = route(pollPath, { fulfill: () => completion });
  const a = gate.next(activityPath), b = gate.next(activityPath);
  const handlers = [gate.handle(poll), gate.handle(first), gate.handle(second)];
  const [tokenA, tokenB] = await Promise.all([a, b]), pollToken = await gate.next(pollPath);
  assert.deepEqual([pollToken, tokenA, tokenB], [1, 2, 3]);
  await gate.release(tokenB, { generation: 2 }); assert.deepEqual(first.calls, []);
  const releasing = gate.release(pollToken, { sessions: [] });
  assert.equal(gate.requests[0].state, 'releasing'); await assert.rejects(gate.release(pollToken, {}));
  finish(); await releasing; await gate.release(tokenA, { generation: 1 }); await Promise.all(handlers);
  assert.equal(JSON.parse(first.calls[0].body).generation, 1); assert.equal(JSON.parse(second.calls[0].body).generation, 2);
  const future = gate.next(pollPath), rejected = assert.rejects(future, /stopped/);
  const receipt = await gate.stop(); await rejected;
  assert.deepEqual(receipt.errors, []); assert.equal(receipt.held, 0); assert.equal(receipt.waiters, 0);
  assert.throws(() => gate.next(pollPath));
});

test('failed fulfillment and abort remain observable while every route is drained', async () => {
  const gate = createTaskRequestGate(), bad = route(activityPath, { fulfill: () => { throw new Error('fulfill failed'); }, abort: () => { throw new Error('abort failed'); } });
  const next = gate.next(activityPath), handler = gate.handle(bad), token = await next;
  await assert.rejects(gate.release(token, {}), /fulfill failed/); assert.equal(gate.requests[0].state, 'held');
  const receipt = await gate.stop(); await handler;
  assert.equal(receipt.errors.length, 1); assert.equal(receipt.errors[0].token, token); assert.equal(receipt.held, 0);
  assert.equal(receipt.requests[0].state, 'abort-failed');
});

test('actual Chrome native socket forwarding preserves overview identity, channel isolation and reconnect history', { timeout: 30_000 }, async () => {
  assert.ok(globalThis.Bun, 'Run this helper suite with bun test');
  const assetsDir = await mkdtemp(join(tmpdir(), 'task-native-helper-'));
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><html><body>native transport helper</body></html>');
  const fixture = startTaskFixture({ assetsDir, layout: 'single', runs: { [chat]: { entries: transcript() } } });
  let browser, context, observed;
  const cleanup = {};
  try {
    assert.deepEqual(await (await fetch(fixture.url + '/api/providers')).json(), [{ id: 'omo', label: 'omo', available: true }]);
    const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href);
    browser = await chromium.launch({ executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    context = await browser.newContext(); const page = await context.newPage(); observed = observeSockets(page);
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    const subscription = fixture.base.wait('frame', frame => frame.type === 'sessions.subscribe' && frame.mode === 'all_live');
    const final = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final);
    await page.evaluate(chat => {
      const connect = mode => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v2/ws');
        socket.addEventListener('message', event => { const frame = JSON.parse(event.data);
          if (frame.type === 'hello') { socket.send(JSON.stringify({ type: 'hello', version: 2 }));
            socket.send(JSON.stringify(mode === 'overview' ? { type: 'sessions.subscribe', mode: 'all_live' } : { type: 'chat.create', wsId: 'ws', chatId: chat })); }
        });
        return socket;
      };
      window.overviewSocket = connect('overview'); window.chatSocket = connect('chat');
    }, chat);
    await subscription; const original = await final;
    assert.equal(original.frame.entries.length, 160);
    const correction = overviewFrame([taskRow('completed', 1, { raw_status: 'running' })]);
    const after = observed.mark(), received = observed.wait(row => row.direction === 'received' && row.frame?.type === 'sessions.activity', { after });
    fixture.overview(correction); const receipt = await received;
    assert.deepEqual(receipt.frame, correction); assert.notEqual(receipt.socketId, original.socketId);
    // A reply on the chat hop crosses a real transport barrier after publication.
    const pong = observed.wait(row => row.direction === 'received' && row.socketId === original.socketId && row.frame?.type === 'pong', { after });
    await page.evaluate(() => window.chatSocket.send(JSON.stringify({ type: 'ping' }))); await pong;
    assert.equal(observed.timeline.filter(row => row.sequence > after && row.socketId === original.socketId && row.frame?.type === 'sessions.activity').length, 0);
    const marker = 'committed-task-helper-marker', message = observed.wait(row => row.direction === 'received' && row.frame?.message?.content === marker);
    fixture.deliver(chat, { type: 'message', message: { role: 'assistant', content: marker } }); await message;
    const closed = observed.wait(row => row.kind === 'close' && row.socketId === original.socketId);
    fixture.disconnect(chat); await closed;
    const reconnected = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final);
    await page.evaluate(chat => {
      const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v2/ws');
      socket.addEventListener('message', event => { if (JSON.parse(event.data).type === 'hello') socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: chat })); });
      window.chatSocket = socket;
    }, chat);
    const replay = await reconnected;
    assert.notEqual(replay.socketId, original.socketId); assert.equal(replay.frame.entries.length, 161);
    assert.equal(replay.frame.entries.at(-1).message.content, marker);
    assert.deepEqual(fixture.errors, []); assert.deepEqual(fixture.base.unexpected, []);
    await save('native-helper-receipts.json', { correction, received: receipt, initialSocket: original.socketId, reconnectSocket: replay.socketId,
      timeline: observed.timeline, fixture: fixture.traffic });
  } finally {
    await save('native-helper-final-traffic.json', { timeline: observed?.timeline ?? [], fixture: fixture.traffic });
    observed?.stop(); if (context) await context.close(); if (browser) { await browser.close(); cleanup.browserClosed = !browser.isConnected(); }
    cleanup.fixture = await fixture.stop();
    cleanup.portsReleased = await Promise.all([fixture.url, fixture.base.url].map(url => confirmPortReleased(Number(new URL(url).port))));
    await save('native-helper-cleanup.json', cleanup);
    await rm(assetsDir, { recursive: true, force: true });
    assert.equal(cleanup.fixture.pendingWebSockets, 0); assert.deepEqual(cleanup.fixture.errors, []);
  }
});

test('real Chrome request barriers and DOM probes fail on rollback, count mismatch and wrong permanent tab', { timeout: 30_000 }, async () => {
  const assetsDir = await mkdtemp(join(tmpdir(), 'task-dom-helper-'));
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><html><body><div class="th-chat-body">ordering-entry-159</div><div class="th-chat-input"><textarea></textarea></div></body></html>');
  const fixture = startTaskFixture({ assetsDir, layout: 'single' }), gate = createTaskRequestGate();
  let browser, page;
  try {
    const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href);
    browser = await chromium.launch({ executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    page = await browser.newPage(); await installDOMSignals(page);
    await page.route('**/api/**', gate.handle); await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.__dagQA.done(window.__dagQA.initial));
    const activity = gate.next(activityPath), polling = gate.next(pollPath);
    const signal = await armDOM(page, () => !!document.querySelector('output[data-source="poll"]'));
    await page.evaluate(paths => { window.responses = []; window.fetches = paths.map(path => fetch(path).then(r => r.json()).then(body => {
      window.responses.push(body); const out = document.createElement('output'); out.dataset.source = body.source; document.body.append(out);
    })); }, [activityPath, pollPath]);
    const [activityToken, pollToken] = await Promise.all([activity, polling]);
    assert.deepEqual(await page.evaluate(() => window.responses), []);
    await gate.release(pollToken, { source: 'poll' }); await doneDOM(page, signal);
    assert.deepEqual(await page.evaluate(() => window.responses), [{ source: 'poll' }]);
    await gate.release(activityToken, { source: 'activity' }); await page.evaluate(() => Promise.all(window.fetches));
    assert.deepEqual(await page.evaluate(() => window.responses), [{ source: 'poll' }, { source: 'activity' }]);
    await page.evaluate(name => {
      document.body.insertAdjacentHTML('beforeend', `<div class="th-sidebar"><div class="th-tree-node"><button class="th-tree-activation"><span class="th-tree-label">Stored A</span></button></div></div>
        <button data-activity-tab="agents" aria-selected="true"><span class="th-activity-tab-count">0/2</span></button>
        <div data-activity-tabpanel="agents"><li class="th-activity-agent"><span class="th-activity-agent-name"></span><span class="th-activity-chip th-activity-chip--ok"></span><span class="th-activity-agent-tool">native-tool-marker</span></li>
        <li class="th-activity-agent"><span class="th-activity-agent-name">rest-marker</span><span class="th-activity-chip th-activity-chip--muted"></span></li></div>`);
      document.querySelector('.th-activity-agent-name').textContent = name;
    }, taskRow('completed', 1).name);
    const good = await page.evaluate(readTaskDOM); assertTaskDOM(good, 'completed', { tool: 'native-tool-marker' });
    await page.evaluate(() => document.querySelector('.th-activity-chip').className = 'th-activity-chip th-activity-chip--running');
    const rollback = await page.evaluate(readTaskDOM); assert.throws(() => assertTaskDOM(rollback, 'completed'));
    await page.evaluate(() => { document.querySelector('.th-activity-chip').className = 'th-activity-chip th-activity-chip--ok';
      document.querySelector('.th-tree-node').insertAdjacentHTML('beforeend', '<span class="th-tree-running">1</span>'); });
    const mismatch = await page.evaluate(readTaskDOM); assert.throws(() => assertTaskDOM(mismatch, 'completed'));
    await page.evaluate(() => { document.querySelector('.th-tree-running').remove(); document.querySelector('[data-activity-tab="agents"]').setAttribute('aria-selected', 'false'); });
    const wrongTab = await page.evaluate(readTaskDOM); assert.throws(() => assertTaskDOM(wrongTab, 'completed'));
    await save('dom-helper-receipts.json', { good, rollback, mismatch, wrongTab, requests: gate.requests });
    assert.equal(await page.evaluate(() => window.__dagQA.stop()), 0);
  } finally {
    const routes = await gate.stop(); if (browser) await browser.close();
    const stopped = await fixture.stop();
    const portsReleased = await Promise.all([fixture.url, fixture.base.url].map(url => confirmPortReleased(Number(new URL(url).port))));
    await save('dom-helper-cleanup.json', { routes, stopped, portsReleased });
    await rm(assetsDir, { recursive: true, force: true });
    assert.deepEqual(routes.errors, []); assert.deepEqual(stopped.errors, []);
  }
});
