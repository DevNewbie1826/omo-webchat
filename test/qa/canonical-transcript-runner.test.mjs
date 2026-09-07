import { test, expect } from 'bun:test';
import { EventEmitter, once } from 'node:events';
import { runInNewContext } from 'node:vm';
import * as runner from './canonical-transcript.mjs';
import { handleChatComposerKeyDown } from '../../frontend/src/features/split/chatComposerKeyboard.ts';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, runCanonicalTranscript, scenarios, selectors } from './canonical-transcript.mjs';

function requestHarness() {
  const page = new EventEmitter(), errors = [], origin = 'http://127.0.0.1:25118';
  const frame = { url: () => origin + '/' }; page.mainFrame = () => frame;
  const audit = runner.observeBrowserRequests(page, origin, errors);
  const navigate = () => page.emit('framenavigated', frame);
  navigate();
  function request(options = {}) {
    const values = { url: origin + '/api/auth/check', method: 'GET', resourceType: 'fetch', navigation: false,
      failure: { errorText: 'net::ERR_ABORTED' }, ...options };
    const req = { url: () => values.url, method: () => values.method, resourceType: () => values.resourceType,
      isNavigationRequest: () => values.navigation, frame: () => frame, failure: () => values.failure };
    page.emit('request', req); return req;
  }
  const respond = (req, status) => page.emit('response', { request: () => req, url: () => req.url(), status: () => status });
  const fail = req => page.emit('requestfailed', req);
  return { page, errors, audit, request, respond, fail, navigate };
}

test('captured auth 204 disposal is expected only after the same document reaches authenticated App boot', () => {
  const h = requestHarness(), request = h.request();
  h.respond(request, 204); h.fail(request);
  expect(h.audit.unexpectedErrors()).toHaveLength(1);
  h.audit.markReady();
  expect(h.audit.unexpectedErrors()).toEqual([]);
  expect(h.errors).toHaveLength(1);
  expect(h.errors[0]).toMatchObject({ type: 'requestfailed', failure: { errorText: 'net::ERR_ABORTED' } });
  expect(h.audit.classifications()).toMatchObject([{ expected: true, reason: 'auth-204-no-content-disposal', documentId: 1 }]);
});

test('same-URL failures cannot borrow another request response or another document readiness', () => {
  const h = requestHarness(), successful = h.request(), failed = h.request();
  h.respond(successful, 204); h.page.emit('requestfinished', successful); h.fail(failed); h.audit.markReady();
  expect(h.audit.unexpectedErrors()).toHaveLength(1);
  const old = h.request(); h.respond(old, 204);
  h.navigate(); const unready = h.request(); h.respond(unready, 204); h.fail(unready);
  h.navigate(); h.audit.markReady(); h.fail(old);
  expect(h.audit.unexpectedErrors()).toHaveLength(2);
  expect(new Set(h.audit.classifications().map(value => value.requestId)).size).toBe(3);
});

test('known completed auth disposal during explicit reload and context cleanup retains original document identity', () => {
  for (const kind of ['reload', 'context-close']) {
    const h = requestHarness(), old = h.request(); h.respond(old, 204); h.audit.markReady();
    const transition = h.audit.beginTransition(kind);
    if (kind === 'reload') h.navigate();
    h.fail(old); h.audit.endTransition(transition);
    expect(h.audit.unexpectedErrors()).toEqual([]);
    expect(h.errors[0]).toMatchObject({ documentId: 1, transitionId: transition });
    expect(h.audit.transitions[0]).toMatchObject({ kind, fromDocumentId: 1, completed: true });
    const unexpected = h.request(); h.fail(unexpected);
    expect(h.audit.unexpectedErrors()).toHaveLength(1);
  }
});

