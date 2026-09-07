/** Real Go server + real Google Chrome heartbeat QA. No WebSocket replacement,
 * timer overrides, synthetic application pings in C1/C2, or user-state access.
 * Runtime is started separately; this runner owns its fresh browser context,
 * fixture barriers, and API-created metadata. See qa-harness.md for launch.
 */
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export const scenarios = Object.freeze(['C3', 'C1', 'C2', 'long-transcript']);
const deadline = 10_000;
const transcriptCount = 240;

// Passive Playwright protocol observations preserve the browser's native socket.
// Sequence boundaries make already-delivered events safe to consume without
// subscribing late or mistaking the app's sessions.activity socket for chat.
export function observeSockets(page) {
  const timeline = [], sockets = [], pending = new Set();
  function record(event) {
    const row = { sequence: timeline.length + 1, at: new Date().toISOString(), ms: performance.now(), ...event };
    timeline.push(row);
    for (const waiter of [...pending]) waiter.check(row);
    return row;
  }
  const onSocket = socket => {
    const id = sockets.length + 1;
    sockets.push({ id, socket });
    record({ kind: 'socket', socketId: id, url: socket.url() });
    for (const [event, direction] of [['framesent', 'sent'], ['framereceived', 'received']]) {
      socket.on(event, ({ payload }) => {
        const raw = String(payload);
        let frame;
        try { frame = JSON.parse(raw); } catch { frame = null; }
        record({ kind: 'frame', socketId: id, direction, raw, frame });
      });
    }
    socket.on('close', () => record({ kind: 'close', socketId: id }));
    socket.on('socketerror', error => record({ kind: 'socketerror', socketId: id, error: String(error) }));
  };
  page.on('websocket', onSocket);
  function wait(predicate, { after = timeline.length, timeout = deadline, label = 'socket event' } = {}) {
    let cancel;
    const promise = new Promise((resolveWait, reject) => {
      let timer;
      const finish = (error, row) => {
        clearTimeout(timer); pending.delete(waiter);
        error ? reject(error) : resolveWait(row);
      };
      const waiter = { check(row) {
        if (row.sequence <= after) return;
        try { if (predicate(row)) finish(null, row); } catch (error) { finish(error); }
      } };
      cancel = () => finish(new Error(`Cancelled: ${label}`));
      waiter.cancel = cancel;
      pending.add(waiter);
      timer = setTimeout(() => finish(new Error(`Timed out (${timeout}ms): ${label}`)), timeout);
      for (const row of timeline) {
        if (!pending.has(waiter)) break;
        waiter.check(row);
      }
    });
    // A sibling action may fail before its pre-armed waiter is awaited. Keep
    // rejection handled, but preserve it for the caller and teardown receipt.
    promise.catch(() => {});
    promise.cancel = cancel;
    return promise;
  }
  return {
    timeline, sockets, record, wait,
    mark: () => timeline.length,
    stop() { page.off('websocket', onSocket); for (const waiter of [...pending]) waiter.cancel(); },
  };
}

// DOM readiness is mutation/scroll driven, never a polling interval. Arm before
// the UI action; evaluate returns an id rather than blocking the action itself.
async function armDOM(page, source, args = null) {
  return page.evaluate(({ source, args, deadline }) => {
    const predicate = (0, eval)(`(${source})`);
    window.__heartbeatDOM ??= new Map();
    const id = (window.__heartbeatDOMNext = (window.__heartbeatDOMNext ?? 0) + 1);
    const promise = new Promise((resolveWait, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); observer.disconnect(); document.removeEventListener('scroll', check, true);
        error ? reject(error) : resolveWait(true);
      };
      const check = () => { try { if (predicate(args)) finish(); } catch (error) { finish(error); } };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener('scroll', check, true);
      timer = setTimeout(() => finish(new Error(`DOM signal timed out: ${source}`)), deadline);
      check();
    });
    promise.catch(() => {});
    window.__heartbeatDOM.set(id, promise);
    return id;
  }, { source: String(source), args, deadline });
}
async function doneDOM(page, id) {
  await page.evaluate(async id => {
    try { await window.__heartbeatDOM.get(id); } finally { window.__heartbeatDOM.delete(id); }
  }, id);
}
const composerReady = () => {
  const node = document.querySelector('.th-chat-input textarea');
  return !!node && !node.disabled && node.getBoundingClientRect().height > 0;
};
const isFrame = (row, direction, type) => row.kind === 'frame' && row.direction === direction && row.frame?.type === type;
const isCreate = chat => row => isFrame(row, 'sent', 'chat.create') && row.frame.chatId === chat.id;

