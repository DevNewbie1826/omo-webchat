/** Real Go application + Unix RPC fixture + native Google Chrome recovery QA.
 * No installed dependencies are changed. Import runRPC46Resume from eval, or:
 * QA_PLAYWRIGHT=/absolute/playwright-core/index.mjs bun test/qa/rpc46-resume.mjs --evidence PATH
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { observeSockets } from './heartbeat-liveness.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = resolve(repo, '.omo/rpc46-qa/r2');
const appURL = 'http://127.0.0.1:25262';
const controlURL = 'http://127.0.0.1:25272';
const timeout = 15_000;
export const payloads = Object.freeze([
  { name: 'context-limit', error: 'open_failed: QA_CONTEXT_LIMIT 311799 > 272000', exact: true },
  { name: 'arbitrary', error: 'QA_PRIVATE_INTERNAL_ERROR /private/credential-path', exact: false },
  { name: 'empty-detail', error: 'open_failed:', exact: false },
  { name: 'blank-detail', error: 'open_failed: \n\t  ', exact: false },
  { name: 'multiline-inert', error: 'open_failed: QA_LONG_DETAIL\n<img src=x onerror="window.rpc46Executed=true">\n<script>window.rpc46Executed=true</script>\n' + Array.from({ length: 32 }, (_, i) => `line-${i}: original <b>inert</b> diagnostic & context 311799 > 272000`).join('\n'), exact: true },
]);
const fallback = 'could not resume the session; please retry';
const frameIs = (row, direction, type, chat) => row.kind === 'frame' && row.direction === direction && row.frame?.type === type && (!chat || row.frame.sessionId === chat);

// Mutation/event barrier, mirroring heartbeat-liveness without altering its API.
async function armDOM(page, predicate, args) {
  return page.evaluate(({ source, args, timeout }) => {
    const test = (0, eval)(`(${source})`);
    window.__rpc46DOM ??= new Map();
    const id = window.__rpc46DOM.size + 1;
    const promise = new Promise((done, fail) => {
      let timer;
      const finish = error => { clearTimeout(timer); observer.disconnect(); document.removeEventListener('input', check, true); document.removeEventListener('scroll', check, true); error ? fail(error) : done(true); };
      const check = () => { try { if (test(args)) finish(); } catch (error) { finish(error); } };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
      document.addEventListener('input', check, true);
      document.addEventListener('scroll', check, true);
      timer = setTimeout(() => finish(new Error(`DOM deadline: ${source}`)), timeout);
      check();
    });
    promise.catch(() => {}); window.__rpc46DOM.set(id, promise); return id;
  }, { source: String(predicate), args, timeout });
}
async function doneDOM(page, id) {
  await page.evaluate(async id => { try { await window.__rpc46DOM.get(id); } finally { window.__rpc46DOM.delete(id); } }, id);
}
async function request(client, url, method = 'GET', data) {
  const response = await client.fetch(url, { method, ...(data === undefined ? {} : { data }), timeout });
  const raw = await response.text();
  assert.ok(response.ok(), `${method} ${url}: ${response.status()} ${raw}`);
  return raw ? JSON.parse(raw) : null;
}

/** Read-only layout evidence at the real capture/action boundary. */
export async function captureGeometry(page) {
  return page.evaluate(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const box = e => {
      const s = getComputedStyle(e);
      return { tag: e.tagName, className: e.className, rect: rect(e), clientWidth: e.clientWidth, clientLeft: e.clientLeft, clientHeight: e.clientHeight,
        scrollWidth: e.scrollWidth, scrollHeight: e.scrollHeight, scrollLeft: e.scrollLeft, scrollTop: e.scrollTop,
        overflowX: s.overflowX, overflowY: s.overflowY, transform: s.transform };
    };
    const ancestors = e => {
      const result = [];
      for (let p = e.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') result.push(box(p));
      }
      return result;
    };
    const textRects = e => {
      const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), result = [];
      while (walker.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const r of range.getClientRects()) result.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      return result;
    };
    const selectors = ['html', 'body', '#root', '.th-chat-pane', '.th-chat-main', '.th-chat-main-content',
      '.th-chat-scrollport', '.th-chat-body', '.th-chat-history', '.th-chat-error', '.th-failed-drafts', '.th-chat-input'];
    const vv = visualViewport;
    return { innerWidth, innerHeight, scrollX, scrollY, visualViewport: vv && { width: vv.width, height: vv.height,
      scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, pageLeft: vv.pageLeft, pageTop: vv.pageTop },
      activeElement: document.activeElement?.className,
      boxes: Object.fromEntries(selectors.map(s => [s, [...document.querySelectorAll(s)].map(box)])),
      controls: [...document.querySelectorAll('.th-failed-drafts button')].map(e => ({ ...box(e), text: e.textContent,
        requestId: e.dataset.requestId ?? e.dataset.dismissRequestId, clippingAncestors: ancestors(e) })),
      transcriptEdges: [...document.querySelectorAll('.th-chat-msg, .th-chat-error')].filter(e => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
        .map(e => ({ ...box(e), text: e.textContent?.slice(0, 100), textRects: textRects(e), clippingAncestors: ancestors(e) })) };
  });
}