test('abort exemptions never hide auth endpoint errors, different endpoints, methods or network failures', () => {
  for (const options of [
    { status: undefined }, { status: 200 }, { status: 401 }, { status: 503 },
    { status: 204, failure: { errorText: 'net::ERR_CONNECTION_RESET' } },
    { status: 204, failure: { errorText: 'net::ERR_FAILED' } },
    { status: 204, url: 'http://127.0.0.1:25118/api/workspaces' },
    { status: 204, url: 'http://127.0.0.1:25119/api/auth/check' },
    { status: 204, method: 'POST' }, { status: 204, resourceType: 'document', navigation: true },
  ]) {
    const h = requestHarness(), request = h.request(options);
    if (options.status !== undefined) h.respond(request, options.status);
    h.audit.markReady(); const transition = h.audit.beginTransition('context-close');
    h.fail(request); h.audit.endTransition(transition);
    expect(h.audit.unexpectedErrors()).toHaveLength(1);
    expect(h.audit.classifications()[0].expected).toBe(false);
  }
  const h = requestHarness(); h.errors.push({ type: 'pageerror', message: 'real error' });
  expect(h.audit.unexpectedErrors()).toEqual(h.errors);
});

test('transcript edge action wheels the real scroll owner after arming the exact mounted-target observation', async () => {
  for (const [edge, index, top, distance] of [['top', 0, 0, -12000], ['bottom', 159, 11600, 12000]]) {
    const calls = [], state = { mounted: [{ index }], scroll: { top, height: 12000, clientHeight: 400 } };
    const page = {
      locator(selector) {
        expect(selector).toBe('.th-chat-scrollport .th-chat-body');
        return {
          evaluate: async fn => fn({ scrollHeight: state.scroll.height }),
          hover: async () => { calls.push('hover'); },
        };
      },
      mouse: { wheel: async (x, y) => { calls.push('wheel'); expect(x).toBe(0); expect(y).toBe(distance); } },
    };
    const observed = await runner.scrollTranscriptEdge(page, edge, index, {
      arm: async (predicate, args) => {
        calls.push('arm'); expect(predicate(state, args)).toBe(true);
        expect(predicate({ ...state, mounted: [{ index: 150 }] }, args)).toBe(false);
        expect(predicate({ ...state, scroll: { ...state.scroll, top: 1000 } }, args)).toBe(false);
        return 'exact-edge';
      },
      done: async key => { calls.push('done'); expect(key).toBe('exact-edge'); return state; },
    });
    expect(calls).toEqual(['arm', 'hover', 'wheel', 'done']); expect(observed).toBe(state);
  }
});

test('exact scenario CLI maps to the importable runner options without starting resources', () => {
  for (const scenario of scenarios) expect(parseArguments([
    '--scenario', scenario, '--port', '25117', '--evidence-dir', '/isolated/evidence',
  ])).toEqual({ scenario, port: 25117, evidenceDir: '/isolated/evidence' });
  expect(parseArguments(['--evidence-dir', '/isolated/evidence'])).toEqual({ evidenceDir: '/isolated/evidence' });
  expect(selectors.users).toBe('.th-chat-scrollport .th-chat-msg--user');
});

test('CLI rejects unknown flags, duplicate flags and missing option values', () => {
  expect(() => parseArguments(['--unknown', 'value'])).toThrow();
  expect(() => parseArguments(['--scenario', 'canonical', '--scenario', 'recovery'])).toThrow();
  expect(() => parseArguments(['--evidence-dir'])).toThrow();
});

test('runner rejects invalid invocation boundaries before creating resources', async () => {
  await expect(runCanonicalTranscript({ scenario: 'not-a-scenario' })).rejects.toThrow('Unknown scenario');
  await expect(runCanonicalTranscript({ port: NaN })).rejects.toThrow('Invalid port');
  await expect(runCanonicalTranscript({ port: -1 })).rejects.toThrow('Invalid port');
  await expect(runCanonicalTranscript()).rejects.toThrow('explicit evidenceDir');
});