async function jsonRequest(request, url, method = 'GET', data) {
  const response = await request.fetch(url, { method, ...(data === undefined ? {} : { data }), timeout: 35_000 });
  const raw = await response.text();
  assert.ok(response.ok(), `${method} ${url}: ${response.status()} ${raw}`);
  return raw ? JSON.parse(raw) : null;
}

async function chromeDriver() {
  const candidates = [process.env.QA_PLAYWRIGHT,
    resolve('node_modules/playwright-core/index.mjs'), resolve('frontend/node_modules/playwright-core/index.mjs'),
    '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs', '/private/tmp/zcode-asar/node_modules/playwright-core/index.mjs'].filter(Boolean);
  for (const path of candidates) {
    try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    return (await import(pathToFileURL(path).href)).chromium;
  }
  throw new Error('Set QA_PLAYWRIGHT to an existing playwright-core/index.mjs (no dependencies are installed by this runner)');
}

function assertHeld(observed, socketId, chat, from) {
  const rows = observed.timeline.filter(row => row.sequence > from);
  assert.equal(rows.filter(isCreate(chat)).length, 1, 'exactly one chat.create for this attempt');
  assert.ok(!rows.some(row => row.socketId === socketId && ['close', 'socketerror'].includes(row.kind)), 'same chat socket stays open');
  assert.ok(!rows.some(row => row.socketId === socketId && isFrame(row, 'received', 'ready')), 'no ready while open is held');
  assert.ok(!rows.some(row => row.socketId === socketId && isFrame(row, 'received', 'error')), 'no opening error');
}

async function naturalHeartbeats(observed, socketId, from, count) {
  const cycles = [];
  let after = from;
  const healthy = row => {
    if (row.socketId !== socketId) return false;
    if (['close', 'socketerror'].includes(row.kind) || isFrame(row, 'received', 'ready') || isFrame(row, 'received', 'error')) {
      throw new Error(`Held socket changed before release: ${JSON.stringify(row)}`);
    }
    return true;
  };
  for (let index = 0; index < count; index++) {
    const ping = await observed.wait(row => healthy(row) && isFrame(row, 'sent', 'ping'),
      { after, timeout: 25_000, label: `natural ping ${index + 1} on chat socket ${socketId}` });
    const remaining = deadline - (performance.now() - ping.ms);
    assert.ok(remaining > 0, 'pong deadline was not extended');
    const pong = await observed.wait(row => healthy(row) && isFrame(row, 'received', 'pong'),
      { after: ping.sequence, timeout: remaining, label: `pong ${index + 1} within unchanged 10s deadline` });
    assert.ok(pong.ms - ping.ms < deadline, 'pong within 10 seconds');
    const previous = cycles.at(-1)?.ping ?? observed.timeline.find(row => row.kind === 'socket' && row.socketId === socketId);
    assert.ok(ping.ms - previous.ms >= 19_000, 'natural 20s heartbeat cadence, not an injected ping');
    cycles.push({ ping, pong, latencyMs: pong.ms - ping.ms });
    after = pong.sequence;
  }
  return cycles;
}

function readySignals(observed, socketId, chat, after, requireEntries = true) {
  const next = type => row => {
    if (row.socketId !== socketId) return false;
    if (['close', 'socketerror'].includes(row.kind) || isFrame(row, 'received', 'error')) throw new Error(JSON.stringify(row));
    return isFrame(row, 'received', type) && row.frame.sessionId === chat.id && (type !== 'entries' || row.frame.final === true);
  };
  const signals = Promise.all([
    observed.wait(next('ready'), { after, label: `ready for ${chat.id} on socket ${socketId}` }),
    ...(requireEntries ? [observed.wait(next('entries'), { after, label: `final entries for ${chat.id} on socket ${socketId}` })] : []),
  ]);
  signals.catch(() => {});
  return signals;
}