/** Page containment is not the same invariant as every scrollable child being visible. */
export function assertContainedGeometry(g) {
  const within = (r, left, right, label) => assert.ok(r.left >= left - 1 && r.right <= right + 1, `${label}: ${r.left}..${r.right} outside ${left}..${right}`);
  assert.equal(g.scrollX, 0, 'page horizontal pan');
  assert.equal(g.scrollY, 0, 'page vertical pan');
  assert.deepEqual(g.visualViewport, { width: g.innerWidth, height: g.innerHeight, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0 }, 'unscaled, unpanned capture');
  for (const [selector, boxes] of Object.entries(g.boxes)) for (const b of boxes) {
    within(b.rect, 0, g.innerWidth, selector);
    if (selector === '.th-failed-drafts') {
      assert.equal(b.overflowX, 'auto', 'retry row retains its natural scroll owner');
    } else {
      assert.equal(b.scrollLeft, 0, `${selector} horizontal displacement`);
      assert.ok(b.scrollWidth <= b.clientWidth + 1, `${selector} horizontal overflow`);
    }
  }
  for (const e of g.transcriptEdges) {
    within(e.rect, 0, g.innerWidth, 'transcript edge');
    for (const r of e.textRects) for (const a of e.clippingAncestors) {
      within(r, a.rect.left + a.clientLeft, a.rect.left + a.clientLeft + a.clientWidth, 'transcript text');
    }
  }
}

export function assertControlReachable(control, g) {
  assert.ok(control, 'required retry/dismiss control exists');
  const r = control.rect;
  assert.ok(r.width > 0 && r.height > 0, 'nonempty control');
  for (const a of [{ rect: { left: 0, right: g.innerWidth, top: 0, bottom: g.innerHeight } }, ...control.clippingAncestors]) {
    assert.ok(r.left >= a.rect.left - 1 && r.right <= a.rect.right + 1 && r.top >= a.rect.top - 1 && r.bottom <= a.rect.bottom + 1,
      `control clipped by ${a.className ?? 'viewport'}: ${r.left}..${r.right}`);
  }
}

// Subscribe before a real wheel gesture; completion is the owner's native
// scrollend after an actual offset change, never a delay or DOM scroll mutation.
async function wheelScroll(page, owner, dx, dy) {
  await owner.hover();
  await owner.evaluate((e, timeout) => {
    const left = e.scrollLeft, top = e.scrollTop;
    window.__rpc46Scroll = new Promise((done, fail) => {
      const finish = error => { clearTimeout(timer); e.removeEventListener('scrollend', end); error ? fail(error) : done({ left: e.scrollLeft, top: e.scrollTop }); };
      const end = () => { if (left !== e.scrollLeft || top !== e.scrollTop) finish(); };
      const timer = setTimeout(() => finish(new Error('native scrollend deadline')), timeout);
      e.addEventListener('scrollend', end);
    });
    window.__rpc46Scroll.catch(() => {});
  }, timeout);
  await page.mouse.wheel(dx, dy);
  await page.evaluate(async () => { try { await window.__rpc46Scroll; } finally { delete window.__rpc46Scroll; } });
}

async function revealRetryPair(page, requestId) {
  const retry = page.locator(`.th-failed-draft[data-request-id="${requestId}"]`);
  const pair = await retry.locator('..').boundingBox();
  const row = page.locator('.th-failed-drafts'), bounds = await row.boundingBox();
  const dx = pair.x < bounds.x ? pair.x - bounds.x : Math.max(0, pair.x + pair.width - bounds.x - bounds.width);
  if (Math.abs(dx) > 1) await wheelScroll(page, row, dx, 0);
  const g = await captureGeometry(page);
  assertContainedGeometry(g);
  const controls = g.controls.filter(c => c.requestId === requestId);
  assert.equal(controls.length, 2, 'separate retry and dismiss controls');
  controls.forEach(c => assertControlReachable(c, g));
  return g;
}

