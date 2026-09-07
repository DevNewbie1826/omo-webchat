/** Real Chrome -> production Go app -> Unix RPC fixture overflow/queue QA.
 * Import runRPC46Overflow from eval, or run with --evidence PATH.
 * No frontend build, dependency install, WebSocket replacement or user profile.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { observeSockets } from './heartbeat-liveness.mjs';
import { appURL, fixtureURL, driver, startRuntime } from './rpc46-overflow-runtime.mjs';
import { expectedSiblingEntries, assertSiblingHistory, assertSiblingSnapshot, assertSiblingTraffic } from './rpc46-overflow-sibling.mjs';

export const diagnostic = 'QA_OVERFLOW_RECOVERY_EXHAUSTED';
export const overflowStart = Object.freeze({ type: 'compaction_start', reason: 'overflow', requestId: 'auto-1' });
export const retryEnd = Object.freeze({ type: 'compaction_end', reason: 'overflow', requestId: 'auto-1', willRetry: true });
export const terminalEnd = Object.freeze({ type: 'compaction_end', reason: 'overflow', willRetry: false, errorMessage: diagnostic });
export const matchedFailureEnd = Object.freeze({ type: 'compaction_end', reason: 'overflow', requestId: 'failed-1',
  willRetry: false, errorMessage: 'QA_MATCHED_COMPACTION_FAILURE' });
const deadline = 10_000;
const paneSelector = '[data-pane-id="rpc46-a"]';
const siblingSelector = '[data-pane-id="rpc46-b"]';
const frameIs = (row, type, chatId) => row.kind === 'frame' && row.direction === 'received'
  && row.frame?.type === type && row.frame.sessionId === chatId;

// Same event-based DOM barrier pattern as heartbeat-liveness: arm before the
// action, observe mutations/scroll, then consume the promise. No polling.
async function armDOM(page, predicate, args = null) {
  return page.evaluate(({ source, args, deadline }) => {
    window.__rpc46DOM ??= new Map();
    const id = (window.__rpc46DOMID = (window.__rpc46DOMID ?? 0) + 1);
    const checkValue = (0, eval)(`(${source})`);
    const promise = new Promise((yes, no) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); observer.disconnect(); document.removeEventListener('scroll', check, true);
        error ? no(error) : yes();
      };
      const check = () => { try { if (checkValue(args)) finish(); } catch (error) { finish(error); } };
      const observer = new MutationObserver(check);
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
      document.addEventListener('scroll', check, true);
      timer = setTimeout(() => finish(new Error(`DOM deadline: ${source}`)), deadline);
      check();
    });
    promise.catch(() => {}); window.__rpc46DOM.set(id, promise); return id;
  }, { source: String(predicate), args, deadline });
}
async function doneDOM(page, id) {
  await page.evaluate(async id => {
    try { await window.__rpc46DOM.get(id); } finally { window.__rpc46DOM.delete(id); }
  }, id);
}

async function request(context, url, method = 'GET', data) {
  const response = await context.request.fetch(url, { method, ...(data === undefined ? {} : { data }), timeout: 15_000 });
  const text = await response.text();
  assert.ok(response.ok(), `${method} ${url}: ${response.status()} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** The browser action track is also exported for lead-owned eval orchestration.
 * It requires a fresh authenticated context and this invocation's isolated root.
 */
