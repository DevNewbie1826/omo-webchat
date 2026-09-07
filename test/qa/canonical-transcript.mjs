/** Actual-built-App canonical transcript proof. No backend/model/user session access.
 * CLI: bun test/qa/canonical-transcript.mjs --scenario canonical --port 25117 --evidence-dir PATH
 * Eval: await (await import('./test/qa/canonical-transcript.mjs')).runCanonicalTranscript({ evidenceDir: PATH });
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './pane-workspace-ui.mjs';

export const selectors = Object.freeze({
  users: '.th-chat-scrollport .th-chat-msg--user',
  scrollport: '.th-chat-scrollport', scrollBody: '.th-chat-scrollport .th-chat-body', status: '.th-chat-status',
  composer: '.th-chat-input', textarea: '.th-chat-input textarea',
  send: '.th-chat-send-btn', recover: '.th-failed-draft',
  request: '.th-chat-status .th-chat-send-status[data-request-id]', restoreUnknown: '.th-send-restore',
  queue: '.th-queue', queueHeader: '.th-queue-header', queueText: '.th-queue-text',
  steer: '.th-chat-status-item--steer', live: '.th-chat-status-item--live',
  pane: '.th-chat-pane', title: '.th-termhead-name', tree: '.th-tree-activation',
  sidebar: '.th-sidebar', backdrop: '.th-backdrop',
  closeNavigation: '.th-sidebar-nav-actions button[title="Collapse sidebar"]',
  expandNavigation: '.th-sidebar-rail .th-sidebar-toggle',
  thinking: '.th-chat-live .th-chat-thinking pre', streaming: '.th-chat-live .th-chat-msg--streaming',
  tools: '.th-chat-live .th-tool[data-tool-call-id]', queueRemove: '.th-queue-btn--remove',
});
export const scenarios = ['canonical', 'lifecycle', 'recovery', 'adjacent'];
const sessionId = 'stored-a';
const deadline = 10000;
const messageText = message => typeof message.content === 'string' ? message.content
  : message.content.filter(block => block.type === 'text').map(block => block.text).join('');

// Request objects, not URLs, own response/failure evidence. A reload keeps the
// same Frame object, so assign a fresh document identity on each committed navigation.
export function observeBrowserRequests(page, origin, errors) {
  const requests = [], events = [], documents = [], transitions = [], byRequest = new Map();
  let documentId = 0, activeTransition = null;
  const record = (type, details) => events.push({ sequence: events.length + 1, type, ...details });
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    documents.push({ documentId: ++documentId, url: frame.url(), ready: false });
    record('document', { documentId, url: frame.url(), transitionId: activeTransition });
  });
  page.on('request', request => {
    const value = { requestId: requests.length + 1, documentId, url: request.url(), method: request.method(),
      resourceType: request.resourceType(), navigation: request.isNavigationRequest(),
      mainFrame: request.frame() === page.mainFrame(), terminal: false };
    requests.push(value); byRequest.set(request, value); record('request', { ...value });
  });
  page.on('response', response => {
    const value = byRequest.get(response.request());
    value.response = { url: response.url(), status: response.status() };
    record('response', { requestId: value.requestId, documentId: value.documentId, ...value.response });
  });
  page.on('requestfinished', request => {
    const value = byRequest.get(request); value.terminal = true;
    record('requestfinished', { requestId: value.requestId, documentId: value.documentId });
  });
  page.on('requestfailed', request => {
    const value = byRequest.get(request); value.terminal = true;
    const error = { type: 'requestfailed', requestId: value.requestId, documentId: value.documentId,
      transitionId: activeTransition, url: request.url(), failure: request.failure() };
    errors.push(error); record('requestfailed', error);
  });
  function classification(error) {
    const request = requests.find(value => value.requestId === error.requestId);
    // Chrome reports ERR_ABORTED after the fixture's bodyless 204 fetch even
    // before navigation. apiVoid/checkAuth already accepted those headers. Do
    // not infer success from the URL, a later request, or a cleanup time window.
    const expected = error.failure?.errorText === 'net::ERR_ABORTED'
      && request.mainFrame && !request.navigation && request.resourceType === 'fetch' && request.method === 'GET'
      && request.url === new URL('/api/auth/check', origin).href
      && request.response?.url === request.url && request.response.status === 204
      && documents.some(value => value.documentId === request.documentId && value.ready);
    return { requestId: error.requestId, documentId: error.documentId, expected,
      reason: expected ? 'auth-204-no-content-disposal' : 'unexpected-request-failure' };
  }
  return {
    requests, events, documents, transitions,
    markReady() { documents.find(value => value.documentId === documentId).ready = true; record('app-ready', { documentId }); },
    beginTransition(kind) {
      const transition = { transitionId: transitions.length + 1, kind, fromDocumentId: documentId,
        pendingRequestIds: requests.filter(value => !value.terminal).map(value => value.requestId), completed: false };
      transitions.push(transition); activeTransition = transition.transitionId;
      record('transition-start', { ...transition }); return activeTransition;
    },
    endTransition(id) {
      const transition = transitions.find(value => value.transitionId === id);
      transition.completed = true; transition.toDocumentId = documentId;
      record('transition-end', { ...transition }); activeTransition = null;
    },
    classifications: () => errors.filter(error => error.type === 'requestfailed').map(classification),
    unexpectedErrors: () => errors.filter(error => error.type !== 'requestfailed' || !classification(error).expected),
  };
}

// Shared by the actual scenario and action-boundary regressions.
export async function submitTranscriptInput(page, kind) {
  if (kind !== 'steer' && page.viewportSize().width <= 768) {
    // Mobile Enter is a newline. During a run the button is Stop, not Send;
    // a mobile queue scenario must start with an idle Send and server backlog.
    assert.equal(await page.locator(selectors.send).getAttribute('type'), 'submit', 'Requires idle mobile Send, never Stop');
    await page.locator(`${selectors.send}[type="submit"]`).click();
  } else {
    await page.locator(selectors.textarea).press(kind === 'steer' ? 'Meta+Enter' : 'Enter');
  }
}

export async function scrollTranscriptEdge(page, edge, index, { arm, done }) {
  const observed = await arm((state, args) => state.mounted.some(row => row.index === args.index)
    && (args.edge === 'top' ? state.scroll.top <= 1
      : state.scroll.height - state.scroll.clientHeight - state.scroll.top <= 1), { edge, index });
  // The outer scrollport is a layout wrapper; use real wheel input over the
  // overflow owner so the App and virtualizer observe the user's scroll event.
  const body = page.locator(selectors.scrollBody);
  const distance = await body.evaluate(node => node.scrollHeight);
  await body.hover(); await page.mouse.wheel(0, edge === 'top' ? -distance : distance);
  return done(observed);
}

// A responsive remount is a new subscriber, not a continuation of a pending
// send. Arm its fresh final-history boundary before resize and finish boot before
// the caller submits any new request at this viewport.
export async function bootTranscriptViewport(page, viewport, lastIndex, { arm, done }) {
  const ready = await arm((state, args) => state.viewport.width === args.viewport.width
    && state.viewport.height === args.viewport.height && state.modelReady && state.input !== undefined
    && state.mounted.some(row => row.index === args.lastIndex), { viewport, lastIndex },
  { type: 'entries', final: true, sessionId });
  await page.setViewportSize(viewport);
  return done(ready);
}

// This function runs in Chrome. Sample the fixed surfaces, not individual
// virtualized message rows: partial rows at a scrolled edge are legitimate.
export function inspectTranscriptVisibility({ selectors: s, withQueue }) {
  const sidebar = document.querySelector(s.sidebar);
  const drawerOpen = innerWidth <= 768 && !!sidebar && sidebar.getAttribute('aria-hidden') !== 'true';
  const regions = [s.scrollBody, s.status, s.composer, s.textarea, ...(withQueue ? [s.queue] : [])].map(selector => {
    const node = document.querySelector(selector);
    if (!node) return { selector, visible: false, points: [] };
    const r = node.getBoundingClientRect();
    let visible = r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) !== 1) visible = false;
    }
    // The scroll-to-bottom button is a legitimate sibling of the overflow
    // body inside this scrollport, not an external drawer covering the chat.
    const owner = selector === s.scrollBody ? document.querySelector(s.scrollport) : node;
    const points = [];
    for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      points.push({ x, y, owned: !!hit && owner.contains(hit), hit: hit ? `${hit.tagName}.${hit.className}` : null });
    }
    return { selector, visible, points };
  });
  // Inspect painted child content, not just the healthy outer status box.
  // Only raw-preview ellipsis is intentional; labels, icons and controls must fit.
  const status = document.querySelector(s.status), statusContents = [];
  const bounds = r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
  function inspect(node, kind, r) {
    let visible = r.width > 0 && r.height > 0;
    const clips = [];
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) !== 1) visible = false;
      const clipX = ancestor === status || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
      const clipY = ancestor === status || ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
      if (clipX || clipY) {
        clips.push({ className: ancestor.className, ...bounds(box), clipX, clipY });
        if (clipX && (r.x < box.x - 1 || r.right > box.right + 1)) visible = false;
        if (clipY && (r.y < box.y - 1 || r.bottom > box.bottom + 1)) visible = false;
      }
    }
    const points = [0.1, 0.5, 0.9].map(fraction => {
      const x = r.x + r.width * fraction, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, owned: !!hit && node.contains(hit) };
    });
    statusContents.push({ kind, className: node.className, rect: bounds(r), clips, visible, points });
  }
  function visit(node) {
    if (node.nodeType === 3) {
      if (!node.textContent.trim()) return;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) inspect(node.parentElement, 'text', rect);
      return;
    }
    const style = getComputedStyle(node);
    if (node.matches('.th-chat-send-preview') && style.overflowX === 'hidden' && style.textOverflow === 'ellipsis') {
      inspect(node, 'preview', node.getBoundingClientRect());
      return; // The allocated preview box must fit; the full raw text need not.
    }
    if (node.matches('button, .th-chat-status-spinner, svg')) inspect(node, 'control-or-icon', node.getBoundingClientRect());
    for (const child of node.childNodes) visit(child);
  }
  if (status) for (const child of status.childNodes) visit(child);
  return { drawerOpen, regions, statusContents };
}

export async function assertTranscriptUnobscured(page, withQueue = false) {
  const actual = await page.evaluate(inspectTranscriptVisibility, { selectors, withQueue });
  assert.equal(actual.drawerOpen, false, 'Mobile navigation is closed through the UI');
  for (const region of actual.regions) {
    assert.equal(region.visible, true, `Visible undimmed surface: ${region.selector}`);
    assert.ok(region.points.length > 0 && region.points.every(point => point.owned), `Unobscured surface: ${JSON.stringify(region)}`);
  }
  for (const content of actual.statusContents) {
    assert.ok(content.visible && content.points.every(point => point.owned), `Visible status child: ${JSON.stringify(content)}`);
  }
  return actual;
}

export async function closeMobileNavigation(page, { arm, done }) {
  if (await page.locator(selectors.backdrop).isVisible()) {
    const closed = await arm((state, unused, s) => !document.querySelector(s.backdrop)
      && document.querySelector(s.sidebar)?.getAttribute('aria-hidden') === 'true');
    await page.locator(selectors.closeNavigation).click();
    await done(closed);
  }
  return assertTranscriptUnobscured(page);
}

export function assertLateUnloadState(actual, { oldRequestId, pendingRequestId, before }) {
  const pending = actual.sendRequests.filter(request => request.requestId === pendingRequestId);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], before.sendRequests.find(request => request.requestId === pendingRequestId), 'B status/phase/spinner remain owned by B');
  assert.equal(pending[0].phase, 'sending'); assert.equal(pending[0].spinning, true);
  assert.equal(actual.sendType, 'button', 'B retains its prompt hold');
  assert.ok(!actual.sendRequests.some(request => request.requestId === oldRequestId));
  assert.equal(actual.recoveryIds.filter(id => id === oldRequestId).length, 1, 'Only A becomes recoverable');
  for (const key of ['input', 'users', 'live', 'thinking', 'streaming', 'tools', 'warnings']) {
    assert.deepEqual(actual[key], before[key], `Old unload preserves ${key}`);
  }
}

export function assertQueueHandoffState(actual, { item, input, users }) {
  assert.ok(actual.queueItems.some(value => value.id === item.id && value.requestId === item.requestId && value.text === item.text));
  assert.ok(actual.queueTexts.includes(item.text), 'Actual durable queue row is expanded');
  assert.ok(!actual.sendRequests.some(request => request.requestId === item.requestId));
  assert.ok(!actual.recoveryIds.includes(item.requestId));
  assert.equal(actual.input, input, 'Handoff cancels only the automatically restored copy');
  assert.deepEqual(actual.users, users, 'Handoff does not manufacture a canonical row');
  assert.ok(!actual.users.includes(item.text));
}

export function assertTranscriptPhase(actual, expected) {
  assert.deepEqual(actual.viewport, expected.viewport, 'Target viewport');
  assert.equal(actual.input, '', 'Submitted original is not restored in composer');
  const { request, queued } = expected;
  const owned = actual.sendRequests.filter(value => value.requestId === request.requestId);
  assert.equal(owned.length, 1, 'Exactly one status for this requestId');
  assert.equal(owned[0].phase, request.phase, 'Expected request phase');
  assert.equal(owned[0].spinning, false, 'Request words must not duplicate the run indicator');
  assert.ok(!actual.users.includes(request.original.trim()), 'No original transcript row before canonical commit');
  if (queued) {
    assert.equal(actual.live, true, 'Queue/steer belongs to a live run');
    assert.ok(actual.steer.some(text => text.includes(request.original)), 'Actual pending steer summary');
    assert.ok(actual.queueItems.some(item => item.id === queued.id && item.requestId === queued.requestId
      && item.text === queued.text), 'Authoritative queue item with exact requestId');
    assert.ok(actual.queueTexts.includes(queued.text), 'Expanded durable queue row, not a placeholder');
    assert.ok(!actual.sendRequests.some(value => value.requestId === queued.requestId), 'Queue handoff releases local send status');
    assert.ok(!actual.users.includes(queued.text), 'Queued original remains outside transcript');
  }
}

export async function captureTranscriptLayout(page, name, original, { assertions, shot, expected, evidence, screenshots }) {
  const verifyPhase = async () => {
    const visibility = await assertTranscriptUnobscured(page, !!expected.queued);
    assertions.push({ name: `${name}-unobscured`, actual: visibility });
    const actual = await page.evaluate(() => window.__canonicalQa.state());
    assertTranscriptPhase(actual, expected);
    assertions.push({ name: `${name}-phase`, expected, actual });
  };
  await verifyPhase();
  const rectangles = await page.evaluate(({ s, withQueue }) => {
    const rect = selector => {
      const element = document.querySelector(selector); if (!element) throw new Error(`Missing geometry: ${selector}`);
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    return { pane: rect(s.pane), scrollport: rect(s.scrollport), status: rect(s.status), composer: rect(s.composer), textarea: rect(s.textarea),
      ...(withQueue ? { queue: rect(s.queue) } : {}), viewport: { width: innerWidth, height: innerHeight } };
  }, { s: selectors, withQueue: !!expected.queued });
  const { pane, status, composer, textarea, scrollport, viewport } = rectangles;
  for (const [name, rect] of Object.entries({ status, composer, textarea, ...(rectangles.queue ? { queue: rectangles.queue } : {}) })) {
    assert.ok(rect.width > 0 && rect.height > 0, `${name} has visible area`);
    assert.ok(rect.x >= Math.max(0, pane.x) - 1 && rect.right <= Math.min(viewport.width, pane.right) + 1, `${name} horizontally contained`);
    assert.ok(rect.y >= Math.max(0, pane.y) - 1 && rect.bottom <= Math.min(viewport.height, pane.bottom) + 1, `${name} vertically contained`);
  }
  assert.deepEqual(viewport, expected.viewport, 'Layout is still at target viewport');
  if (rectangles.queue) {
    assert.ok(scrollport.bottom <= rectangles.queue.y + 1, 'Transcript does not overlap queue');
    assert.ok(rectangles.queue.bottom <= status.y + 1, 'Queue does not overlap status');
  }
  assert.ok(scrollport.bottom <= status.y + 1, 'Transcript does not overlap status');
  assert.ok(status.bottom <= composer.y + 1, 'Status does not overlap composer');
  assert.ok(textarea.y >= composer.y && textarea.bottom <= composer.bottom, 'Editor inside composer');
  if (original) {
    const accessible = await page.evaluate(({ selector, original }) => [...document.querySelectorAll(`${selector} [title], ${selector} [aria-label]`)]
      .some(node => [node.getAttribute('title'), node.getAttribute('aria-label')].some(value => value?.includes(original.trim()))), { selector: selectors.status, original });
    assert.ok(accessible, 'Truncated original remains accessible by title or aria-label');
    rectangles.fullOriginalAccessible = accessible;
  }
  assertions.push({ name, rectangles }); await verifyPhase(); await shot(name);
  for (const [label, selector] of [['status', selectors.status], ['composer', selectors.composer]]) {
    await verifyPhase();
    const path = `${name}-${label}.png`; await page.locator(selector).screenshot({ path: join(evidence, path) }); screenshots.push(path);
  }
  await verifyPhase();
}

// Installed automation driver only. Neither engine code nor a user Chrome profile is loaded.
export async function resolveChromeDriver() {
  const candidates = process.env.QA_PLAYWRIGHT ? [process.env.QA_PLAYWRIGHT] : [
    resolve(import.meta.dir, '../../node_modules/playwright-core/index.mjs'),
    resolve(import.meta.dir, '../../frontend/node_modules/playwright-core/index.mjs'),
    '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs',
    '/private/tmp/zcode-asar/node_modules/playwright-core/index.mjs',
  ];
  let driver;
  for (const candidate of candidates) {
    try { await access(candidate); driver = candidate; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(driver, 'Set QA_PLAYWRIGHT to an installed playwright-core index.mjs');
  const executablePath = process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
  return { driver, executablePath };
}

function installObservers({ selectors: s, deadline }) {
  localStorage.setItem('th-lang', 'en'); localStorage.setItem('th-ws-expanded', '["ws"]');
  const pending = new Map(), wire = [];
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    set onmessage(handler) {
      super.onmessage = handler ? event => {
        handler.call(this, event);
        const frame = JSON.parse(event.data); wire.push(frame);
        window.dispatchEvent(new CustomEvent('canonical:wire', { detail: frame }));
      } : null;
    }
    get onmessage() { return super.onmessage; }
  };
  const state = () => ({
    viewport: { width: innerWidth, height: innerHeight },
    modelReady: !!document.querySelector('.th-model-picker-btn'),
    users: [...document.querySelectorAll(s.users)].map(node => (node.querySelector('.th-chat-steer-text') ?? node).textContent.trim()),
    mounted: [...document.querySelectorAll(`${s.scrollport} .th-chat-row[data-index]`)].map(node => ({
      index: Number(node.dataset.index), text: node.textContent.trim(),
    })),
    scroll: (() => {
      const node = document.querySelector(s.scrollBody);
      return node ? { top: node.scrollTop, height: node.scrollHeight, clientHeight: node.clientHeight } : null;
    })(),
    status: document.querySelector(s.status)?.textContent ?? '',
    input: document.querySelector(s.textarea)?.value,
    sendType: document.querySelector(s.send)?.getAttribute('type'),
    sendRequests: [...document.querySelectorAll(s.request)].map(node => ({ requestId: node.dataset.requestId, phase: node.dataset.sendPhase,
      text: node.textContent, spinning: !!node.querySelector('.th-chat-status-spinner'), canRestore: !!node.querySelector(s.restoreUnknown) })),
    recovery: [...document.querySelectorAll(s.recover)].map(node => node.textContent),
    recoveryIds: [...document.querySelectorAll(s.recover)].map(node => node.dataset.requestId),
    queue: document.querySelector(s.queue)?.textContent ?? '',
    queueItems: wire.findLast(frame => frame.type === 'queue' && frame.sessionId === 'stored-a')?.items ?? [],
    queueTexts: [...document.querySelectorAll(`${s.queue} .th-queue-row:not(.th-queue-row--placeholder):not(.th-queue-row--engine) ${s.queueText}`)].map(node => node.textContent),
    steer: [...document.querySelectorAll(s.steer)].map(node => node.textContent),
    live: !!document.querySelector(s.live),
    thinking: document.querySelector(s.thinking)?.textContent ?? '',
    streaming: document.querySelector(s.streaming)?.textContent ?? '',
    tools: [...document.querySelectorAll(s.tools)].map(node => ({ id: node.dataset.toolCallId, running: node.classList.contains('th-tool--running') })),
    warnings: [...document.querySelectorAll('.th-chat-status-item--warn')].map(node => node.textContent),
    title: document.querySelector(s.title)?.textContent,
    wireCount: wire.length,
  });
  const arm = (key, source, args, match) => {
    if (pending.has(key)) throw new Error(`Observer already armed: ${key}`);
    const predicate = new Function('state', 'args', 'selectors', `return (${source})(state, args, selectors)`);
    // Resolve failures as data so a rejected deadline cannot become an unhandled promise
    // while the triggering Playwright action is still in progress.
    pending.set(key, new Promise(resolve => {
      let wireReady = !match, renderFrame;
      const mo = new MutationObserver(check), ro = new ResizeObserver(check);
      const timer = setTimeout(() => finish({ ok: false, error: `DOM/wire deadline: ${key}`, state: state() }), deadline);
      function finish(result) {
        clearTimeout(timer); mo.disconnect(); ro.disconnect(); cancelAnimationFrame(renderFrame);
        window.removeEventListener('canonical:wire', receive);
        document.removeEventListener('input', check, true); document.removeEventListener('change', check, true);
        document.removeEventListener('scroll', check, true);
        resolve(result);
      }
      function check() {
        if (!wireReady) return;
        try { const current = state(); if (predicate(current, args, s)) finish({ ok: true, state: current }); }
        catch (error) { finish({ ok: false, error: String(error), state: state() }); }
      }
      function receive(event) {
        if (match && Object.entries(match).every(([key, value]) => JSON.stringify(event.detail[key]) === JSON.stringify(value))) {
          // One rendering opportunity after the actual App's onmessage handler, not a
          // retry/animation polling loop. Mutation/resize events observe later React commits.
          renderFrame = requestAnimationFrame(() => { wireReady = true; check(); });
        }
      }
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      if (document.documentElement) ro.observe(document.documentElement);
      for (const node of document.querySelectorAll(`${s.pane}, ${s.status}, ${s.composer}`)) ro.observe(node);
      window.addEventListener('canonical:wire', receive);
      document.addEventListener('input', check, true); document.addEventListener('change', check, true);
      document.addEventListener('scroll', check, true);
      check();
    }));
  };
  window.__canonicalQa = { state, wire, arm, async done(key) {
    const result = await pending.get(key); pending.delete(key); return result;
  } };
  arm('boot', (state, unused, s) => {
    if (state.input === undefined || !document.querySelector('.th-model-picker-btn') || !document.querySelector(s.scrollport)) return false;
    const entries = window.__canonicalQa.wire.findLast(frame => frame.type === 'entries' && frame.final && frame.sessionId === 'stored-a')?.entries;
    if (!entries) return false;
    const expected = entries.filter(entry => entry.type === 'message' && entry.message.role === 'user').map(entry => entry.message.content.trim());
    return entries.length <= 20 ? JSON.stringify(state.users) === JSON.stringify(expected)
      : state.mounted.some(row => row.index === entries.length - 1) && state.users.every(text => expected.includes(text));
  }, null, { type: 'entries', final: true, sessionId: 'stored-a' });
}

async function assetManifest(directory, prefix = '') {
  const files = [];
  for (const item of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(prefix, item.name);
    if (item.isDirectory()) files.push(...await assetManifest(directory, name));
    else files.push({ path: name, sha256: createHash('sha256').update(await readFile(join(directory, name))).digest('hex') });
  }
  return files;
}
async function assertPortReleased(port) {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  return { port, reboundAndClosed: true };
}

export async function runCanonicalTranscript({ scenario = 'canonical', port = 25117, evidenceDir,
  assetsDir = resolve(import.meta.dir, '../../frontend/dist') } = {}) {
  assert.ok(scenarios.includes(scenario), `Unknown scenario: ${scenario}`);
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid port');
  assert.ok(evidenceDir, 'An explicit evidenceDir is required');
  // A distinct attempt directory avoids overwriting a failed run's evidence.
  await mkdir(resolve(evidenceDir), { recursive: true });
  const evidence = await mkdtemp(join(resolve(evidenceDir), `${scenario}-`));
  const actions = [], assertions = [], screenshots = [], errors = [], resources = [], cleanup = [], browserFrames = [];
  const result = { scenario, evidence, pass: false, selectors, viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844 }] };
  const save = (name, value) => writeFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
  const log = (action, details = {}) => actions.push({ sequence: actions.length + 1, action, ...structuredClone(details) });
  function own(name, release) { resources.push({ name, release }); log('resource-created', { name }); }
  let fixture, browser, context, page, requestAudit, failure, sequence = 0;
  try {
    const runtime = await mkdtemp(join(tmpdir(), 'canonical-transcript-'));
    own('private-assets', async () => { await rm(runtime, { recursive: true }); return { removed: runtime }; });
    await access(join(assetsDir, 'index.html'));
    const before = await assetManifest(assetsDir);
    await cp(assetsDir, join(runtime, 'dist'), { recursive: true });
    const immutable = await assetManifest(join(runtime, 'dist'));
    assert.deepEqual(immutable, before, 'Build changed during the immutable snapshot');
    assert.deepEqual(await assetManifest(assetsDir), before, 'Build changed while QA copied its assets');
    await save('assets.json', { source: assetsDir, immutableCopy: true, files: immutable });
    fixture = startFixture({ port, layout: 'single', controlled: true, deferred: false, assetsDir: join(runtime, 'dist') });
    own('fixture', async () => {
      const receipt = await fixture.stop();
      return { ...receipt, ...await assertPortReleased(receipt.port) };
    });
    result.url = fixture.url;
    if (scenario === 'recovery') {
      fixture.deliver(sessionId, { type: 'message', message: { role: 'user', content: 'same-evidence' } });
      fixture.deliver(sessionId, { type: 'message', message: { role: 'assistant', content: 'old-completed-evidence' } });
    }
    if (scenario === 'adjacent') for (let i = 0; i < 160; i++) fixture.deliver(sessionId, {
      type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: `history-evidence-${i} ${'Long transcript content. '.repeat(12).trim()}` },
    });
    const driver = await resolveChromeDriver(); result.driver = driver;
    const { chromium } = await import(pathToFileURL(driver.driver).href);
    browser = await chromium.launch({ executablePath: driver.executablePath, headless: true, timeout: deadline });
    own('chrome', async () => { await browser.close(); return { privateProcessClosed: true }; });
    context = await browser.newContext({ viewport: result.viewports[0], reducedMotion: 'reduce' });
    own('private-context', async () => {
      const transition = requestAudit?.beginTransition('context-close');
      await context.close(); requestAudit?.endTransition(transition); return { privateContextClosed: true };
    });
    await context.addInitScript(installObservers, { selectors, deadline });
    page = await context.newPage(); page.setDefaultTimeout(deadline); page.setDefaultNavigationTimeout(deadline);
    let browserSocketSequence = 0;
    page.on('websocket', socket => {
      const socketId = ++browserSocketSequence;
      for (const [event, direction] of [['framereceived', 'received'], ['framesent', 'sent']]) socket.on(event, ({ payload }) => {
        browserFrames.push({ sequence: browserFrames.length + 1, socketId, direction, url: socket.url(), payload: String(payload) });
      });
    });
    page.on('pageerror', error => errors.push({ type: 'pageerror', message: String(error), stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console', message: message.text() }); });
    requestAudit = observeBrowserRequests(page, fixture.url, errors);
    async function done(key) {
      const observed = await page.evaluate(key => window.__canonicalQa.done(key), key);
      assert.ok(observed?.ok, JSON.stringify(observed));
      if (key === 'boot') requestAudit.markReady();
      return observed.state;
    }
    async function arm(predicate, args = null, match = null) {
      const key = `observation-${++sequence}`;
      await page.evaluate(({ key, source, args, match }) => window.__canonicalQa.arm(key, source, args, match), {
        key, source: String(predicate), args, match,
      });
      return key;
    }
    const state = () => page.evaluate(() => window.__canonicalQa.state());
    async function check(name, assertion) { const actual = await state(); assertion(actual); assertions.push({ name, actual }); return actual; }
    async function shot(name) {
      for (const boundary of ['before', 'after']) {
        const visibility = await assertTranscriptUnobscured(page, await page.locator(selectors.queue).count() > 0);
        assertions.push({ name: `${name}-${boundary}-capture-visible`, actual: visibility });
        if (boundary === 'before') {
          const path = `${name}.png`; await page.screenshot({ path: join(evidence, path), fullPage: true }); screenshots.push(path);
        }
      }
    }
    async function frame(value, predicate = () => true, args = null, id = sessionId) {
      const match = { ...value, sessionId: id };
      const observed = await arm(predicate, args, match);
      log('server-frame', { sessionId: id, frame: value }); fixture.deliver(id, value); return done(observed);
    }
    const canonical = () => fixture.runState(sessionId).entries.filter(entry => entry.message.role === 'user').map(entry => messageText(entry.message));
    async function assertCanonical(name, { virtual = false } = {}) {
      const expected = canonical();
      await check(name, actual => {
        if (!virtual) assert.deepEqual(actual.users, expected);
        else for (const row of actual.users) assert.ok(expected.includes(row), `Noncanonical mounted user row: ${row}`);
      });
      assertions.push({ name: `${name}-canonical-identities`, entries: fixture.runState(sessionId).entries.map(entry => ({ id: entry.id, role: entry.message.role, text: messageText(entry.message) })) });
    }
    async function send(text, kind = 'prompt') {
      if (scenario === 'adjacent') await assertTranscriptUnobscured(page, (await state()).queueItems.length > 0);
      const before = await state();
      await page.locator(selectors.textarea).fill(text);
      const request = fixture.wait('frame', value => value.type === 'chat.send' && value.sessionId === sessionId && value.run.message === text.trim());
      const visible = await arm((state, args, s) => state.input === '' && (args.kind === 'queue'
        ? !!document.querySelector(s.queue) : state.status.includes(args.preview)), { kind, preview: text.slice(0, 24) });
      log('submit', { text, kind, viewport: before.viewport, sendType: before.sendType, live: before.live });
      const [, captured] = await Promise.all([
        submitTranscriptInput(page, kind), request, done(visible),
      ]);
      assert.ok(captured.requestId); assert.equal(captured.run.kind, kind === 'steer' ? 'steer' : 'prompt');
      log('request-captured', { requestId: captured.requestId, frame: captured });
      await check('sending-state-owned-by-request-id', actual => assert.ok(actual.sendRequests.some(request => request.requestId === captured.requestId && request.phase === 'sending')));
      await check('no-new-original-before-server-commit', actual => {
        assert.equal(actual.users.filter(value => value === text.trim()).length, before.users.filter(value => value === text.trim()).length);
        if (scenario !== 'adjacent') assert.deepEqual(actual.users, before.users);
      });
      return { ...captured, original: text, preview: text.slice(0, 24) };
    }
    async function expandQueue(text) {
      const expanded = await arm((state, text) => state.queueTexts.includes(text), text);
      if (await page.locator(selectors.queueHeader).getAttribute('aria-expanded') !== 'true') await page.locator(selectors.queueHeader).click();
      await done(expanded);
    }
    const admitted = request => frame({ type: 'ack', command: 'chat.send', requestId: request.requestId, phase: 'admitted' },
      (state, id) => state.sendRequests.some(request => request.requestId === id && request.phase === 'admitted'), request.requestId);
    const complete = request => frame({ type: 'ack', command: 'chat.send', requestId: request.requestId, phase: 'completed' },
      (state, id) => !state.sendRequests.some(request => request.requestId === id), request.requestId);
    async function commit(text, { virtual = false } = {}) {
      const expectedCount = canonical().filter(value => value === text).length + 1;
      await frame({ type: 'message', message: { role: 'user', content: text } },
        (state, args) => state.users.filter(value => value === args.text).length === args.count, { text, count: virtual ? 1 : expectedCount });
      await assertCanonical('explicit-canonical-commit', { virtual });
    }
    async function reload(name) {
      const expected = canonical(), count = fixture.frames.filter(value => value.type === 'chat.send').length;
      log('reload', { expected }); const transition = requestAudit.beginTransition('reload');
      await page.reload(); requestAudit.endTransition(transition); await done('boot');
      await check('reload-canonical-sequence', actual => { assert.deepEqual(actual.users, expected); assert.equal(actual.input, ''); assert.deepEqual(actual.recovery, []); });
      assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, count);
      await shot(name);
    }
    async function reconnect({ hold = false, replay = false } = {}) {
      if (replay) fixture.holdReplay(sessionId);
      if (hold) fixture.holdHistory(sessionId);
      const subscription = fixture.wait('subscription', value => value.action === 'attach' && value.sessionId === sessionId);
      const closed = fixture.wait('subscription', value => value.action === 'close' && value.sessionId === sessionId).then(value => {
        if (hold) {
          // A real canonical commit while detached gives delayed-history installation
          // a positive DOM signal, rather than passing on an unchanged pre-replay DOM.
          fixture.deliver(sessionId, { type: 'message', message: { role: 'assistant', content: 'history-release-evidence' } });
          log('detached-canonical-history-marker');
        }
        return value;
      });
      const history = hold ? fixture.wait('history-held', value => value.sessionId === sessionId)
        : replay ? fixture.wait('replay-held', value => value.sessionId === sessionId) : null;
      const ready = await arm(() => true, null, { type: hold ? 'state' : 'entries', ...(hold ? {} : { final: true }), sessionId });
      const observed = Promise.all([closed, subscription, history, done(ready)]);
      log('disconnect', { holdHistory: hold, holdReplay: replay }); fixture.disconnect(sessionId);
      const [, attached, held] = await observed;
      log('reconnected', attached); return held;
    }
    const geometry = async (name, original, expected) => {
      await assertCanonical(`${name}-canonical-only`, { virtual: true });
      for (const text of [expected.request.original, expected.queued?.text].filter(Boolean)) {
        assert.ok(!canonical().includes(text.trim()), 'Fixture has not committed this original anywhere in history');
      }
      return captureTranscriptLayout(page, name, original ?? expected.request.original, { assertions, shot, expected, evidence, screenshots });
    };
    const navigation = requestAudit.beginTransition('goto');
    await page.goto(fixture.url); requestAudit.endTransition(navigation); await done('boot');
    log('app-ready', { viewport: page.viewportSize(), fixtureUrl: fixture.url });
    await shot('initial');

    if (scenario === 'canonical') {
      const ordinary = await send('ordinary-evidence'); await shot('ordinary-before-canonical');
      await admitted(ordinary); await commit('ordinary-evidence'); await complete(ordinary); await shot('ordinary-after-canonical');
      const expanded = await send('/wish evidence'); await shot('expanded-before-canonical');
      await admitted(expanded); await commit('expanded-evidence'); await complete(expanded);
      await check('no-command-bubble', actual => assert.ok(!actual.users.includes('/wish evidence')));
      await shot('expanded-after-canonical'); await reload('canonical-after-reload');
    }
    if (scenario === 'lifecycle') {
      const local = await send('/local-evidence'); await admitted(local); await shot('no-message-admitted');
      await complete(local);
      await check('no-message-terminal', actual => { assert.deepEqual(actual.users, []); assert.equal(actual.input, ''); assert.equal(actual.live, false); assert.equal(actual.sendType, 'submit'); });
      await shot('no-message-completed');
      const failed = await send('failed-evidence'); await commit('failed-evidence'); await commit('unrelated-lifecycle-evidence');
      await page.locator(selectors.textarea).fill('newer-unsent-evidence');
      const error = { type: 'error', command: 'chat.send', requestId: failed.requestId, code: 'send_failed', message: 'Controlled canonical QA failure' };
      await frame(error, (state, id) => state.recoveryIds.includes(id), failed.requestId);
      await assertCanonical('failure-preserves-canonical');
      await check('failure-preserves-newer-draft', actual => assert.equal(actual.input, 'newer-unsent-evidence'));
      const recoveryControl = page.locator(`${selectors.recover}[data-request-id="${failed.requestId}"]`);
      await recoveryControl.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.equal(await recoveryControl.evaluate(node => node.matches(':focus-visible')), true);
      await shot('failed-original-recoverable');
      const count = fixture.frames.filter(value => value.type === 'chat.send').length;
      const recovered = await arm((state, text) => state.input === text && !state.recovery.some(value => value.includes(text)), failed.original);
      await page.locator(`${selectors.recover}[data-request-id="${failed.requestId}"]`).click(); await done(recovered);
      await page.locator(selectors.textarea).fill('after-recovery-newer-draft');
      await frame(error);
      await check('recovery-exactly-once', actual => { assert.equal(actual.input, 'after-recovery-newer-draft'); assert.deepEqual(actual.recovery, []); });
      assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, count);
      await shot('recovered-once-no-resend');
      await page.locator(selectors.textarea).fill('');
      const late = await send('ack-before-canonical-evidence'); await admitted(late); await complete(late); await commit('canonical-after-ack-evidence');
      await frame({ type: 'run.started' }, state => state.live);
      await frame({ type: 'run.done', reason: 'stop' }, state => !state.live);
      await assertCanonical('ack-message-order-independent'); await shot('lifecycle-final');
      for (const edit of ['none', 'before-error', 'between-frames', 'same-text']) {
        await page.locator(selectors.textarea).fill('');
        await check('handoff-starts-as-idle-local-prompt', actual => {
          assert.equal(actual.live, false); assert.equal(actual.sendType, 'submit'); assert.deepEqual(actual.queueItems, []);
        });
        const request = await send(`handoff-original-${edit}`);
        const sendCount = fixture.frames.filter(value => value.type === 'chat.send').length;
        const newer = `handoff-newer-${edit}`;
        if (edit === 'before-error') await page.locator(selectors.textarea).fill(newer);
        const error = { type: 'error', command: 'chat.send', requestId: request.requestId, code: 'send_failed', message: 'Controlled dispatch rejection before queue restoration' };
        await frame(error, (state, args) => state.recoveryIds.includes(args.id) && state.input === args.input,
          { id: request.requestId, input: edit === 'before-error' ? newer : request.original });
        await shot(`handoff-${edit}-error-before-snapshot`);
        if (edit === 'between-frames' || edit === 'same-text') await page.locator(selectors.textarea).fill(newer);
        if (edit === 'same-text') await page.locator(selectors.textarea).fill(request.original);
        const expectedInput = edit === 'none' ? '' : edit === 'same-text' ? request.original : newer;
        const users = (await state()).users;
        const item = { id: `handoff-item-${edit}`, requestId: request.requestId, text: request.original, hasImage: false, createdAt: 1 };
        const revision = fixture.runState(sessionId).queue.revision + 1;
        await frame({ type: 'queue', revision, items: [item], engine: { pendingMessageCount: 0, ordered: [] } },
          (state, id) => state.queueItems.some(item => item.requestId === id) && !state.recoveryIds.includes(id), request.requestId);
        await expandQueue(item.text);
        await check(`handoff-${edit}-owned-editor`, actual => assertQueueHandoffState(actual, { item, input: expectedInput, users }));
        await assertCanonical(`handoff-${edit}-canonical-only`); await shot(`handoff-${edit}-durable-queue`);
        // Remove the actual queue row through the App; removal is not send completion.
        const removed = fixture.wait('frame', value => value.type === 'chat.queue.remove' && value.sessionId === sessionId && value.itemId === item.id);
        const cleared = await arm(state => state.queueItems.length === 0 && state.queue === '', null,
          { type: 'queue', sessionId, revision: revision + 1, items: [] });
        await Promise.all([page.locator(`${selectors.queue} .th-queue-row`).filter({ hasText: item.text }).locator(selectors.queueRemove).click(), removed, done(cleared)]);
        await frame(error); await complete(request); await frame(error);
        await check(`handoff-${edit}-late-receipts-no-resend`, actual => {
          assert.equal(actual.input, expectedInput); assert.deepEqual(actual.queueItems, []);
          assert.ok(!actual.recoveryIds.includes(request.requestId)); assert.ok(!actual.sendRequests.some(value => value.requestId === request.requestId));
          assert.deepEqual(actual.users, users);
        });
        assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, sendCount);
      }
      result.synchronousSend = 'Requires the independent hook regression; not representable as a real asynchronous WebSocket delivery';
    }
    if (scenario === 'recovery') {
      const held = await reconnect({ hold: true });
      const pending = await send('same-evidence');
      const released = await arm((state, id) => state.mounted.some(row => row.text.includes('history-release-evidence'))
        && state.sendRequests.some(request => request.requestId === id && request.phase === 'sending') && state.sendType === 'button',
      pending.requestId, { type: 'entries', final: true, sessionId });
      fixture.releaseHistory(held.token, { entries: held.entries, final: false });
      fixture.releaseHistory(held.token, { entries: [], final: true }); await done(released);
      fixture.holdHistory(sessionId, false);
      await check('old-history-does-not-settle-new-request', actual => { assert.ok(actual.status.includes(pending.preview)); assert.deepEqual(actual.users, ['same-evidence']); });
      await shot('old-history-new-request-pending');
      await commit('unrelated-evidence');
      await check('unrelated-user-does-not-settle-request', actual => assert.ok(actual.status.includes(pending.preview)));
      await commit('expanded-recovery-evidence'); await complete(pending);
      const before = canonical(), count = fixture.frames.filter(value => value.type === 'chat.send').length;
      const retained = await reconnect({ replay: true });
      const replayed = await arm(() => true, null, { type: 'state', sessionId });
      fixture.releaseReplay(retained.token, { stateFirst: false }); await done(replayed); fixture.holdReplay(sessionId, false);
      await check('retained-success-no-draft-restoration', actual => { assert.deepEqual(actual.users, before); assert.equal(actual.input, ''); assert.deepEqual(actual.recovery, []); });
      assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, count);
      await shot('completed-transformed-reconnect');
      const repeated = [];
      for (const turn of [1, 2]) {
        const request = await send('same-evidence'); repeated.push(request.requestId);
        await admitted(request); await commit('same-evidence'); await complete(request); log('identical-turn', { turn, requestId: request.requestId });
      }
      assert.equal(new Set(repeated).size, 2);
      assert.equal(canonical().filter(text => text === 'same-evidence').length, 3);
      await reload('repeated-canonical-turns-reload');
      const unknown = await send('unknown-evidence'); const sends = fixture.frames.filter(value => value.type === 'chat.send').length;
      await reconnect();
      await check('unresolved-reconnect-no-automatic-resend-or-draft', actual => {
        assert.equal(actual.input, ''); assert.equal(actual.sendType, 'submit');
        const request = actual.sendRequests.find(request => request.requestId === unknown.requestId);
        assert.equal(request?.phase, 'unknown'); assert.equal(request.spinning, false); assert.equal(request.canRestore, true);
      });
      assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, sends);
      await assertCanonical('unknown-keeps-only-canonical'); await shot('unknown-reconnect-no-inferred-failure');
      for (const active of [false, true]) {
        const label = active ? 'live' : 'pending';
        await page.locator(selectors.textarea).fill('');
        const old = active ? await send('unload-A-live') : unknown;
        if (active) await reconnect();
        await check(`late-unload-${label}-A-unknown`, actual => {
          assert.equal(actual.sendRequests.find(value => value.requestId === old.requestId)?.phase, 'unknown');
          assert.equal(actual.live, false); assert.equal(actual.sendType, 'submit');
        });
        const pending = await send(`unload-B-${label}`);
        await commit(`unload-canonical-B-${label}`);
        if (active) {
          await frame({ type: 'run.started' }, state => state.live);
          await frame({ type: 'messageDelta', delta: { kind: 'thinking_delta', delta: 'unload-B-thinking' } }, state => state.thinking === 'unload-B-thinking');
          await frame({ type: 'messageDelta', delta: { kind: 'text_delta', delta: 'unload-B-streaming' } }, state => state.streaming === 'unload-B-streaming');
          await frame({ type: 'tool', toolCallId: 'unload-B-tool', toolName: 'bash', phase: 'start', args: { command: 'fixture-only' } },
            state => state.tools.some(tool => tool.id === 'unload-B-tool' && tool.running));
          await frame({ type: 'compaction.started' }, state => state.warnings.length > 0);
        }
        const newer = `unload-newer-draft-${label}`;
        await page.locator(selectors.textarea).fill(newer);
        const before = await state(), sendCount = fixture.frames.filter(value => value.type === 'chat.send').length;
        const error = { type: 'error', command: 'chat.send', requestId: old.requestId, code: 'session_unloaded', message: 'Controlled late operation unload for A' };
        await frame(error, (state, id) => state.recoveryIds.includes(id), old.requestId);
        await check(`late-unload-${label}-preserves-B`, actual => assertLateUnloadState(actual, {
          oldRequestId: old.requestId, pendingRequestId: pending.requestId, before,
        }));
        assert.equal(fixture.runState(sessionId).running, active);
        await assertCanonical(`late-unload-${label}-canonical-preserved`); await shot(`late-unload-${label}-B-preserved`);
        const recovered = await arm((state, args) => state.input === args.original && !state.recoveryIds.includes(args.id), { original: old.original, id: old.requestId });
        await page.locator(`${selectors.recover}[data-request-id="${old.requestId}"]`).click(); await done(recovered);
        await page.locator(selectors.textarea).fill(newer); await frame(error);
        await check(`late-unload-${label}-A-recovered-once`, actual => {
          assert.equal(actual.input, newer); assert.ok(!actual.recoveryIds.includes(old.requestId));
          assert.equal(actual.sendRequests.find(value => value.requestId === pending.requestId)?.phase, 'sending');
        });
        await complete(pending);
        await check(`late-unload-${label}-B-terminal-independent`, actual => { assert.equal(actual.live, active); assert.equal(actual.input, newer); });
        if (active) await frame({ type: 'compaction.done' }, state => state.warnings.length === 0);
        await frame({ type: 'run.done', reason: 'stop' }, state => !state.live && state.sendType === 'submit');
        assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, sendCount);
      }
    }
    if (scenario === 'adjacent') {
      async function resizeAndBoot(viewport) {
        log('viewport-boot-start', { viewport });
        const actual = await bootTranscriptViewport(page, viewport, fixture.runState(sessionId).entries.length - 1, { arm, done });
        assertions.push({ name: 'viewport-remount-boot-complete', actual });
        log('viewport-boot-complete', { viewport });
        if (viewport.width === 390) {
          log('close-mobile-navigation-through-ui');
          const visibility = await closeMobileNavigation(page, { arm, done });
          assertions.push({ name: 'mobile-navigation-closed-chat-unobscured', actual: visibility });
        }
      }
      for (const [index, viewport] of result.viewports.entries()) {
        const label = index === 0 ? 'desktop' : 'mobile';
        if (index > 0) await resizeAndBoot(viewport);
        const long = await send(`long-preview-${label}-evidence ` + 'readable-original '.repeat(30));
        await geometry(`long-history-${label}-sending`, long.original, { viewport, request: { ...long, phase: 'sending' } });
        await complete(long);
        // Desktop retains active-run Enter queuing. Mobile has no such action:
        // model the bridge's existing idle-with-durable-backlog admission route.
        // This pre-existing item is fixture queue state, never a canonical entry
        // or a local mobile submission. The new Q still comes from real Send.
        const backlog = index === 0 ? null : { id: 'existing-mobile-backlog-item', requestId: 'existing-mobile-backlog-request',
          text: 'existing-mobile-backlog', hasImage: false, createdAt: 0 };
        if (backlog) {
          await frame({ type: 'queue', revision: fixture.runState(sessionId).queue.revision + 1, items: [backlog], engine: { pendingMessageCount: 0, ordered: [] } },
            (state, id) => state.queueItems.some(item => item.requestId === id), backlog.requestId);
          await expandQueue(backlog.text);
          const actual = await check('mobile-existing-backlog-before-real-Send', actual => {
            assert.equal(actual.live, false); assert.equal(actual.sendType, 'submit'); assert.equal(actual.input, '');
            assert.deepEqual(actual.queueItems, [backlog]); assert.ok(actual.queueTexts.includes(backlog.text));
          });
          const server = fixture.runState(sessionId);
          assert.equal(server.running, false); assert.deepEqual(server.queue.items, [backlog]);
          log('mobile-authoritative-backlog-before-Send', { backlog, server, actual });
        } else await frame({ type: 'run.started' }, state => state.live);
        const queued = await send(index === 0 ? 'queued-evidence' : 'queued-mobile-evidence', backlog ? 'prompt' : 'queue');
        await admitted(queued);
        const item = { id: `queued-item-${label}-evidence`, requestId: queued.requestId, text: queued.original, hasImage: false, createdAt: index + 1 };
        await frame({ type: 'queue', revision: fixture.runState(sessionId).queue.revision + 1, items: backlog ? [backlog, item] : [item], engine: { pendingMessageCount: 0, ordered: [] } },
          (state, id) => state.queueItems.some(item => item.requestId === id) && !state.sendRequests.some(request => request.requestId === id), queued.requestId);
        await expandQueue(queued.original);
        const users = (await state()).users;
        await check(`${label}-exact-queue-handoff`, actual => assertQueueHandoffState(actual, { item, input: '', users }));
        if (backlog) {
          log('mobile-existing-backlog-dispatch', { dispatched: backlog, remaining: item, server: fixture.runState(sessionId) });
          await frame({ type: 'queue', revision: fixture.runState(sessionId).queue.revision + 1, items: [item], engine: { pendingMessageCount: 0, ordered: [] } },
            (state, id) => state.queueItems.length === 1 && state.queueItems[0].requestId === id, queued.requestId);
          await frame({ type: 'run.started' }, state => state.live);
          await check('mobile-backlog-provider-live-Q-still-queued', actual => {
            assert.equal(actual.live, true); assert.equal(actual.sendType, 'button');
            assertQueueHandoffState(actual, { item, input: '', users });
            assert.ok(!canonical().includes(backlog.text));
          });
          assert.equal(fixture.runState(sessionId).running, true);
        }
        const steer = await send(index === 0 ? 'steer-evidence' : 'steer-mobile-evidence', 'steer'); await admitted(steer);
        const expected = { viewport, request: { ...steer, phase: 'admitted' }, queued: item };
        await geometry(`long-history-${label}-queue-steer`, null, expected);
        for (const [edge, targetIndex] of [['top', 0], ['bottom', fixture.runState(sessionId).entries.length - 1]]) {
          log('user-wheel-transcript', { viewport, edge, targetIndex, selector: selectors.scrollBody });
          const actual = await scrollTranscriptEdge(page, edge, targetIndex, { arm, done });
          await assertTranscriptUnobscured(page, true);
          assertTranscriptPhase(actual, expected);
          const entry = fixture.runState(sessionId).entries[targetIndex];
          assert.ok(actual.mounted.find(row => row.index === targetIndex).text.includes(messageText(entry.message)));
          assertions.push({ name: `long-history-${label}-${edge}-mounted-target`, canonicalEntryId: entry.id, actual });
          await geometry(`long-history-${label}-${edge}-pending`, null, expected);
        }
        await complete(steer); await check('steer-completed-does-not-stop-run', actual => { assert.equal(actual.live, true); assert.ok(!actual.status.includes(steer.preview)); });
        await commit(steer.original, { virtual: true });
        await frame({ type: 'queue', revision: fixture.runState(sessionId).queue.revision + 1, items: [], engine: { pendingMessageCount: 0, ordered: [] } },
          state => state.queueItems.length === 0 && state.queue === '');
        await commit(queued.original, { virtual: true }); await complete(queued);
        await frame({ type: 'run.done', reason: 'stop' }, state => !state.live);
      }
      // No unresolved sending/steer operation crosses a responsive remount.
      await resizeAndBoot(result.viewports[0]);
      // Closing the mobile drawer persists collapsed=true; restore desktop
      // navigation through its rail button before exercising session selection.
      if (await page.locator(selectors.expandNavigation).isVisible()) {
        const expanded = await arm((state, unused, s) => !document.querySelector(s.sidebar)?.classList.contains('th-sidebar--collapsed'));
        await page.locator(selectors.expandNavigation).click(); await done(expanded);
      }
      const failed = await send('failed-transition-evidence'); await page.locator(selectors.textarea).fill('A-newer-draft');
      await frame({ type: 'error', command: 'chat.send', requestId: failed.requestId, code: 'send_failed', message: 'Controlled transition failure' },
        (state, text) => state.recovery.some(value => value.includes(text)), failed.original);
      async function selectChat(name) {
        const id = name === 'Stored A' ? sessionId : 'newer';
        const observed = await arm((state, name) => state.title === name && state.input !== undefined
          && (name !== 'Stored A' || state.users.includes('queued-mobile-evidence')), name, { type: 'entries', final: true, sessionId: id });
        log('select-session', { name }); await page.locator(selectors.tree).filter({ hasText: new RegExp(`^${name}$`) }).click(); await done(observed);
      }
      const sendCount = fixture.frames.filter(value => value.type === 'chat.send').length;
      await selectChat('Newer'); await page.locator(selectors.textarea).fill('B-independent-draft');
      await selectChat('Stored A');
      await check('failed-original-follows-reopened-session', actual => { assert.equal(actual.input, 'A-newer-draft'); assert.ok(actual.recovery.some(value => value.includes(failed.original))); });
      const recovered = await arm((state, text) => state.input === text && !state.recovery.some(value => value.includes(text)), failed.original);
      await page.locator(`${selectors.recover}[data-request-id="${failed.requestId}"]`).click(); await done(recovered); await shot('failed-original-reopened-recovered');
      await selectChat('Newer'); await check('sibling-draft-unchanged', actual => assert.equal(actual.input, 'B-independent-draft'));
      assert.equal(fixture.frames.filter(value => value.type === 'chat.send').length, sendCount);
      await selectChat('Stored A'); await assertCanonical('adjacent-final-canonical', { virtual: true });
      await check('recovered-original-still-consumed-after-sibling-reentry', actual => {
        assert.equal(actual.input, failed.original); assert.ok(!actual.recoveryIds.includes(failed.requestId));
      });
      const sends = fixture.frames.filter(value => value.type === 'chat.send');
      assert.equal(sends.length, 7, 'Only the six desktop/mobile actions and one recovery-case submission');
      assert.equal(new Set(sends.map(value => value.requestId)).size, sends.length);
      assert.deepEqual(sends, actions.filter(value => value.action === 'request-captured').map(value => value.frame), 'No unsolicited resend');
      assert.ok(!fixture.frames.some(value => value.type === 'chat.abort'), 'No Send action clicked Stop');
      assertions.push({ name: 'adjacent-exact-sends-no-aborts-or-resend', sends, aborts: [] });
      await shot('adjacent-final');
    }
    await save('final-page-observed-wire.json', await page.evaluate(() => window.__canonicalQa.wire));
    assert.deepEqual(fixture.unexpected, [], 'Unexpected fixture traffic');
    assert.deepEqual(requestAudit.unexpectedErrors(), [], 'Unexpected browser errors');
  } catch (error) {
    failure = error; result.error = String(error); result.stack = error.stack;
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }); screenshots.push('failure.png'); }
      catch (captureError) { errors.push({ type: 'failure-capture', message: String(captureError) }); }
    }
  } finally {
    for (const resource of resources.reverse()) {
      try { cleanup.push({ resource: resource.name, pass: true, receipt: await resource.release() }); }
      catch (error) { cleanup.push({ resource: resource.name, pass: false, error: String(error) }); failure ??= error; }
    }
    if ((requestAudit?.unexpectedErrors() ?? errors).length || fixture?.unexpected.length) failure ??= new Error('Browser errors or unexpected traffic recorded during teardown');
    if (failure) { result.error ??= String(failure); result.stack ??= failure.stack; }
    result.pass = !failure;
    await Promise.all([
      save('result.json', result), save('actions.json', actions), save('assertions.json', assertions),
      save('screenshots.json', screenshots), save('errors.json', errors), save('cleanup.json', cleanup), save('browser-wire.json', browserFrames),
      save('browser-requests.json', requestAudit ? { requests: requestAudit.requests, events: requestAudit.events,
        documents: requestAudit.documents, transitions: requestAudit.transitions, classifications: requestAudit.classifications(),
        unexpectedErrors: requestAudit.unexpectedErrors() } : {}),
      save('traffic.json', fixture ? { requests: fixture.requests, frames: fixture.frames, traffic: fixture.traffic, unexpected: fixture.unexpected } : {}),
    ]);
  }
  if (failure) throw Object.assign(new Error(`${scenario} QA failed; evidence: ${evidence}`, { cause: failure }), { evidence });
  return result;
}

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--scenario': 'scenario', '--port': 'port', '--evidence-dir': 'evidenceDir' }[args[i]];
    assert.ok(key && args[i + 1], `Invalid CLI argument: ${args[i]}`);
    assert.ok(options[key] === undefined, `Duplicate CLI option: ${args[i]}`);
    options[key] = key === 'port' ? Number(args[i + 1]) : args[i + 1];
  }
  return options;
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await runCanonicalTranscript(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