async function nativeContracts(page) {
  // This code constructs Chrome's real same-origin native WebSocket. It never
  // replaces window.WebSocket and receives every reply from the Go bridge.
  return page.evaluate(async deadline => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/v2/ws`);
    const frames = [];
    let expected = null;
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      frames.push({ direction: 'received', raw: event.data, frame, ms: performance.now() });
      if (frame.type === 'hello') return;
      if (!expected) return;
      const waiting = expected; expected = null; clearTimeout(waiting.timer);
      if (frame.type !== waiting.type || (waiting.type === 'error' && frame.code !== 'bad_frame')) {
        waiting.reject(new Error(`Unexpected native reply: ${event.data}`));
      } else waiting.resolve(frame);
    });
    const once = (event, action) => new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener(event, done); reject(new Error(`Native ${event} timeout`)); }, deadline);
      const done = value => { clearTimeout(timer); resolveWait(value); };
      socket.addEventListener(event, done, { once: true });
      action?.();
    });
    const exchange = (raws, type) => new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => { expected = null; reject(new Error(`Native ${type} timeout`)); }, deadline);
      expected = { type, resolve: resolveWait, reject, timer };
      for (const raw of raws) {
        frames.push({ direction: 'sent', raw, ms: performance.now() });
        socket.send(raw);
      }
    });
    try {
      await once('open');
      await exchange(['{"type":"ping"}'], 'error');
      await exchange(['{"type":"chat.create","wsId":"qa-prehello","chatId":"qa-prehello"}'], 'error');
      await exchange(['{"type":"hello","version":99}'], 'error');
      await exchange(['{"type":"ping"}'], 'error');
      await exchange(['{"type":"hello","version":2}', '{"type":"ping"}'], 'pong');
      await exchange(['{"type":"ping"'], 'error');
      await exchange(['null'], 'error');
      await exchange(['{"type":["ping"]}'], 'error');
      await exchange(['{"type":"ping"}'], 'pong');
      await once('close', () => socket.close(1000, 'QA complete'));
      return frames;
    } finally {
      if (expected) { clearTimeout(expected.timer); expected = null; }
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
  }, deadline);
}

/** Runs against already-started isolated idlefixture/app. Optional chromium or
 * browser lets a lead call this from eval; caller-owned browsers are not closed.
 * Every run creates and closes its own context. C3 can run alone; long-transcript
 * requires C1 or C2 in the same run to supply the fixture chat.
 */
export async function runHeartbeatLiveness({
  appURL = 'http://127.0.0.1:25025', fixtureURL = 'http://127.0.0.1:25024',
  evidenceDir, password = 'heartbeat-qa-only', fixtureRoot,
  chromium, browser: suppliedBrowser, headless = true, only = scenarios,
} = {}) {
  assert.ok(evidenceDir, 'evidenceDir is required');
  assert.ok(fixtureRoot, 'fixtureRoot is required: explicit isolated runtime ownership');
  for (const [url, port] of [[appURL, '25025'], [fixtureURL, '25024']]) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.port, port, 'reserved isolated QA ports only');
  }
  assert.ok(only.every(name => scenarios.includes(name)), `Unknown scenario: ${only}`);
  assert.ok(!only.includes('long-transcript') || only.includes('C1') || only.includes('C2'), 'long-transcript needs C1 or C2');
  await mkdir(evidenceDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), appURL, fixtureURL, fixtureRoot, scenarios: {}, screenshots: [], cleanup: {} };
  let browser, context, page, observed, workspace, initial, failure;
  const barriers = new Set();
  const cleanupErrors = [];
  const save = (name, data) => writeFile(resolve(evidenceDir, name), JSON.stringify(data, null, 2) + '\n');
  let control, api;
  async function shot(name) {
    const filename = `${name}.png`;
    await page.screenshot({ path: resolve(evidenceDir, filename), fullPage: false });
    report.screenshots.push({ filename, viewport: page.viewportSize() });
  }
  async function armOpen(path) {
    const { token } = await control('/open-barrier/arm', { path });
    assert.ok(token); barriers.add(token); return token;
  }
  async function release(token) {
    observed.record({ kind: 'barrier-release-request', token });
    const result = await control('/open-barrier/release', { token });
    barriers.delete(token); observed.record({ kind: 'barrier-released', token, result });
  }
  const snapshot = async label => {
    const value = await control('/state');
    observed.record({ kind: 'fixture-state', label, value }); return value;
  };
  async function select(chat) {
    const persisted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/layout'
      && response.request().method() === 'PUT', { timeout: deadline });
    persisted.catch(() => {});
    await page.locator('.th-tree-activation').filter({ hasText: new RegExp(`^${chat.name}$`) }).click();
    assert.ok((await persisted).ok(), 'selected layout persisted before navigation');
  }
  async function opened(socketId, chat, token) {
    const after = observed.mark();
    const signals = readySignals(observed, socketId, chat, after);
    const dom = await armDOM(page, composerReady);
    await release(token);
    const [ready, entries] = await signals;
    await doneDOM(page, dom);
    assert.equal(observed.sockets.find(row => row.id === socketId).socket.isClosed(), false);
    assert.equal(ready.frame.resumed, true, 'held open resumes a saved transcript');
    const pages = observed.timeline.filter(row => row.sequence > after && row.socketId === socketId && isFrame(row, 'received', 'entries'));
    assert.equal(pages.filter(row => row.frame.final).length, 1);
    assert.equal(pages.reduce((count, row) => count + row.frame.entries.length, 0), transcriptCount, 'complete saved history, not just an empty final sentinel');
    await doneDOM(page, await armDOM(page, count => document.querySelector('.th-chat-body')?.textContent.includes(`fixture-entry-${count}`), transcriptCount));
    return { ready, entries, historyEntryCount: transcriptCount };
  }
  async function seedSavedChat(chat, label) {
    const from = observed.mark();
    const create = observed.wait(isCreate(chat), { after: from, label: `${label} seed chat.create` });
    await select(chat);
    const sent = await create;
    const [ready] = await readySignals(observed, sent.socketId, chat, sent.sequence, false);
    assert.equal(ready.frame.resumed, false, 'fresh seed needs ready, not automatic history');
    await doneDOM(page, await armDOM(page, composerReady));
    const state = await snapshot(`${label}-seed-ready`);
    const session = state.sessions.find(row => row.durableId === ready.frame.piSessionId);
    assert.ok(session?.live, 'fresh seed created its isolated durable session');
    await control('/history', { path: session.path, count: transcriptCount });
    const closed = observed.wait(row => row.kind === 'close' && row.socketId === sent.socketId, { label: `${label} seed socket closed` });
    await page.goto('about:blank'); await closed;
    await control('/silent', { path: session.path });
    const unloaded = await snapshot(`${label}-seed-unloaded`);
    const saved = unloaded.sessions.find(row => row.path === session.path);
    assert.equal(saved.live, false); assert.equal(saved.entryCount, transcriptCount);
    return { socketId: sent.socketId, sessionPath: session.path, durableId: session.durableId, unloaded };
  }
  try {
    browser = suppliedBrowser ?? await (chromium ?? await chromeDriver()).launch({
      executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless, timeout: deadline,
    });
    report.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(deadline);
    page = await context.newPage(); observed = observeSockets(page);
    control = (path, data) => jsonRequest(context.request, fixtureURL + path, data === undefined ? 'GET' : 'POST', data);
    api = (path, method = 'GET', data) => jsonRequest(context.request, appURL + path, method, data);
    initial = await snapshot('initial');
    assert.equal(resolve(initial.root), resolve(fixtureRoot), 'fixture root must match explicitly supplied isolated root');
    assert.deepEqual(initial.sessions, [], 'fresh fixture, not saved user sessions');
    assert.equal(initial.openCount, 0); assert.equal(initial.openRequestCount, 0); assert.equal(initial.closeCount, 0);
    report.initial = initial;
    await page.goto(appURL, { waitUntil: 'domcontentloaded' });
    await page.locator('#th-password').fill(password);
    const login = page.waitForResponse(response => new URL(response.url()).pathname === '/api/login' && response.request().method() === 'POST');
    await page.locator('.th-login form button[type="submit"]').click();
    assert.ok((await login).ok(), 'real login succeeds');
    assert.deepEqual(await api('/api/workspaces'), [], 'fresh isolated app state required');
    if (only.includes('C3')) {
      const before = await snapshot('C3-before');
      const frames = await nativeContracts(page);
      const received = frames.filter(row => row.direction === 'received' && row.frame.type !== 'hello');
      assert.deepEqual(received.map(row => row.frame.type), ['error', 'error', 'error', 'error', 'pong', 'error', 'error', 'error', 'pong']);
      assert.ok(received.filter(row => row.frame.type === 'error').every(row => row.frame.code === 'bad_frame'));
      const after = await snapshot('C3-after');
      assert.equal(after.openRequestCount, before.openRequestCount, 'guard frames never open a provider route');
      assert.equal(after.promptCount, 0);
      report.scenarios.C3 = { passed: true, before, after, frames };
      await save('C3-native-frames.json', frames); await shot('C3-native-contracts-1440x1000');
    }
    const chats = {};
    if (only.some(name => name !== 'C3')) {
      workspace = await api('/api/workspaces', 'POST', { name: 'Heartbeat QA', path: initial.workspaceA });
      for (const name of ['C1', 'C2'].filter(name => only.includes(name))) {
        chats[name] = await api(`/api/workspaces/${workspace.id}/chats`, 'POST', { name: name === 'C1' ? 'Held open chat' : 'Pending prior open chat', provider: 'omo' });
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      const workspaceNode = page.locator('.th-tree-workspace').filter({ has: page.locator('.th-tree-activation', { hasText: /^Heartbeat QA$/ }) });
      const chevron = workspaceNode.locator('.th-tree-chevron');
      if (await chevron.getAttribute('aria-expanded') !== 'true') await chevron.click();
      report.metadata = { workspace, chats };
    }
    let transcriptChat;
    if (only.includes('C1')) {
      const chat = chats.C1, seed = await seedSavedChat(chat, 'C1');
      const before = await snapshot('C1-before'), from = observed.mark();
      const token = await armOpen(seed.sessionPath);
      const parked = control('/open-barrier/await', { token }); parked.catch(() => {});
      const create = observed.wait(isCreate(chat), { after: from, label: 'actual C1 chat.create socket' });
      await page.goto(appURL, { waitUntil: 'domcontentloaded' });
      const sent = await create; assert.equal((await parked).parked, true);
      const socketId = sent.socketId;
      const cycles = await naturalHeartbeats(observed, socketId, sent.sequence, 2);
      assertHeld(observed, socketId, chat, from);
      const held = await snapshot('C1-two-natural-pongs-held');
      assert.equal(held.openRequestCount, before.openRequestCount + 1);
      assert.equal(held.openCount, before.openCount);
      await shot('C1-held-two-natural-pongs-1440x1000');
      assertHeld(observed, socketId, chat, from);
      report.scenarios.C1 = { passed: false, phase: 'two-natural-pongs-held', seed, socketId, cycles, before, held };
      const ready = await opened(socketId, chat, token);
      assert.equal(observed.timeline.filter(row => row.sequence > from).filter(isCreate(chat)).length, 1);
      const after = await snapshot('C1-ready');
      assert.equal(after.openCount, before.openCount + 1); assert.equal(after.promptCount, 0);
      report.scenarios.C1 = { passed: true, seed, socketId, cycles, before, held, after, ...ready };
      await shot('C1-ready-composer-1440x1000'); transcriptChat = chat;
    }
    if (only.includes('C2')) {
      const chat = chats.C2, seed = await seedSavedChat(chat, 'C2');
      const before = await snapshot('C2-before'), from = observed.mark();
      const token = await armOpen(seed.sessionPath);
      const parked = control('/open-barrier/await', { token }); parked.catch(() => {});
      const firstCreate = observed.wait(isCreate(chat), { after: from, label: 'C2 first chat.create socket' });
      await page.goto(appURL, { waitUntil: 'domcontentloaded' });
      const first = await firstCreate; assert.equal((await parked).parked, true);
      const closed = observed.wait(row => row.kind === 'close' && row.socketId === first.socketId, { label: 'cancelled first socket' });
      await page.goto('about:blank'); await closed;
      const replacementFrom = observed.mark();
      const replacementCreate = observed.wait(isCreate(chat), { after: replacementFrom, label: 'C2 replacement chat.create socket' });
      await page.goto(appURL, { waitUntil: 'domcontentloaded' });
      const replacement = await replacementCreate;
      assert.notEqual(replacement.socketId, first.socketId);
      const cycles = await naturalHeartbeats(observed, replacement.socketId, replacement.sequence, 1);
      assertHeld(observed, replacement.socketId, chat, replacementFrom);
      const held = await snapshot('C2-replacement-pong-prior-open-held');
      // If the replacement had entered the provider's same saved-path barrier,
      // this count would be +2. +1 proves it is still waiting on the first open.
      assert.equal(held.openRequestCount, before.openRequestCount + 1, 'replacement waits before a second provider open');
      assert.equal(held.openCount, before.openCount); assert.equal(held.closeCount, before.closeCount);
      await shot('C2-replacement-pong-held-1440x1000');
      assertHeld(observed, replacement.socketId, chat, replacementFrom);
      const lateClose = control('/close/await', { count: before.closeCount + 1 }).then(value => {
        observed.record({ kind: 'close-completion', value }); return value;
      });
      lateClose.catch(() => {});
      const ready = await opened(replacement.socketId, chat, token);
      const closeCompletion = await lateClose;
      const after = await snapshot('C2-replacement-ready-after-late-close');
      assert.equal(after.closeCount, before.closeCount + 1, 'exactly one late close completed');
      assert.equal(after.openCount, before.openCount + 2, 'one cancelled route and one replacement');
      assert.equal(after.openRequestCount, before.openRequestCount + 2);
      assert.equal(after.sessions.length, before.sessions.length, 'both opens retain one durable transcript');
      const replacementRoute = after.sessions.find(row => row.path === seed.sessionPath);
      const saved = before.sessions.find(row => row.path === seed.sessionPath);
      assert.equal(replacementRoute.live, true);
      assert.equal(replacementRoute.openCount, saved.openCount + 2);
      assert.notEqual(replacementRoute.routingId, saved.routingId, 'resume rotates the routing identity, not the durable identity');
      assert.equal(replacementRoute.durableId, seed.durableId);
      assert.equal(closeCompletion.closeCount, before.closeCount + 1);
      // CloseCount observes completed cleanup. A later HTTP snapshot may already
      // contain the reacquired route for this SAME durable path; do not pin its
      // live flag to a scheduling race between snapshot and replacement open.
      assert.ok(closeCompletion.sessions.some(row => row.path === seed.sessionPath));
      assert.equal(after.promptCount, 0);
      assert.equal(observed.timeline.filter(row => row.sequence > from).filter(isCreate(chat)).length, 2);
      report.scenarios.C2 = { passed: true, seed, firstSocketId: first.socketId, replacementSocketId: replacement.socketId,
        cycles, before, held, closeCompletion, after, replacementRoute, ...ready };
      await shot('C2-replacement-ready-1440x1000'); transcriptChat = chat;
    }
    if (only.includes('long-transcript')) {
      const metadata = await api('/api/workspaces');
      const chat = metadata.find(row => row.id === workspace.id).chats.find(row => row.id === transcriptChat.id);
      const state = await snapshot('long-transcript-before');
      const session = state.sessions.find(row => row.live && (row.path === chat.piSessionId || row.durableId === chat.piSessionId));
      assert.ok(session, 'ready chat metadata identifies its live fixture transcript');
      const count = transcriptCount;
      assert.equal(session.entryCount, count, 'long transcript was seeded before the held resume');
      const layouts = [];
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 800 }]) {
        await page.setViewportSize(viewport);
        const from = observed.mark();
        const create = observed.wait(isCreate(chat), { after: from, label: 'long transcript reattach' });
        await page.reload({ waitUntil: 'domcontentloaded' });
        const sent = await create;
        await readySignals(observed, sent.socketId, chat, sent.sequence);
        const bottom = await armDOM(page, count => {
          const body = document.querySelector('.th-chat-body');
          return !!body && body.textContent.includes(`fixture-entry-${count}`) && body.scrollHeight - body.clientHeight - body.scrollTop <= 2;
        }, count);
        await doneDOM(page, bottom);
        await doneDOM(page, await armDOM(page, composerReady));
        const geometry = await page.evaluate(() => {
          const rect = selector => {
            const node = document.querySelector(selector), box = node.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return { selector, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
              visible: getComputedStyle(node).visibility === 'visible', unobscured: !!hit && node.contains(hit) };
          };
          const body = document.querySelector('.th-chat-body');
          return { viewport: { width: innerWidth, height: innerHeight }, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
            regions: ['.th-chat-scrollport', '.th-chat-input', '.th-chat-input textarea'].map(rect) };
        });
        assert.ok(geometry.scrollHeight > geometry.clientHeight, 'real long overflowing transcript');
        for (const region of geometry.regions) {
          assert.ok(region.visible && region.unobscured && region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0
            && region.right <= viewport.width + 1 && region.bottom <= viewport.height + 1, `visible composer/transcript: ${JSON.stringify(region)}`);
        }
        await shot(`long-transcript-bottom-${viewport.width}x${viewport.height}`);
        const top = await armDOM(page, () => {
          const body = document.querySelector('.th-chat-body');
          return !!body && body.scrollTop <= 1 && /fixture-entry-1(?!\d)/.test(body.textContent);
        });
        await page.locator('.th-chat-body').hover(); await page.mouse.wheel(0, -geometry.scrollHeight);
        await doneDOM(page, top);
        await shot(`long-transcript-top-${viewport.width}x${viewport.height}`);
        layouts.push(geometry);
      }
      report.scenarios['long-transcript'] = { passed: true, count, sessionPath: session.path, layouts };
    }
    report.passed = true;
  } catch (error) {
    failure = error; report.passed = false; report.error = { message: error.message, stack: error.stack };
  } finally {
    const clean = async (label, action) => {
      try { await action(); report.cleanup[label] = true; }
      catch (error) { cleanupErrors.push({ label, error: error.message }); report.cleanup[label] = false; }
    };
    for (const token of barriers) await clean(`release-${token}`, () => release(token));
    // Closing pages first cancels any in-flight chat attempt. Deleting only the
    // workspace created by this invocation then stops all of its live routes.
    if (page && !page.isClosed()) await clean('pageClosed', () => page.close());
    if (workspace) await clean('workspaceDeleted', () => api(`/api/workspaces/${workspace.id}`, 'DELETE'));
    if (control && initial) await clean('routesInactive', async () => {
      const final = await control('/state'); report.cleanup.finalFixtureState = final;
      assert.ok(final.sessions.every(row => !row.live), 'no live fixture routes after owned metadata deletion');
      assert.equal(final.promptCount, initial.promptCount, 'QA never issues a prompt');
    });
    if (observed) observed.stop();
    if (context) await clean('contextClosed', () => context.close());
    if (browser && !suppliedBrowser) await clean('browserClosed', () => browser.close());
    if (suppliedBrowser) report.cleanup.callerBrowserRetained = true;
    report.cleanup.externalRuntime = 'App and idlefixture are caller-owned; stop both and remove their isolated root after this runner.';
    report.cleanup.errors = cleanupErrors;
    report.finishedAt = new Date().toISOString();
    if (cleanupErrors.length) report.passed = false;
    if (observed) await save('websocket-timeline.json', observed.timeline);
    await save('cleanup.json', report.cleanup); await save('report.json', report);
  }
  if (failure) throw failure;
  assert.equal(cleanupErrors.length, 0, `Cleanup failed: ${JSON.stringify(cleanupErrors)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--help')) {
    console.log('node test/qa/heartbeat-liveness.mjs --fixture-root ROOT --evidence-dir DIR [--only C3,C1,C2,long-transcript] [--headed]');
  } else {
    runHeartbeatLiveness({ evidenceDir: value('--evidence-dir'), fixtureRoot: value('--fixture-root'),
      headless: !args.includes('--headed'), only: value('--only')?.split(',') ?? scenarios,
    }).then(report => console.log(JSON.stringify({ passed: report.passed, scenarios: Object.keys(report.scenarios), cleanup: report.cleanup }, null, 2)))
      .catch(error => { console.error(error.stack); process.exitCode = 1; });
  }
}