test('missing built assets fail explicitly and produce cleanup/evidence without launching Chrome or a server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-transcript-runner-test-'));
  try {
    let failure;
    try { await runCanonicalTranscript({ evidenceDir: join(root, 'evidence'), assetsDir: join(root, 'missing-dist') }); }
    catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(failure.cause.code).toBe('ENOENT');
    const result = JSON.parse(await readFile(join(failure.evidence, 'result.json'), 'utf8'));
    const cleanup = JSON.parse(await readFile(join(failure.evidence, 'cleanup.json'), 'utf8'));
    const traffic = JSON.parse(await readFile(join(failure.evidence, 'traffic.json'), 'utf8'));
    expect(result.pass).toBe(false);
    expect(result.url).toBeUndefined();
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ resource: 'private-assets', pass: true });
    expect(traffic).toEqual({});
    await expect(access(cleanup[0].receipt.removed)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

// The geometry is deliberately healthy, as in recovery1/review.md's Chrome
// resize reproduction. Only lifecycle state distinguishes this false positive.
function layoutHarness({ adjacent = false, viewport = { width: 390, height: 844 }, afterShot = () => {} } = {}) {
  const request = { requestId: 'mobile-request', original: 'mobile-original', phase: adjacent ? 'admitted' : 'sending' };
  const queued = { id: 'mobile-queue-item', requestId: 'mobile-queued-request', text: 'mobile-queued-original' };
  const expected = { viewport, request, ...(adjacent ? { queued } : {}) };
  const state = { viewport, users: [], input: '', sendRequests: [{ requestId: request.requestId, phase: request.phase, spinning: false }],
    live: adjacent, steer: adjacent ? [request.original] : [],
    queueItems: adjacent ? [structuredClone(queued)] : [], queueTexts: adjacent ? [queued.text] : [] };
  const captures = [], assertions = [], screenshots = [];
  const rect = (y, height) => ({ x: 0, y, width: viewport.width, height, right: viewport.width, bottom: y + height });
  const rectangles = new Map([
    [selectors.pane, rect(0, viewport.height)], [selectors.scrollport, rect(0, 500)], [selectors.scrollBody, rect(0, 500)],
    [selectors.queue, rect(500, 80)], [selectors.status, rect(580, 80)],
    [selectors.composer, rect(660, 120)], [selectors.textarea, rect(660, 100)],
  ]);
  const blocked = new Set(), hidden = new Set(), hitOverrides = new Map(), overlay = { tagName: 'BUTTON', className: 'th-backdrop' };
  const nodes = new Map([...rectangles].map(([selector, r]) => [selector, {
    selector, tagName: 'DIV', className: selector, parentElement: null, childNodes: [],
    getBoundingClientRect: () => r, clientWidth: viewport.width, scrollWidth: viewport.width,
    contains: hit => hit?.selector === selector || (selector === selectors.status && hit?.selector?.startsWith('child-')) || (selector === selectors.composer && hit?.selector === selectors.textarea)
      || (selector === selectors.scrollport && [selectors.scrollBody, '.th-chat-scroll-bottom'].includes(hit?.selector)),
  }]));
  // Child geometry is independent of outer boxes and textContent/state presence.
  const statusChildren = [];
  const addStatusChild = ({ kind = 'text', x = 14, right = 100, textRight = right, style = {}, parent = nodes.get(selectors.status) } = {}) => {
    const r = { x, y: 600, right, bottom: 612, width: right - x, height: 12 };
    const node = { selector: `child-${statusChildren.length}`, className: kind, tagName: kind === 'button' ? 'BUTTON' : 'SPAN',
      parentElement: parent, childNodes: [], style, getBoundingClientRect: () => r,
      contains(hit) { return hit === this || this.childNodes.some(child => child.contains?.(hit)); },
      matches(selector) { return selector.split(', ').includes(kind === 'preview' ? '.th-chat-send-preview' : kind === 'icon' ? '.th-chat-status-spinner' : kind); },
    };
    if (kind !== 'icon') node.childNodes.push({ nodeType: 3, textContent: 'fixture-content', parentElement: node,
      rect: { ...r, right: textRight, width: textRight - x } });
    parent.childNodes.push(node); statusChildren.push(node); return node;
  };
  addStatusChild();
  const page = {
    evaluate: async (fn, args) => structuredClone(runInNewContext(`(${fn}) (args)`, {
      args, innerWidth: viewport.width, innerHeight: viewport.height,
      window: { __canonicalQa: { state: () => structuredClone(state) } },
      getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: hidden.has(node.selector) ? '0.4' : '1', ...node.style }),
      document: {
        querySelector: selector => nodes.get(selector) ?? null,
        querySelectorAll: () => [{ getAttribute: () => request.original }],
        createRange: () => { let text; return { selectNodeContents: node => { text = node; }, getClientRects: () => [text.rect] }; },
        elementFromPoint: (x, y) => {
          for (const selector of [selectors.textarea, selectors.composer, selectors.status, selectors.queue, selectors.scrollBody]) {
            const node = nodes.get(selector), r = node.getBoundingClientRect();
            if (x >= r.x && x <= r.right && y >= r.y && y <= r.bottom) {
              if (blocked.has(selector) || (selector === selectors.textarea && blocked.has(selectors.composer))) return overlay;
              if (hitOverrides.has(selector)) return hitOverrides.get(selector);
              if (selector === selectors.status) return [...statusChildren].reverse().find(child => {
                const box = child.getBoundingClientRect(); return x >= box.x && x <= box.right && y >= box.y && y <= box.bottom;
              }) ?? node;
              return node;
            }
          }
          return null;
        },
      },
    })),
    locator: selector => ({ screenshot: async () => { captures.push(selector); } }),
  };
  const capture = () => runner.captureTranscriptLayout(page, 'phase-layout', request.original, {
    expected, assertions, screenshots, evidence: '/not-written', shot: async name => { captures.push(name); afterShot(state); },
  });
  return { state, expected, capture, captures, assertions, blocked, hidden, hitOverrides, page, nodes, addStatusChild };
}