/** Exact actions shared by the CLI and eval. Owns no server or browser process.
 * Query coverage constructs an additional native browser socket, not a socket
 * replacement. Composer coverage uses only real DOM input/click actions.
 */
export async function runResumeActions({ page, context, observed, root, evidenceDir }) {
  const api = (path, method, data) => request(context.request, appURL + path, method, data);
  const control = (path, data) => request(context.request, controlURL + path, data === undefined ? 'GET' : 'POST', data);
  const results = [];
  const state = await control('/state');
  assert.equal(state.root, root); assert.deepEqual(state.sessions, []);
  await page.goto(appURL, { waitUntil: 'domcontentloaded' });
  await page.locator('#th-password').fill('rpc46-qa-only');
  const login = page.waitForResponse(r => r.url().endsWith('/api/login') && r.request().method() === 'POST');
  await page.locator('.th-login form button[type="submit"]').click();
  assert.ok((await login).ok());
  assert.deepEqual(await api('/api/workspaces'), []);
  const ws = await api('/api/workspaces', 'POST', { name: 'RPC46 QA', path: resolve(root, 'workspace') });
  const chats = {};
  for (const name of ['A', 'B']) chats[name] = await api(`/api/workspaces/${ws.id}/chats`, 'POST', { name: `RPC46 ${name}`, provider: 'omo' });
  const layout = { kind: 'split', id: 'rpc46-root', dir: 'h', ratio: 0.5,
    first: { kind: 'leaf', id: 'rpc46-A', sessionId: chats.A.id }, second: { kind: 'leaf', id: 'rpc46-B', sessionId: chats.B.id } };
  // Stop the old document's layout persistence before authoritative API seeding.
  await page.goto('about:blank');
  await api('/api/layout', 'PUT', layout);
  const hydrate = async action => {
    const from = observed.mark();
    const signals = Object.values(chats).flatMap(chat => ['ready', 'state', 'models', 'commands', 'stats'].map(type => observed.wait(row => frameIs(row, 'received', type, chat.id) && (type !== 'stats' || observed.timeline.filter(prior => prior.sequence > from && frameIs(prior, 'received', 'stats', chat.id)).length >= 2), { after: from, label: `${chat.name} ${type}` })));
    await action(); await Promise.all(signals);
    await doneDOM(page, await armDOM(page, () => [...document.querySelectorAll('.th-chat-input textarea')].length === 2 && [...document.querySelectorAll('.th-chat-input textarea')].every(e => !e.disabled)));
  };
  await hydrate(() => page.goto(appURL, { waitUntil: 'domcontentloaded' }));
  for (const name of ['A', 'B']) {
    const ready = observed.timeline.find(row => frameIs(row, 'received', 'ready', chats[name].id));
    const snapshot = (await control('/state')).sessions.find(s => s.durableId === ready.frame.piSessionId);
    assert.ok(snapshot); chats[name].path = snapshot.path;
    await control('/bind', { chat: name, path: snapshot.path });
    await control('/history', { chat: name, count: 240 });
  }
  const beforeHistory = observed.mark();
  const history = Object.values(chats).map(chat => observed.wait(row => frameIs(row, 'received', 'entries', chat.id) && row.frame.final === true, { after: beforeHistory, label: `${chat.name} history` }));
  await hydrate(() => page.reload({ waitUntil: 'domcontentloaded' })); await Promise.all(history);
  for (const name of ['A', 'B']) {
    const count = observed.timeline.filter(row => row.sequence > beforeHistory && frameIs(row, 'received', 'entries', chats[name].id)).reduce((n, row) => n + row.frame.entries.length, 0);
    assert.equal(count, 240, `${name} complete long history`);
    await doneDOM(page, await armDOM(page, name => document.querySelector(`[data-pane-id="rpc46-${name}"] .th-chat-body`)?.textContent.includes(`rpc46-${name}-history-240`), name));
  }
  const pane = name => page.locator('.th-chat-pane').filter({ has: page.locator('.th-termhead-name', { hasText: new RegExp(`^RPC46 ${name}$`) }) });
  const input = name => pane(name).locator('.th-chat-input textarea');
  const geometry = async (name, target = page) => {
    const g = await captureGeometry(target);
    await writeFile(resolve(evidenceDir, name + '-geometry.json'), JSON.stringify(g, null, 2));
    assertContainedGeometry(g);
    return g;
  };
  const shot = async name => {
    await geometry(name);
    await page.screenshot({ path: resolve(evidenceDir, name + '.png'), fullPage: false });
  };
  async function settleInput(name, text) {
    await selectChat(name);
    const from = observed.mark();
    const done = observed.wait(row => frameIs(row, 'received', 'run.done', chats[name].id), { after: from, label: `${name} accepted prompt settled` });
    const stats = observed.wait(row => frameIs(row, 'received', 'stats', chats[name].id) && observed.timeline.some(prior => prior.sequence > from && prior.sequence < row.sequence && frameIs(prior, 'received', 'run.done', chats[name].id)), { after: from, label: `${name} post-run stats` });
    await input(name).fill(text); await pane(name).locator('.th-chat-input button[type="submit"]').click();
    await done; await stats;
    await doneDOM(page, await armDOM(page, name => [...document.querySelectorAll('.th-chat-pane')].some(p => p.querySelector('.th-termhead-name')?.textContent === `RPC46 ${name}` && p.querySelector('.th-chat-input button[type="submit"]')), name));
  }
  async function selectChat(name) {
    if (await pane(name).count()) return;
    const from = observed.mark();
    const ready = observed.wait(row => frameIs(row, 'received', 'ready', chats[name].id), { after: from, label: `mobile ${name} ready` });
    const stats = observed.wait(row => frameIs(row, 'received', 'stats', chats[name].id) && observed.timeline.filter(prior => prior.sequence > from && frameIs(prior, 'received', 'stats', chats[name].id)).length >= 2, { after: from, label: `mobile ${name} initial stats complete` });
    await geometry(`mobile-sidebar-before-${name}-${results.length}`);
    await page.locator('.th-chat-pane .th-mobile-menu').click();
    await geometry(`mobile-sidebar-open-${name}-${results.length}`);
    const workspace = page.locator('.th-tree-workspace').filter({ has: page.locator('.th-tree-activation', { hasText: /^RPC46 QA$/ }) });
    const chevron = workspace.locator('.th-tree-chevron');
    if (await chevron.getAttribute('aria-expanded') !== 'true') await chevron.click();
    await page.locator('.th-tree-activation').filter({ hasText: new RegExp(`^RPC46 ${name}$`) }).click();
    await ready; await stats;
    await geometry(`mobile-sidebar-after-${name}-${results.length}`);
  }
  async function queryOpen() {
    const replayErrors = observed.timeline.filter(row => frameIs(row, 'received', 'error', chats.A.id) && row.frame.requestId && row.frame.command === 'chat.send').map(row => JSON.stringify(row.frame));
    await page.evaluate(async ({ wsId, chatId, timeout, replayErrors }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/v2/ws`);
      window.__rpc46Query = socket;
      window.__rpc46QueryFrames = [];
      const ready = new Promise((done, fail) => {
        const needed = new Set(['ready', 'state', 'models', 'commands', 'stats', 'entries']);
        const timer = setTimeout(() => fail(new Error('query attach deadline')), timeout);
        socket.addEventListener('message', ({ data }) => {
          const frame = JSON.parse(data); window.__rpc46QueryFrames.push(frame);
          if (frame.type === 'error') {
            // The attach ledger replays previously observed request outcomes.
            // Unknown errors still fail attachment; retain all frames in evidence.
            if (replayErrors.includes(JSON.stringify(frame))) return;
            clearTimeout(timer); fail(new Error(data)); return;
          }
          if (frame.type !== 'entries' || frame.final) needed.delete(frame.type);
          if (needed.size === 0) { clearTimeout(timer); done(); }
        });
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'hello', version: 2 }));
          socket.send(JSON.stringify({ type: 'chat.create', wsId, chatId }));
        }, { once: true });
      });
      await ready;
    }, { wsId: ws.id, chatId: chats.A.id, timeout, replayErrors });
  }
  async function queryClose() {
    await page.evaluate(timeout => new Promise((done, fail) => {
      const socket = window.__rpc46Query;
      if (socket.readyState === WebSocket.CLOSED) { done(); return; }
      const timer = setTimeout(() => fail(new Error('query close deadline')), timeout);
      socket.addEventListener('close', () => { clearTimeout(timer); done(); }, { once: true }); socket.close();
    }), timeout);
  }
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    if (viewport.width === 390) {
      await input('A').click();
      const from = observed.mark();
      const ready = observed.wait(row => frameIs(row, 'received', 'ready', chats.A.id), { after: from, label: 'mobile remount ready' });
      const stats = observed.wait(row => frameIs(row, 'received', 'stats', chats.A.id) && observed.timeline.filter(prior => prior.sequence > from && frameIs(prior, 'received', 'stats', chats.A.id)).length >= 2, { after: from, label: 'mobile remount stats' });
      await page.setViewportSize(viewport); await ready; await stats;
      await geometry('mobile-resize-before-sidebar-close');
      if (await page.locator('.th-backdrop').count()) {
        const closed = await armDOM(page, () => !document.querySelector('.th-backdrop'));
        await page.locator('.th-sidebar-nav-actions button').last().click();
        await doneDOM(page, closed);
      }
      await shot('mobile-resize-entry');
      await input('A').click();
      await geometry('mobile-resize-focused');
    } else await page.setViewportSize(viewport);
    for (const mode of ['composer', 'query']) for (const payload of payloads) {
      const label = `${viewport.width}-${mode}-${payload.name}`;
      await selectChat('A');
      if (mode === 'query') await queryOpen();
      const before = await control('/state');
      const original = before.sessions.find(s => s.path === chats.A.path);
      const sibling = before.sessions.find(s => s.path === chats.B.path);
      await control('/evict', { chat: 'A' });
      await control('/fail-open', { chat: 'A', error: payload.error, attempts: 1 });
      const expected = payload.exact ? payload.error : fallback;
      const dom = mode === 'composer' ? await armDOM(page, expected => [...document.querySelectorAll('.th-chat-pane')].find(p => p.querySelector('.th-termhead-name')?.textContent === 'RPC46 A')?.querySelector('.th-chat-error[role="alert"]')?.textContent === expected, expected) : null;
      const from = observed.mark();
      const failed = observed.wait(row => frameIs(row, 'received', 'error', chats.A.id) && row.frame.code === 'resume_failed', { after: from, label: `${label} resume_failed` });
      let sent;
      if (mode === 'composer') {
        sent = observed.wait(row => frameIs(row, 'sent', 'chat.send', chats.A.id), { after: from, label: `${label} real composer send` });
        await input('A').fill('rpc46-resume-once');
        await pane('A').locator('.th-chat-input button[type="submit"]').click();
      } else {
        await page.evaluate(chatId => window.__rpc46Query.send(JSON.stringify({ type: 'chat.stats', sessionId: chatId })), chats.A.id);
      }
      const error = await failed;
      const after = await control('/state');
      const current = after.sessions.find(s => s.path === chats.A.path);
      assert.deepEqual(current.prompts, original.prompts, 'failed reopen must not admit the prompt');
      assert.ok(!observed.timeline.some(row => row.sequence > from && frameIs(row, 'received', 'run.done', chats.A.id)), 'failed reopen is not a completed run');
      assert.equal(current.entryCount, original.entryCount, 'failure preserves durable history');
      const openAttempts = after.requests.slice(before.requests.length).filter(req => req.type === 'open_session' && req.sessionPath === chats.A.path).length;
      assert.equal(openAttempts, 1, 'exactly one failed reopen attempt');
      assert.deepEqual(after.sessions.find(s => s.path === chats.B.path), sibling, 'failure leaves sibling untouched');
      await writeFile(resolve(evidenceDir, label + '.json'), JSON.stringify({ payload, expected, error, before, after, openAttempts }, null, 2));
      // Capture even RED before asserting the original error detail.
      await shot(label);
      assert.equal(error.frame.message, expected, `${label}: exact recovery error`);
      if (mode === 'composer') {
        const send = await sent;
        assert.equal(error.frame.requestId, send.frame.requestId, 'request correlation');
        assert.equal(error.frame.command, 'chat.send');
        await doneDOM(page, dom);
        const detail = pane('A').locator('.th-chat-error[role="alert"]');
        assert.equal(await detail.textContent(), expected);
        assert.equal(await detail.locator('img,script,b').count(), 0, 'markup is inert text');
        assert.equal(await page.evaluate(() => window.rpc46Executed), undefined);
        assert.notEqual(await detail.evaluate(e => getComputedStyle(e).userSelect), 'none', 'diagnostic is selectable');
        await geometry(label + '-before-draft-recovery');
        if (await input('A').inputValue() !== 'rpc46-resume-once') await pane('A').locator(`.th-failed-draft[data-request-id="${send.frame.requestId}"]`).click();
        assert.equal(await input('A').inputValue(), 'rpc46-resume-once', 'input remains recoverable');
        await shot(label + '-readable');
        if (viewport.width === 390) {
          await revealRetryPair(page, send.frame.requestId);
          await shot(label + '-controls-readable');
          if (payload.name === 'multiline-inert') {
            const body = pane('A').locator('.th-chat-body');
            const d = await detail.boundingBox(), b = await body.boundingBox();
            if (d.y < b.y) await wheelScroll(page, body, 0, d.y - b.y - 12);
            await shot(label + '-detail-start');
          }
        }
        await input('A').fill('');
      } else {
        assert.equal(error.frame.command, 'get_session_stats');
        await queryClose();
      }
      // A second actual submission proves one-shot recovery; B remains usable.
      await settleInput('A', `rpc46-recovered-${label}`);
      await settleInput('B', `rpc46-sibling-${label}`);
      const recovered = await control('/state');
      const a = recovered.sessions.find(s => s.path === chats.A.path);
      assert.equal(a.durableId, original.durableId);
      assert.equal(a.prompts.length, (original.prompts ?? []).length + 1, 'exactly one recovered prompt');
      assert.equal(a.entryCount >= 240, true);
      results.push({ label, passed: true, requestId: error.frame.requestId, historyEntries: a.entryCount });
      await writeFile(resolve(evidenceDir, 'results.json'), JSON.stringify(results, null, 2));
    }
  }
  await selectChat('A');
  // Preserve all accumulated failures and prove every control through the
  // designed scroller, not by asking Playwright to auto-scroll an offscreen click.
  const retryIds = await page.locator('.th-failed-draft').evaluateAll(es => es.map(e => e.dataset.requestId));
  for (const [i, id] of retryIds.entries()) {
    await revealRetryPair(page, id);
    await shot(`mobile-reachable-pair-${i + 1}`);
  }
  // Every intact pair has been captured. Test dismiss now, not as a way to
  // make the preceding screenshots fit. It must leave the composer unchanged.
  const dismissedId = retryIds.at(-1), draftBeforeDismiss = await input('A').inputValue();
  const dismissed = await armDOM(page, id => !document.querySelector(`[data-dismiss-request-id="${id}"]`), dismissedId);
  await page.locator(`[data-dismiss-request-id="${dismissedId}"]`).click(); await doneDOM(page, dismissed);
  assert.equal(await page.locator('.th-failed-draft').count(), retryIds.length - 1);
  assert.equal(await input('A').inputValue(), draftBeforeDismiss);
  await geometry('mobile-after-dismiss');
  const fresh = await context.newPage();
  const freshObserved = observeSockets(fresh);
  try {
    await fresh.setViewportSize({ width: 390, height: 844 });
    const attached = ['ready', 'state', 'models', 'commands', 'entries', 'stats'].map(type => freshObserved.wait(row =>
      frameIs(row, 'received', type, chats.A.id) && (type !== 'entries' || row.frame.final) &&
      (type !== 'stats' || freshObserved.timeline.filter(r => frameIs(r, 'received', 'stats', chats.A.id)).length >= 2),
    { after: 0, label: `fresh390 attach ${type}` }));
    await fresh.goto(appURL, { waitUntil: 'domcontentloaded' }); await Promise.all(attached);
    await doneDOM(fresh, await armDOM(fresh, () => document.querySelector('.th-chat-body')?.textContent.includes('rpc46-recovered-390-query-multiline-inert') && document.querySelector('.th-chat-input textarea')?.disabled === false));
    await geometry('mobile-fresh-entry', fresh);
    await fresh.screenshot({ path: resolve(evidenceDir, 'mobile-fresh-entry.png') });
    await fresh.locator('.th-chat-input textarea').click();
    await geometry('mobile-fresh-focused', fresh);
    const before = await control('/state');
    await control('/evict', { chat: 'A' });
    await control('/fail-open', { chat: 'A', error: payloads[0].error, attempts: 1 });
    const from = freshObserved.mark();
    const failed = freshObserved.wait(row => frameIs(row, 'received', 'error', chats.A.id) && row.frame.code === 'resume_failed', { after: from, label: 'fresh390 exact failure' });
    const send = freshObserved.wait(row => frameIs(row, 'sent', 'chat.send', chats.A.id), { after: from, label: 'fresh390 rejected draft' });
    const shown = await armDOM(fresh, expected => {
      const e = document.querySelector('.th-chat-error[role="alert"]'), body = document.querySelector('.th-chat-body');
      if (e?.textContent !== expected || !body) return false;
      const r = e.getBoundingClientRect(), b = body.getBoundingClientRect();
      return r.top >= b.top && r.bottom <= b.bottom;
    }, payloads[0].error);
    await fresh.locator('.th-chat-input textarea').fill('rpc46-resume-once');
    await fresh.locator('.th-chat-input button[type="submit"]').click();
    const error = await failed, sent = await send; await doneDOM(fresh, shown);
    assert.equal(error.frame.message, payloads[0].error);
    assert.equal(error.frame.requestId, sent.frame.requestId);
    const after = await control('/state');
    assert.deepEqual(after.sessions, before.sessions.map(s => s.path === chats.A.path ? { ...s, live: false } : s), 'only the scripted A eviction changes session state; no prompt/history/sibling changes');
    assert.equal(after.requests.slice(before.requests.length).filter(r => r.type === 'open_session' && r.sessionPath === chats.A.path).length, 1);
    await geometry('mobile-fresh-failure', fresh);
    await fresh.screenshot({ path: resolve(evidenceDir, 'mobile-fresh-failure.png') });
    await revealRetryPair(fresh, sent.frame.requestId);
    await fresh.locator('.th-chat-input textarea').fill('');
    const restored = await armDOM(fresh, () => document.querySelector('.th-chat-input textarea')?.value === 'rpc46-resume-once' && !document.querySelector('.th-failed-drafts'));
    await fresh.locator('.th-failed-draft').click(); await doneDOM(fresh, restored);
    await geometry('mobile-fresh-draft-recovered', fresh);
    await fresh.screenshot({ path: resolve(evidenceDir, 'mobile-fresh-draft-recovered.png') });
  } finally {
    await writeFile(resolve(evidenceDir, 'fresh-protocol-timeline.json'), JSON.stringify(freshObserved.timeline, null, 2));
    freshObserved.stop(); await fresh.close();
  }
  return { results, chats, workspace: ws };
}

export function describeLaunch(command, args, env, cwd) {
  return { argv: [command, ...args.map((arg, i) => args[i - 1] === '--password' ? '[REDACTED]' : arg)], environmentKeys: Object.keys(env).sort(), cwd };
}
function child(command, args, { cwd = repo, env = process.env, log, ready } = {}) {
  const processChild = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const closed = new Promise((done, fail) => { processChild.once('error', fail); processChild.once('close', (code, signal) => done({ code, signal })); });
  closed.catch(() => {});
  const started = ready ? new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${command} readiness deadline\n${output}`)), 30_000);
    const check = () => { if (output.includes(ready)) { clearTimeout(timer); done(); } };
    for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', data => { output += data; check(); });
    closed.then(result => { clearTimeout(timer); fail(new Error(`${command} exited before ready: ${JSON.stringify(result)}\n${output}`)); }, fail);
  }) : null;
  if (!ready) for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', data => { output += data; });
  started?.catch(() => {});
  return { process: processChild, closed, started, output: () => output, log, launch: { ...describeLaunch(command, args, env, cwd), pid: processChild.pid } };
}
async function command(command, args, log) {
  const task = child(command, args, { log });
  const result = await task.closed; await writeFile(log, task.output());
  assert.equal(result.code, 0, `${command} ${args.join(' ')}: ${task.output()}`);
  return { pid: task.process.pid, command, args, ...result };
}
async function stop(task) {
  if (task.process.exitCode === null && task.process.signalCode === null) task.process.kill('SIGTERM');
  let timer;
  const forced = new Promise((_, fail) => { timer = setTimeout(() => { task.process.kill('SIGKILL'); fail(new Error(`forced teardown PID ${task.process.pid}`)); }, 10_000); });
  try { return { pid: task.process.pid, ...await Promise.race([task.closed, forced]) }; }
  finally { clearTimeout(timer); await task.closed; await writeFile(task.log, task.output()); }
}
async function driver() {
  const candidates = [process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs'];
  for (const path of candidates) { try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; } return (await import(pathToFileURL(path).href)).chromium; }
  throw new Error('QA_PLAYWRIGHT must identify an already-installed playwright-core/index.mjs');
}