export async function exerciseOverflow({ page, context, observed, root, evidenceDir, manual = false, mobile = false,
  terminalCase = 'standalone' }) {
  assert.ok(['standalone', 'reused-id', 'matched-replay'].includes(terminalCase), 'known terminal case required');
  const name = `${manual ? 'manual-successor' : 'active-run'}-${mobile ? 'mobile' : 'desktop'}${terminalCase === 'standalone' ? '' : `-${terminalCase}`}`;
  const control = async (path, data) => {
    const value = await request(context, fixtureURL + path, data === undefined ? 'GET' : 'POST', data);
    observed.record({ kind: 'fixture-control', path, data, value }); return value;
  };
  const api = (path, method = 'GET', data) => request(context, appURL + path, method, data);
  const result = { name, screenshots: [], states: [], siblingCheckpoints: [], siblingOwnerTransitions: [], passed: false };
  const siblingPrefix = `rpc46-sibling-${name}`;
  const expectedEntries = expectedSiblingEntries(siblingPrefix);
  const siblingDraft = `rpc46-sibling-draft-${name}`;
  const workspace = await api('/api/workspaces', 'POST', { name: `RPC46 ${name}`, path: resolve(root, 'workspace') });
  const chat = await api(`/api/workspaces/${workspace.id}/chats`, 'POST', { name: `RPC46 ${name} A`, provider: 'omo' });
  const sibling = await api(`/api/workspaces/${workspace.id}/chats`, 'POST', { name: `RPC46 ${name} B`, provider: 'omo' });
  const layout = { kind: 'split', id: 'rpc46-split', dir: 'h', ratio: .65,
    first: { kind: 'leaf', id: 'rpc46-a', sessionId: chat.id },
    second: { kind: 'leaf', id: 'rpc46-b', sessionId: sibling.id } };
  await page.goto('about:blank');
  await api('/api/layout', 'PUT', layout);
  const seedMark = observed.mark();
  const ready = observed.wait(row => frameIs(row, 'ready', chat.id), { after: seedMark, label: `${name} seed ready` });
  const siblingReady = observed.wait(row => frameIs(row, 'ready', sibling.id), { after: seedMark, label: `${name} sibling ready` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(appURL, { waitUntil: 'domcontentloaded' });
  const initialReady = await ready; const initialSiblingReady = await siblingReady;
  const state = await control('/state');
  const session = state.sessions.find(value => value.durableId === initialReady.frame.piSessionId);
  const siblingSession = state.sessions.find(value => value.durableId === initialSiblingReady.frame.piSessionId);
  assert.ok(session?.live, 'real fresh session is live');
  assert.ok(siblingSession?.live, 'real sibling session is live');
  result.chat = chat; result.sibling = sibling; result.path = session.path;
  const path = session.path;
  const closeSeed = observed.wait(row => row.kind === 'close' && row.socketId === initialReady.socketId,
    { label: `${name} seed socket closes` });
  const closeSiblingSeed = observed.wait(row => row.kind === 'close' && row.socketId === initialSiblingReady.socketId,
    { label: `${name} sibling seed socket closes` });
  await page.goto('about:blank'); await Promise.all([closeSeed, closeSiblingSeed]);
  await control('/history', { path, count: 240 });
  // Both saved panes need a real entry cursor before history reattachment.
  const seeded = await control('/history', { path: siblingSession.path, count: 2, prefix: siblingPrefix });
  const expectedProvider = seeded.sessions.find(value => value.path === siblingSession.path);
  await control('/silent', { path });
  await control('/configure', { path });
  const historyMark = observed.mark();
  const resumed = observed.wait(row => frameIs(row, 'ready', chat.id), { after: historyMark, label: `${name} resume` });
  const entries = observed.wait(row => frameIs(row, 'entries', chat.id) && row.frame.final,
    { after: historyMark, label: `${name} complete 240-entry history` });
  const siblingResumed = observed.wait(row => frameIs(row, 'ready', sibling.id),
    { after: historyMark, label: `${name} sibling resume owner` });
  const siblingEntries = observed.wait(row => frameIs(row, 'entries', sibling.id) && row.frame.final,
    { after: historyMark, label: `${name} complete sibling history` });
  await page.goto(appURL, { waitUntil: 'domcontentloaded' });
  const opened = await resumed; await entries; await siblingEntries;
  let siblingOwner = await siblingResumed;
  const siblingSocketIds = [initialSiblingReady.socketId, siblingOwner.socketId];
  let siblingHistoryMark = historyMark;
  assert.equal(opened.frame.resumed, true);
  let socketId = opened.socketId;
  const rows = () => observed.timeline.filter(row => row.socketId === socketId);
  const history = rows().filter(row => row.sequence > historyMark && frameIs(row, 'entries', chat.id));
  assert.equal(history.reduce((total, row) => total + row.frame.entries.length, 0), 240);
  result.historyCount = 240;
  await doneDOM(page, await armDOM(page, selector => document.querySelector(selector + ' .th-chat-body')?.textContent.includes('rpc46-history-240'), paneSelector));
  let selector = paneSelector;
  let pane = page.locator(selector);
  const input = pane.locator('.th-chat-input textarea');
  const siblingInput = page.locator(`${siblingSelector} .th-chat-input textarea`);
  await siblingInput.fill(siblingDraft);
  await doneDOM(page, await armDOM(page, ({ selector, texts }) => {
    const messages = [...document.querySelectorAll(selector + ' .th-chat-msg')];
    return messages.length === texts.length && messages.every((node, i) => node.textContent === texts[i]);
  }, { selector: siblingSelector, texts: expectedEntries.map(entry => entry.message.content) }));
  let barrierID = 0;
  async function emit(events) {
    const qaBarrier = `${name}-${++barrierID}`;
    const after = observed.mark();
    const signal = observed.wait(row => row.socketId === socketId && frameIs(row, 'state', chat.id) && row.frame.qaBarrier === qaBarrier,
      { after, label: `RPC state barrier ${qaBarrier}` });
    observed.record({ kind: 'rpc-injection', path, events, qaBarrier });
    await control('/events', { path, events: [...events, { type: 'state_changed', qaBarrier }] });
    const value = (await signal).frame; result.states.push(value); return value;
  }
  async function checkpointSibling(stage) {
    // A's ordered state marker has already arrived. B's own marker joins its
    // socket output before we inspect preservation; no quiet-period heuristic.
    const after = observed.mark();
    const qaBarrier = `${name}-sibling-${stage}`;
    const signal = observed.wait(row => row.socketId === siblingOwner.socketId && frameIs(row, 'state', sibling.id)
      && row.frame.qaBarrier === qaBarrier, { after, label: qaBarrier });
    await control('/events', { path: siblingSession.path, events: [{ type: 'state_changed', qaBarrier }] });
    const stateRow = await signal;
    const state = stateRow.frame;
    const ownerRows = observed.timeline.filter(row => row.socketId === siblingOwner.socketId);
    assert.equal(ownerRows.filter(row => row.sequence > siblingOwner.sequence &&
      (row.kind === 'close' || frameIs(row, 'ready', sibling.id))).length, 0, 'B owner cannot silently close or rebind');
    const create = ownerRows.find(row => row.direction === 'sent' && row.frame?.type === 'chat.create');
    assert.ok(create, 'B ready has a native chat.create owner');
    const pages = ownerRows.filter(row => row.sequence > siblingHistoryMark && frameIs(row, 'entries', sibling.id));
    assertSiblingHistory(pages, expectedEntries, { chatId: sibling.id, socketId: siblingOwner.socketId });
    const provider = (await control('/state')).sessions.find(value => value.path === siblingSession.path);
    const [header, ...diskEntries] = (await readFile(siblingSession.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const dom = await page.locator(siblingSelector).evaluate(node => ({
      messages: [...node.querySelectorAll('.th-chat-msg')].map(message => ({
        role: message.classList.contains('th-chat-msg--user') ? 'user' : 'assistant', text: message.textContent,
      })),
      draft: node.querySelector('.th-chat-input textarea').value,
      enabled: !node.querySelector('.th-chat-input textarea').disabled,
      text: node.textContent,
    }));
    for (const text of [diagnostic, matchedFailureEnd.errorMessage]) assert.ok(!dom.text.includes(text), 'A diagnostic never renders in B');
    const actual = { chatId: create.frame.chatId, wsId: create.frame.wsId,
      readyChatId: siblingOwner.frame.sessionId, piSessionId: siblingOwner.frame.piSessionId,
      socketId: stateRow.socketId, diskHeaderId: header.id, provider, entries: diskEntries,
      messages: dom.messages, draft: dom.draft, enabled: dom.enabled,
      streaming: state.isStreaming, compacting: state.isCompacting };
    const expected = { chatId: sibling.id, wsId: workspace.id, readyChatId: sibling.id,
      piSessionId: initialSiblingReady.frame.piSessionId, socketId: siblingOwner.socketId,
      diskHeaderId: initialSiblingReady.frame.piSessionId, provider: expectedProvider, entries: expectedEntries,
      messages: expectedEntries.map(entry => ({ role: entry.message.role, text: entry.message.content })),
      draft: siblingDraft, enabled: true, streaming: false, compacting: false };
    assertSiblingSnapshot(actual, expected);
    assertSiblingTraffic(observed.timeline, { chatId: sibling.id, socketIds: siblingSocketIds,
      diagnostics: [diagnostic, matchedFailureEnd.errorMessage], after: seedMark });
    result.siblingCheckpoints.push({ stage, barrier: qaBarrier, sequence: observed.mark(), actual, expected, pages });
    await writeFile(resolve(evidenceDir, `${name}-sibling.json`), JSON.stringify({
      checkpoints: result.siblingCheckpoints, ownerTransitions: result.siblingOwnerTransitions,
    }, null, 2) + '\n');
  }
  await checkpointSibling('before-recovery');
  async function submit(text, queuedCount = null) {
    const after = observed.mark();
    const sent = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.send'
      && row.frame.sessionId === chat.id && row.frame.run?.message === text, { after, label: `${name} submit ${text}` });
    const queue = queuedCount === null ? null : observed.wait(row => row.socketId === socketId && frameIs(row, 'queue', chat.id)
      && row.frame.items?.length === queuedCount, { after, label: `${name} ${queuedCount} queued items` });
    await input.fill(text); await input.press('Enter');
    const outgoing = await sent;
    await observed.wait(row => row.socketId === socketId && frameIs(row, 'ack', chat.id)
      && row.frame.requestId === outgoing.frame.requestId && row.frame.phase === undefined,
    { after, label: `${name} accepted ${text}` });
    if (queue) await queue;
  }
  if (!manual) {
    await submit('rpc46-running');
    await emit([{ type: 'agent_start' }]);
  }
  if (terminalCase === 'matched-replay') {
    const beforeMatched = observed.mark();
    await emit([{ ...overflowStart, requestId: matchedFailureEnd.requestId }, matchedFailureEnd]);
    const matchedFrames = rows().filter(row => row.sequence > beforeMatched).map(row => row.frame).filter(Boolean);
    assert.equal(matchedFrames.filter(frame => frame.type === 'compaction.done' && frame.error === matchedFailureEnd.errorMessage).length, 1,
      'first matched failure completes once with its original diagnostic');
    assert.equal(matchedFrames.filter(frame => frame.type === 'notice').length, 0, 'first matched failure has no second notice surface');
    await doneDOM(page, await armDOM(page, ({ selector, text }) => document.querySelector(selector)?.textContent.includes(text),
      { selector, text: matchedFailureEnd.errorMessage }));
    result.matchedFirstFrames = matchedFrames;
  } else {
    await emit([overflowStart, retryEnd]);
  }
  await checkpointSibling('after-retrying-or-matched-completion');
  if (manual) {
    await control('/hold-compact', { path });
    const after = observed.mark();
    const started = observed.wait(row => row.socketId === socketId && frameIs(row, 'compaction.started', chat.id),
      { after, label: 'manual successor admitted through real composer' });
    const reached = control('/await-request', { path, command: 'compact', count: 1 }); reached.catch(() => {});
    await input.fill('/compact');
    // A real click submits the exact command rather than selecting its palette.
    await pane.locator('.th-chat-send-btn').click();
    await started; await reached;
  }
  await submit('rpc46-queued-head', 1);
  await submit('rpc46-queued-tail', 2);
  if (manual) await emit([{ type: 'agent_start' }]);
  // Retry remains the same run: another agent_start cannot finish it or drain.
  const retryState = await emit([{ type: 'agent_start' }]);
  assert.equal(retryState.isStreaming, true);
  assert.equal(retryState.isCompacting, manual);
  let mobileSiblingClose;
  if (mobile) {
    // The production mobile breakpoint remounts ChatPane outside SplitView.
    // Reattach before injecting the diagnostic, not after losing its DOM owner.
    await input.click();
    if (!(await page.locator('.th-sidebar').getAttribute('class')).includes('th-sidebar--collapsed')) {
      await page.locator('.th-sidebar-toggle:visible').click();
    }
    const after = observed.mark();
    const ready = observed.wait(row => frameIs(row, 'ready', chat.id), { after, label: `${name} mobile reattach` });
    const history = observed.wait(row => frameIs(row, 'entries', chat.id) && row.frame.final,
      { after, label: `${name} mobile final history` });
    mobileSiblingClose = observed.wait(row => row.kind === 'close' && row.socketId === siblingOwner.socketId,
      { after, label: `${name} deliberate mobile B detach` });
    await page.setViewportSize({ width: 390, height: 844 });
    socketId = (await ready).socketId; await history; await mobileSiblingClose;
    selector = '.th-chat-pane'; pane = page.locator(selector);
    await emit([]);
  }
  const before = await control('/state');
  const expectedPrompts = manual ? [] : ['rpc46-running'];
  assert.deepEqual(before.sessions.find(row => row.path === path).prompts ?? [], expectedPrompts);
  const queueBefore = rows().filter(row => frameIs(row, 'queue', chat.id)).at(-1).frame.items;
  assert.deepEqual(queueBefore.map(row => row.text), ['rpc46-queued-head', 'rpc46-queued-tail']);
  const mark = observed.mark();
  const terminal = terminalCase === 'matched-replay' ? matchedFailureEnd
    : terminalCase === 'reused-id' ? { ...terminalEnd, requestId: retryEnd.requestId } : terminalEnd;
  const terminalState = await emit([terminal]);
  const terminalRows = rows().filter(row => row.sequence > mark);
  assert.equal(terminalState.isStreaming, true, 'terminal diagnostic must not settle the run');
  assert.equal(terminalState.isCompacting, manual, 'terminal diagnostic must not clear manual successor');
  assert.equal(terminalRows.filter(row => frameIs(row, 'run.done', chat.id)).length, 0);
  assert.equal(terminalRows.filter(row => frameIs(row, 'compaction.done', chat.id)).length, 0);
  const after = await control('/state');
  assert.deepEqual(after.sessions.find(row => row.path === path).prompts ?? [], expectedPrompts);
  const queueAfter = rows().filter(row => frameIs(row, 'queue', chat.id)).at(-1).frame.items;
  assert.deepEqual(queueAfter, queueBefore, 'durable queue IDs/order unchanged before settlement');
  const diagnosticRows = terminalRows.filter(row => frameIs(row, 'notice', chat.id) && JSON.stringify(row.frame).includes(terminal.errorMessage));
  result.before = before; result.afterDiagnostic = after; result.queueBefore = queueBefore; result.queueAfter = queueAfter;
  result.terminalProtocol = { terminalCase, terminal, state: terminalState,
    additionalDiagnosticCount: diagnosticRows.length, expectedAdditionalDiagnosticCount: terminalCase === 'matched-replay' ? 0 : 1,
    frames: terminalRows.filter(row => row.frame).map(row => row.frame) };
  // Persist the counterexample before the assertion so RED retains both the
  // first matched completion and the replay's additional presentation.
  await writeFile(resolve(evidenceDir, `${name}-protocol.json`), JSON.stringify(result, null, 2) + '\n');
  if (terminalCase === 'matched-replay') {
    assert.equal(diagnosticRows.length, 0, 'matched failed terminal REPLAY must not create a second user-visible error surface');
    assert.equal(terminalRows.filter(row => frameIs(row, 'notice', chat.id) || frameIs(row, 'error', chat.id)).length, 0,
      'matched failure replay is silent, not a differently named error');
  } else {
    assert.equal(diagnosticRows.length, 1, terminalCase === 'reused-id'
      ? 'NEW exhaustion after successful retry-end must remain visible with the reused ID'
      : 'standalone terminal overflow diagnostic must be delivered exactly once (baseline RED boundary)');
    const visible = await armDOM(page, ({ selector, text }) => document.querySelector(selector)?.textContent.includes(text),
      { selector, text: diagnostic });
    await doneDOM(page, visible);
    assert.equal(await pane.getByText(diagnostic, { exact: false }).count(), 1, 'exact diagnostic is readable once in transcript');
  }
  const notice = terminalCase === 'matched-replay' ? pane.locator('.th-queue-header') : pane.getByText(diagnostic, { exact: false });
  if (await pane.locator('.th-queue-header').getAttribute('aria-expanded') !== 'true') await pane.locator('.th-queue-header').click();
  for (const viewport of [mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }]) {
    await notice.scrollIntoViewIfNeeded();
    assert.ok(await notice.isVisible());
    const geometry = await notice.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= viewport.width + 1, 'diagnostic fits viewport horizontally');
    assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= viewport.height + 1, 'diagnostic lies in viewport');
    const filename = `${name}-${viewport.width}x${viewport.height}-before-settlement.png`;
    await page.screenshot({ path: resolve(evidenceDir, filename) });
    result.screenshots.push({ filename, viewport, geometry });
  }
  if (mobile) {
    // Mobile intentionally unmounts B. Restore the real split without a reload
    // or draft refill, and prove its original history/draft under a new socket.
    const after = observed.mark();
    const aReady = observed.wait(row => frameIs(row, 'ready', chat.id), { after, label: `${name} desktop A owner` });
    const bReady = observed.wait(row => frameIs(row, 'ready', sibling.id), { after, label: `${name} desktop B owner` });
    const aHistory = observed.wait(row => frameIs(row, 'entries', chat.id) && row.frame.final,
      { after, label: `${name} desktop A history` });
    const bHistory = observed.wait(row => frameIs(row, 'entries', sibling.id) && row.frame.final,
      { after, label: `${name} desktop B history` });
    await page.setViewportSize({ width: 1280, height: 800 });
    const previousOwner = siblingOwner;
    socketId = (await aReady).socketId; siblingOwner = await bReady;
    await Promise.all([aHistory, bHistory]);
    assert.notEqual(siblingOwner.socketId, previousOwner.socketId, 'viewport remount has a fresh native B socket');
    result.siblingOwnerTransitions.push({ reason: 'mobile breakpoint unmount/remount',
      previous: previousOwner, closed: await mobileSiblingClose, current: siblingOwner });
    siblingSocketIds.push(siblingOwner.socketId); siblingHistoryMark = after;
    selector = paneSelector; pane = page.locator(selector);
    await doneDOM(page, await armDOM(page, ({ selector, text }) =>
      document.querySelector(selector + ' .th-chat-body')?.textContent.includes(text),
    { selector: siblingSelector, text: expectedEntries.at(-1).message.content }));
    await emit([]);
  }
  await checkpointSibling('after-exhaustion-or-matched-replay');
  // Replay standalone diagnostics as well as matched failures, while A still
  // owns its run/manual successor and both durable items remain held.
  const replayMark = observed.mark();
  const replayState = await emit([terminal]);
  assert.equal(replayState.isStreaming, true);
  assert.equal(replayState.isCompacting, manual);
  const replayRows = rows().filter(row => row.sequence > replayMark);
  assert.equal(replayRows.filter(row => ['notice', 'error', 'run.done', 'compaction.done'].includes(row.frame?.type)).length, 0,
    'identical terminal replay adds no diagnostic or lifecycle completion');
  assert.deepEqual(rows().filter(row => frameIs(row, 'queue', chat.id)).at(-1).frame.items, queueBefore);
  assert.deepEqual((await control('/state')).sessions.find(row => row.path === path).prompts ?? [], expectedPrompts);
  result.replayProtocol = { terminal, state: replayState, frames: replayRows.filter(row => row.frame).map(row => row.frame) };
  await checkpointSibling('after-identical-replay');
  const settleMark = observed.mark();
  const settled = observed.wait(row => row.socketId === socketId && frameIs(row, 'run.done', chat.id),
    { after: settleMark, label: `${name} authoritative settlement` });
  await emit([{ type: 'agent_settled', reason: 'end_turn' }]); await settled;
  if (manual) {
    const held = await control('/state');
    assert.deepEqual(held.sessions.find(row => row.path === path).prompts ?? [], [], 'manual owner still blocks drain after run settlement');
    const stillHeld = await emit([]); assert.equal(stillHeld.isCompacting, true);
    await checkpointSibling('after-settlement-manual-still-held');
    const done = observed.wait(row => row.socketId === socketId && frameIs(row, 'compaction.done', chat.id), { label: 'correlated manual completion' });
    await control('/release', { path, command: 'compact' }); await done;
  }
  await control('/await-request', { path, command: 'prompt', count: expectedPrompts.length + 1 });
  await observed.wait(row => row.socketId === socketId && frameIs(row, 'queue', chat.id)
    && row.frame.items?.length === 1 && row.frame.items[0].text === 'rpc46-queued-tail',
  { after: settleMark, label: `${name} exactly one dequeued head` });
  await observed.wait(row => row.socketId === socketId && frameIs(row, 'ack', chat.id)
    && row.frame.requestId === queueBefore[0].requestId && row.frame.phase === 'completed',
  { after: settleMark, label: `${name} head acceptance and persistence completed` });
  const finalState = await emit([]);
  assert.equal(finalState.isStreaming, true, 'dispatched head owns the next run');
  const final = await control('/state');
  assert.deepEqual(final.sessions.find(row => row.path === path).prompts, [...expectedPrompts, 'rpc46-queued-head']);
  assert.equal(rows().filter(row => row.sequence > settleMark && frameIs(row, 'run.done', chat.id)).length, 1);
  await checkpointSibling('after-settlement-and-head-dispatch');
  result.final = final; result.passed = true;
  await writeFile(resolve(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export async function runRPC46Overflow({ evidenceDir, chromium, headless = true } = {}) {
  assert.ok(evidenceDir, '--evidence PATH is required');
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), scenarios: [], errors: [], cleanup: {} };
  let runtime, context, page, observed, failure;
  try {
    runtime = await startRuntime({ evidenceDir });
    context = await (chromium ?? await driver()).launchPersistentContext(resolve(runtime.root, 'chrome-profile'), {
      channel: 'chrome', headless, viewport: { width: 1280, height: 800 }, timeout: 15_000,
    });
    context.setDefaultTimeout(deadline);
    page = context.pages()[0] ?? await context.newPage(); observed = observeSockets(page);
    page.on('pageerror', error => report.errors.push(String(error)));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await page.goto(appURL, { waitUntil: 'domcontentloaded' });
    await page.locator('#th-password').fill('rpc46-qa-only');
    const login = page.waitForResponse(response => new URL(response.url()).pathname === '/api/login'
      && response.request().method() === 'POST');
    await page.locator('.th-login form button[type="submit"]').click();
    assert.ok((await login).ok());
    const initial = await request(context, fixtureURL + '/state');
    assert.equal(initial.root, runtime.root); assert.deepEqual(initial.sessions, []);
    for (const manual of [false, true]) for (const mobile of [false, true]) {
      report.scenarios.push(await exerciseOverflow({ page, context, observed, root: runtime.root, evidenceDir, manual, mobile }));
    }
    const terminalFailures = [];
    for (const terminalCase of ['reused-id', 'matched-replay']) for (const manual of [false, true]) {
      try {
        report.scenarios.push(await exerciseOverflow({ page, context, observed, root: runtime.root, evidenceDir, manual, terminalCase }));
      } catch (error) {
        const name = `${manual ? 'manual-successor' : 'active-run'}-desktop-${terminalCase}`;
        report.scenarios.push({ name, passed: false, failure: { message: error.message, stack: error.stack } });
        await page.screenshot({ path: resolve(evidenceDir, `${name}-failure.png`) });
        terminalFailures.push(error);
      }
    }
    report.protocolErrors = observed.timeline.filter(row => row.kind === 'socketerror'
      || (row.direction === 'received' && row.frame?.type === 'error'));
    assert.deepEqual(report.protocolErrors, [], 'no unexpected socket or application error frames');
    if (terminalFailures.length) throw new AggregateError(terminalFailures, 'RPC terminal identity regressions');
    assert.deepEqual(report.errors, [], 'no browser runtime errors');
    report.passed = true;
  } catch (error) {
    failure = error; report.passed = false; report.failure = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }); }
      catch (shotError) { report.errors.push(`failure screenshot: ${shotError}`); }
    }
  } finally {
    const cleanupErrors = [];
    if (observed) {
      report.protocolErrors = observed.timeline.filter(row => row.kind === 'socketerror'
        || (row.direction === 'received' && row.frame?.type === 'error'));
      await writeFile(resolve(evidenceDir, 'protocol-timeline.json'), JSON.stringify(observed.timeline, null, 2) + '\n');
      if (report.protocolErrors.length || report.errors.length) {
        report.passed = false;
        failure = new AggregateError([...(failure ? [failure] : []),
          new Error(JSON.stringify({ protocolErrors: report.protocolErrors, pageErrors: report.errors }))], 'Unexpected wire/page errors');
      }
    }
    if (runtime) {
      try {
        const queue = await readFile(resolve(runtime.root, 'state/queue-v1.json'), 'utf8');
        await writeFile(resolve(evidenceDir, 'durable-queue.json'), queue);
      } catch (error) {
        if (error.code === 'ENOENT') report.cleanup.queueSnapshot = 'not created before failure';
        else cleanupErrors.push(error);
      }
    }
    if (context) {
      try { await context.tracing.stop({ path: resolve(evidenceDir, 'trace.zip') }); }
      catch (error) { cleanupErrors.push(error); }
      try { await context.close(); report.cleanup.chromeContextClosed = true; report.cleanup.profileRemovedByRuntime = true; }
      catch (error) { cleanupErrors.push(error); }
    }
    observed?.stop();
    if (runtime) {
      try { report.cleanup.runtime = await runtime.close(); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) { report.passed = false; report.cleanup.errors = cleanupErrors.map(String); failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'QA/cleanup failed'); }
    await writeFile(resolve(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.equal(args[0], '--evidence', 'usage: bun test/qa/rpc46-overflow.mjs --evidence PATH');
  assert.equal(args.length, 2, 'usage: bun test/qa/rpc46-overflow.mjs --evidence PATH');
  await runRPC46Overflow({ evidenceDir: args[1] });
  console.log('RPC46 overflow real-browser assertions passed; see report.json and runtime-cleanup.json');
}