test('layout capture rejects reproduced mobile unknown even with correct width and healthy rectangles', async () => {
  const h = layoutHarness();
  h.state.sendRequests[0].phase = 'unknown'; h.state.sendRequests[0].spinning = false;
  await expect(h.capture()).rejects.toThrow();
  expect(h.captures).toEqual([]);
});

test('layout capture requires exact request/phase, no duplicate ring, empty composer and absent original row', async () => {
  for (const corrupt of [
    h => { h.state.sendRequests[0].requestId = 'unrelated-request'; },
    h => { h.state.sendRequests.push({ ...h.state.sendRequests[0] }); },
    h => { h.state.sendRequests[0].phase = 'admitted'; },
    h => { h.state.sendRequests[0].spinning = true; },
    h => { h.state.users.push(h.expected.request.original); },
    h => { h.state.input = h.expected.request.original; },
    h => { h.state.viewport = { width: 1280, height: 800 }; },
  ]) {
    const h = layoutHarness(); corrupt(h);
    await expect(h.capture()).rejects.toThrow(); expect(h.captures).toEqual([]);
  }
});

test('queue/steer layout rejects unknown, missing live/steer feedback, placeholder-only or wrong-request queue and canonical originals', async () => {
  for (const corrupt of [
    h => { h.state.sendRequests[0].phase = 'unknown'; h.state.sendRequests[0].spinning = false; },
    h => { h.state.live = false; },
    h => { h.state.steer = []; },
    h => { h.state.queueItems = []; },
    h => { h.state.queueItems[0].requestId = 'another-queued-request'; },
    h => { h.state.queueItems[0].id = 'another-queue-item'; },
    h => { h.state.queueItems[0].text = 'another-original'; },
    h => { h.state.sendRequests.push({ requestId: h.expected.queued.requestId, phase: 'admitted', spinning: true }); },
    h => { h.state.queueTexts = []; },
    h => { h.state.users.push(h.expected.queued.text); },
  ]) {
    const h = layoutHarness({ adjacent: true }); corrupt(h);
    await expect(h.capture()).rejects.toThrow(); expect(h.captures).toEqual([]);
  }
});

test('exact desktop/mobile sending and admitted queue/steer state permits full and focused captures', async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) for (const adjacent of [false, true]) {
    const h = layoutHarness({ adjacent, viewport }); await h.capture();
    expect(h.captures).toEqual(['phase-layout', selectors.status, selectors.composer]);
    expect(h.assertions.some(value => value.rectangles?.viewport.width === viewport.width)).toBe(true);
  }
});

test('phase is rechecked between full and focused captures rather than trusting an earlier successful observation', async () => {
  const h = layoutHarness({ afterShot: state => { state.sendRequests[0].phase = 'unknown'; state.sendRequests[0].spinning = false; } });
  await expect(h.capture()).rejects.toThrow();
  expect(h.captures).toEqual(['phase-layout']);
});