/** Owns and tears down fixture, actual app, fresh Chrome context and runtime.
 * --selfcheck compiles/exercises only the fixture: no frontend/app build needed.
 * Normal execution builds Go against an already-built frontend/dist.
 */
export async function runRPC46Resume({ evidenceDir, chromium, headless = true, selfcheck = false } = {}) {
  assert.ok(evidenceDir, 'evidenceDir required'); evidenceDir = resolve(evidenceDir);
  await mkdir(evidenceDir, { recursive: true }); await mkdir(scratch, { recursive: true });
  const root = resolve(scratch, 'r'); await mkdir(root); // Exclusive ownership; never remove another run.
  const report = { startedAt: new Date().toISOString(), root, appURL, controlURL, selfcheck, cleanup: [] };
  const tasks = []; let browser, context, page, observed, failure;
  try {
    report.cleanup.push({ label: 'fixture build exited', result: await command('go', ['build', ...(selfcheck ? ['-race'] : []), '-o', resolve(root, 'fixture'), 'test/qa/rpc46-resume-fixture.go'], resolve(evidenceDir, 'fixture-build.log')) });
    if (selfcheck) {
      report.cleanup.push({ label: 'fixture selfcheck exited', result: await command(resolve(root, 'fixture'), ['--root', root, '--selfcheck'], resolve(evidenceDir, 'fixture-selfcheck.log')) });
      report.fixtureSelfcheck = true;
      const fixture = child(resolve(root, 'fixture'), ['--root', root], { ready: 'RPC46_FIXTURE_READY', log: resolve(evidenceDir, 'fixture-control-selfcheck.log') }); tasks.push(fixture); await fixture.started;
      const response = await fetch(controlURL + '/state', { signal: AbortSignal.timeout(timeout) });
      assert.equal(response.status, 200);
      const state = await response.json(); assert.equal(state.root, root); assert.deepEqual(state.sessions, []);
      report.controlSelfcheck = state;
    } else {
      await access(resolve(repo, 'frontend/dist/index.html'));
      await command('go', ['build', '-o', resolve(root, 'app'), './cmd/server'], resolve(evidenceDir, 'app-build.log'));
      const fixture = child(resolve(root, 'fixture'), ['--root', root], { ready: 'RPC46_FIXTURE_READY', log: resolve(evidenceDir, 'fixture.log') }); tasks.push(fixture); await fixture.started;
      // Whitelist launcher environment instead of inheriting host/session control.
      const launcher = process.env.QA_OMO ?? '/Users/mirage/.bun/install/global/node_modules/omo-ai/bin/omo.js';
      await access(launcher);
      const foundNode = spawnSync('/usr/bin/which', ['node'], { encoding: 'utf8' });
      assert.equal(foundNode.status, 0, `node resolution: ${foundNode.stderr}`);
      const node = foundNode.stdout.trim(), bin = resolve(root, 'bin');
      await mkdir(bin);
      const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      await writeFile(resolve(bin, 'omo'), `#!/bin/sh\n# entry: ${launcher}\nexec ${quote(node)} ${quote(launcher)} "$@"\n`, { mode: 0o700 });
      const env = { HOME: process.env.HOME, PATH: `${bin}:${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR ?? '/tmp', OMO_BIN: launcher, OMO_CODING_AGENT_DIR: resolve(root, 'agent'), OMO_RUNTIME: 'node', SENPI_RUNTIME: 'node' };
      report.launcher = { launcher, node, path: env.PATH };
      const app = child(resolve(root, 'app'), ['--state-dir', resolve(root, 'state'), '--root', root, '--password', 'rpc46-qa-only', '--port', '25262'], { env, ready: 'msg=listening', log: resolve(evidenceDir, 'app.log') }); tasks.push(app); await app.started;
      browser = await (chromium ?? await driver()).launch({ channel: 'chrome', headless });
      report.browserVersion = browser.version();
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); context.setDefaultTimeout(timeout);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      page = await context.newPage(); observed = observeSockets(page);
      report.actions = await runResumeActions({ page, context, observed, root, evidenceDir });
    }
    report.passed = true;
  } catch (error) { failure = error; report.error = String(error.stack ?? error); report.passed = false; }
  finally {
    async function cleanup(label, action) { try { report.cleanup.push({ label, result: await action() }); } catch (error) { report.cleanup.push({ label, error: String(error) }); failure ??= error; report.passed = false; } }
    if (observed) { await cleanup('protocol saved', () => writeFile(resolve(evidenceDir, 'protocol-timeline.json'), JSON.stringify(observed.timeline, null, 2)).then(() => true)); observed.stop(); }
    if (page && failure) await cleanup('failure screenshot', () => page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).then(() => true));
    if (context) { await cleanup('trace', () => context.tracing.stop({ path: resolve(evidenceDir, 'trace.zip') }).then(() => true)); await cleanup('context closed', () => context.close().then(() => true)); }
    if (browser) await cleanup('Chrome closed', () => browser.close().then(() => !browser.isConnected()));
    report.launches = tasks.map(task => task.launch);
    for (const task of tasks.reverse()) await cleanup('process stopped', () => stop(task));
    await cleanup('runtime removed', () => rm(root, { recursive: true }).then(() => true));
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--evidence');
  if (at < 0 || !args[at + 1]) throw new Error('Usage: bun test/qa/rpc46-resume.mjs --evidence PATH [--selfcheck] [--headed]');
  await runRPC46Resume({ evidenceDir: args[at + 1], selfcheck: args.includes('--selfcheck'), headless: !args.includes('--headed') });
}