test('viewport boot arms fresh session history before resize and cannot complete on width alone', async () => {
  const viewport = { width: 390, height: 844 }, calls = [];
  let signal, settle;
  const events = new EventEmitter();
  const awaitingHistory = once(events, 'await-history', { signal: AbortSignal.timeout(1000) });
  const history = once(events, 'history', { signal: AbortSignal.timeout(1000) }).then(([state]) => state);
  settle = state => events.emit('history', state);
  const state = { viewport, input: '', modelReady: true, mounted: [{ index: 159 }] };
  const page = { setViewportSize: async value => {
    calls.push('resize'); expect(value).toEqual(viewport); expect(signal.match).toEqual({ type: 'entries', final: true, sessionId: 'stored-a' });
    // Width/geometry may already be correct before the new subscriber's history.
    expect(signal.predicate(state, signal.args)).toBe(true);
  } };
  const boot = runner.bootTranscriptViewport(page, viewport, 159, {
    arm: async (predicate, args, match) => {
      calls.push('arm'); signal = { predicate, args, match };
      expect(predicate({ ...state, modelReady: false }, args)).toBe(false);
      expect(predicate({ ...state, mounted: [] }, args)).toBe(false);
      expect(predicate({ ...state, viewport: { width: 1280, height: 800 } }, args)).toBe(false);
      return 'fresh-history';
    },
    done: async key => { calls.push('await-history'); expect(key).toBe('fresh-history'); events.emit('await-history'); return history; },
  });
  const completed = boot.then(value => { calls.push('boot-complete'); return value; });
  // The prearmed signal controls completion; no time-based waiting or retries.
  await awaitingHistory; expect(calls).toEqual(['arm', 'resize', 'await-history']);
  settle(state); expect(await completed).toBe(state);
  expect(calls).toEqual(['arm', 'resize', 'await-history', 'boot-complete']);
});


test('healthy mobile geometry and exact phase cannot authorize screenshots through an open drawer or dimmed surface', async () => {
  for (const selector of [selectors.scrollBody, selectors.status, selectors.composer, selectors.textarea, selectors.queue]) {
    const h = layoutHarness({ adjacent: true }); h.blocked.add(selector);
    await expect(h.capture()).rejects.toThrow(); expect(h.captures).toEqual([]);
  }
  for (const dimmed of [selectors.composer, '.dimmed-parent']) {
    const h = layoutHarness(); h.hidden.add(dimmed);
    h.nodes.get(selectors.composer).parentElement = { selector: '.dimmed-parent', parentElement: null };
    await expect(h.capture()).rejects.toThrow(); expect(h.captures).toEqual([]);
  }
  const h = layoutHarness(); h.nodes.set(selectors.sidebar, { getAttribute: () => null });
  await expect(h.capture()).rejects.toThrow(); expect(h.captures).toEqual([]);
});


test('mobile navigation closes with a prearmed real close-button action, never a DOM/style mutation', async () => {
  for (const initiallyOpen of [true, false]) {
    const h = layoutHarness(), calls = [];
    let open = initiallyOpen, predicate;
    const sidebar = { getAttribute: () => open ? null : 'true' };
    h.nodes.set(selectors.sidebar, sidebar);
    const document = { querySelector: selector => selector === selectors.backdrop ? (open ? {} : null) : sidebar };
    const evaluateClosed = () => runInNewContext(`(${predicate})(null, null, s)`, { document, s: selectors });
    const events = new EventEmitter();
    const closed = initiallyOpen ? once(events, 'closed', { signal: AbortSignal.timeout(1000) }) : null;
    h.page.locator = selector => ({
      isVisible: async () => { expect(selector).toBe(selectors.backdrop); return open; },
      click: async () => {
        expect(selector).toBe(selectors.closeNavigation); expect(evaluateClosed()).toBe(false);
        calls.push('click'); open = false; events.emit('closed');
      },
    });
    const actual = await runner.closeMobileNavigation(h.page, {
      arm: async fn => { calls.push('arm'); predicate = fn; return 'closed'; },
      done: async key => { expect(key).toBe('closed'); await closed; calls.push('done'); expect(evaluateClosed()).toBe(true); },
    });
    expect(actual.drawerOpen).toBe(false);
    expect(calls).toEqual(initiallyOpen ? ['arm', 'click', 'done'] : []);
  }
});

test('fixed-surface visibility permits a normal clipped transcript edge and its own scroll-to-bottom control', async () => {
  const h = layoutHarness();
  h.state.mounted = [{ index: 0, text: 'partially visible edge row' }];
  const evaluate = h.page.evaluate;
  h.page.evaluate = async (fn, args) => {
    const value = await evaluate(fn, args);
    if (value?.regions) expect(value.regions.map(region => region.selector)).not.toContain('.th-chat-row');
    return value;
  };
  h.hitOverrides.set(selectors.scrollBody, { selector: '.th-chat-scroll-bottom', tagName: 'BUTTON', className: 'th-chat-scroll-bottom' });
  await h.capture(); expect(h.captures).toHaveLength(3);
});

test('late-unload guard rejects the preserved F1 B-hold loss and changed live surfaces while accepting A-only failure', () => {
  for (const live of [false, true]) {
    const b = { requestId: 'B', phase: 'sending', spinning: true };
    const before = { sendRequests: [{ requestId: 'A', phase: 'unknown', spinning: false }, b], input: 'newer draft', users: ['canonical B'],
      live, thinking: live ? 'B thinking' : '', streaming: live ? 'B streaming' : '', tools: live ? [{ id: 'B-tool', running: true }] : [], warnings: live ? ['compacting'] : [] };
    const actual = { ...structuredClone(before), sendRequests: [structuredClone(b)], sendType: 'button', recoveryIds: ['A'] };
    const expected = { oldRequestId: 'A', pendingRequestId: 'B', before };
    expect(() => runner.assertLateUnloadState(actual, expected)).not.toThrow();
    for (const corrupt of [
      state => { state.sendRequests[0].phase = 'unknown'; state.sendRequests[0].spinning = false; state.sendType = 'submit'; },
      state => { state.sendRequests[0].requestId = 'other'; },
      state => { state.recoveryIds = ['B']; },
      state => { state.input = 'A'; },
      state => { state.users = []; },
      state => { state.live = !live; },
      state => { state.thinking = 'changed'; },
      state => { state.streaming = 'changed'; },
      state => { state.tools = [{ id: 'other-tool', running: true }]; },
      state => { state.warnings = ['changed']; },
    ]) {
      const broken = structuredClone(actual); corrupt(broken);
      expect(() => runner.assertLateUnloadState(broken, expected)).toThrow();
    }
  }
});

test('queue-handoff guard rejects preserved F2 duplicate automatic originals but preserves newer and user-retyped text', () => {
  const item = { id: 'q-item', requestId: 'Q', text: 'original' }, users = ['canonical earlier'];
  for (const input of ['', 'newer draft', 'original']) {
    const actual = { queueItems: [item], queueTexts: [item.text], sendRequests: [], recoveryIds: [], input, users };
    const expected = { item, input, users };
    expect(() => runner.assertQueueHandoffState(actual, expected)).not.toThrow();
    for (const corrupt of [
      state => { state.input = input === '' ? 'original' : ''; },
      state => { state.queueItems[0].requestId = 'another-Q'; },
      state => { state.queueTexts = []; },
      state => { state.recoveryIds = ['Q']; },
      state => { state.sendRequests = [{ requestId: 'Q', phase: 'failed' }]; },
      state => { state.users.push('original'); },
    ]) {
      const broken = structuredClone(actual); corrupt(broken);
      expect(() => runner.assertQueueHandoffState(broken, expected)).toThrow();
    }
  }
});

// Use the actual composer keyboard handler, including its mobile default-action
// boundary. The page adapter models browser newline/form-submit and the existing
// editor's submit-versus-Stop button, not a mock that makes every Enter submit.
function composerActionHarness({ mobile, running = false }) {
  const frames = [], actions = [];
  let input = 'action-original';
  const submit = kind => { frames.push({ type: 'chat.send', run: { kind, message: input } }); input = ''; };
  const stop = () => frames.push({ type: 'chat.abort' });
  const page = {
    viewportSize: () => ({ width: mobile ? 390 : 1280, height: mobile ? 844 : 800 }),
    locator: selector => ({
      getAttribute: async name => {
        expect(selector).toBe(selectors.send); expect(name).toBe('type');
        return running ? 'button' : 'submit';
      },
      press: async chord => {
        expect(selector).toBe(selectors.textarea); actions.push(chord);
        let prevented = false;
        handleChatComposerKeyDown({ key: 'Enter', metaKey: chord === 'Meta+Enter', ctrlKey: false,
          shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true; } }, {
          isMobile: mobile, file: { open: false }, command: { open: false },
          run: { running, onSubmit: () => submit('prompt'), onSteer: () => submit('steer'), onStop: stop },
        });
        if (!prevented) input += '\n';
      },
      click: async () => {
        expect(selector).toBe(`${selectors.send}[type="submit"]`);
        actions.push('click-submit');
        // A mistaken broad button click must expose an abort, never fabricate a send.
        if (running) stop(); else submit('prompt');
      },
    }),
  };
  return { page, frames, actions, input: () => input };
}

test('runner mobile idle action uses the real submit button rather than newline Enter', async () => {
  const h = composerActionHarness({ mobile: true });
  await runner.submitTranscriptInput(h.page, 'prompt');
  expect(h.frames).toEqual([{ type: 'chat.send', run: { kind: 'prompt', message: 'action-original' } }]);
  expect(h.input()).toBe(''); expect(h.actions).toEqual(['click-submit']);
});

test('runner rejects mobile active queue action before pressing newline Enter or clicking Stop', async () => {
  const h = composerActionHarness({ mobile: true, running: true });
  await expect(runner.submitTranscriptInput(h.page, 'queue')).rejects.toThrow('idle mobile Send');
  expect(h.frames).toEqual([]); expect(h.actions).toEqual([]); expect(h.input()).toBe('action-original');
});

test('runner keeps desktop active Enter queue and actual mobile/desktop Meta-Enter steer', async () => {
  for (const mobile of [false, true]) for (const kind of mobile ? ['steer'] : ['queue', 'steer']) {
    const h = composerActionHarness({ mobile, running: true });
    await runner.submitTranscriptInput(h.page, kind);
    expect(h.frames).toEqual([{ type: 'chat.send', run: { kind: kind === 'steer' ? 'steer' : 'prompt', message: 'action-original' } }]);
    expect(h.input()).toBe(''); expect(h.actions).toEqual([kind === 'steer' ? 'Meta+Enter' : 'Enter']);
  }
});


test('status capture rejects the actual 366px mobile surface with steer content ending at 483px', async () => {
  const h = layoutHarness({ adjacent: true });
  const status = h.nodes.get(selectors.status);
  status.getBoundingClientRect = () => ({ x: 12, y: 580, right: 378, bottom: 660, width: 366, height: 80 });
  status.clientWidth = 366; status.scrollWidth = 473;
  h.addStatusChild({ x: 284.671875, right: 483.203125 });
  await expect(h.capture()).rejects.toThrow('Visible status child');
  expect(h.captures).toEqual([]);
});

test('status child guard distinguishes clipped glyphs, icons, controls and allocated previews from intentional raw ellipsis', async () => {
  for (const kind of ['text', 'icon', 'button', 'preview']) {
    const h = layoutHarness();
    h.addStatusChild({ kind, x: 350, right: 410, style: { overflowX: 'hidden', textOverflow: 'ellipsis' } });
    await expect(h.capture()).rejects.toThrow('Visible status child'); expect(h.captures).toEqual([]);
  }
  const clippedLabel = layoutHarness();
  clippedLabel.addStatusChild({ x: 200, right: 250, textRight: 300, style: { overflowX: 'hidden' } });
  await expect(clippedLabel.capture()).rejects.toThrow('Visible status child');
  const ellipsis = layoutHarness();
  ellipsis.addStatusChild({ kind: 'preview', x: 200, right: 250, textRight: 900, style: { overflowX: 'hidden', textOverflow: 'ellipsis' } });
  await ellipsis.capture(); expect(ellipsis.captures).toHaveLength(3);
});

test('status child guard rechecks content after full capture and rejects hidden children inside healthy surfaces', async () => {
  const h = layoutHarness({ afterShot: () => { h.addStatusChild({ kind: 'button', x: 380, right: 420 }); } });
  await expect(h.capture()).rejects.toThrow('Visible status child'); expect(h.captures).toEqual(['phase-layout']);
  const hidden = layoutHarness();
  const child = hidden.addStatusChild({ x: 200, right: 250 }); hidden.hidden.add(child.selector);
  await expect(hidden.capture()).rejects.toThrow('Visible status child'); expect(hidden.captures).toEqual([]);
});
