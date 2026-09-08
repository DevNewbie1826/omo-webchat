import { test, expect } from 'bun:test';
import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'node:fs';
import { syntheticKeyboard } from './ui-mobile-footer-polish.mjs';
import * as mobile from './ui-mobile-helpers.mjs';
const { measure, footerAssertions } = mobile;
import { pwaAssertions, cases, openActivityTab, openGoalBar, shelfExpectations,
  compactReachability, compactReachabilityAssertion, editorEndAssertion } from './ui-pwa-viewport.mjs';

// Execute the private driver verbatim, including in failing-first runs before
// adding synchronization; only browser geometry/event delivery is controlled.
const visualInputSource = readFileSync(new URL('./ui-pwa-viewport.mjs', import.meta.url), 'utf8')
  .match(/async function visualInput\([\s\S]*?\n}/)[0];
const visualInput = new Function('complete', 'settle', `return (${visualInputSource})`)(mobile.complete, mobile.settle);

const bounds = (left, top, right, bottom) => ({ x: left, y: top, left, top, right, bottom,
  width: right - left, height: bottom - top });
const expected = (overrides = {}) => ({ expectedKeyboard: false, mode: 'standalone',
  safeInsets: { top: 50, right: 0, bottom: 34, left: 0 },
  surface: bounds(0, 0, 375, 812), sidebarOpen: true, inputProfile: 'touch', ...overrides });

function signalOnAction(w, target, event) {
  w.mobileSignal = predicate => new Promise((resolve, reject) => {
    if (predicate()) { resolve(true); return; }
    const timer = setTimeout(() => { target.removeEventListener(event, finish); reject(new Error('Fixture action deadline')); }, 1000);
    function finish() {
      clearTimeout(timer);
      if (predicate()) resolve(true); else reject(new Error('Unsatisfied state after exact action event'));
    }
    target.addEventListener(event, finish, { once: true });
  });
}

// A real DOM supplies selectors, ancestry and style. Geometry alone is a fixture:
// independent input rectangles, not CSS emulation and never physical-device proof.
// The 762/812 baseline below comes from physical-diagnosis.json, not a product formula.
async function captured({ marker = false, bottom = 812, reserve = 34, expectation = expected(),
  mutations = {}, occlude = false, clip = false, mode = 'standalone', visualHeight,
  settingsBottom, entrance = false, capsuleReserve = 34, scrollDefect, exercise } = {}) {
  const dom = new JSDOM(`<html><body><div id="root"><div class="th-app">
    <aside class="th-sidebar"><div class="th-sidebar-body"></div><footer class="th-sidebar-footer">
      <div class="th-settings-menu"><button id="settings">Settings</button>
        ${settingsBottom === undefined ? '' : '<div class="th-settings-panel"><button id="setting-option">Option</button></div>'}
      </div><button id="logout">Logout</button>
    </footer></aside><main class="th-main"><div class="th-chat-pane th-pane--focused">
      <div class="th-chat-main-content"><div class="th-goal-panel"></div><div class="th-activity-panel"></div>
      <div class="th-chat-scrollport"><div class="th-chat-body"></div></div></div>
      <div class="th-chat-input"><div class="th-chat-input-inner"><textarea>retained draft</textarea><button>Send</button></div></div>
    </div></main><div class="th-backdrop"></div></div></div></body></html>`, { runScripts: 'outside-only' });
  const { window: w } = dom, d = w.document;
  const boxes = new Map(), top = expectation.surface.top, left = expectation.surface.left;
  const put = (selector, r) => { for (const e of d.querySelectorAll(selector)) boxes.set(e, r); };
  put('html, body, #root', bounds(left, top, left + 375, bottom));
  put('.th-app, .th-main, .th-chat-pane', bounds(left, top + 50, left + 375, bottom));
  put('.th-sidebar, .th-backdrop', bounds(left, top, left + 375, bottom));
  put('.th-sidebar-body', bounds(left, top + 50, left + 260, bottom - reserve - 37));
  put('.th-sidebar-footer', bounds(left, bottom - reserve - 37, left + 260, bottom - reserve));
  put('.th-settings-menu, #settings', bounds(left + 12, bottom - reserve - 29, left + 40, bottom - reserve));
  put('#logout', bounds(left + 60, bottom - reserve - 29, left + 88, bottom - reserve));
  put('.th-chat-input', bounds(left, bottom - 100, left + 375, bottom));
  put('.th-chat-input-inner', bounds(left + 12, bottom - 90, left + 350, bottom - capsuleReserve));
  put('.th-goal-panel', bounds(12, 246.84375, 363, 486.265625));
  put('.th-activity-panel', bounds(12, 565.40625, 363, 613.40625));
  put('.th-chat-scrollport, .th-chat-body', bounds(0, 94, 375, 214));
  put('.th-chat-main-content', bounds(0, 94, 375, 614));
  if (settingsBottom !== undefined) {
    put('.th-settings-panel', bounds(12, settingsBottom - 274.40625, 252, settingsBottom));
    put('#setting-option', bounds(20, settingsBottom - 40, 100, settingsBottom - 10));
  }
  put('textarea', bounds(left + 12, bottom - 90, left + 300, bottom - 45));
  put('.th-chat-input button', bounds(left + 310, bottom - 70, left + 340, bottom - 34));
  for (const [selector, patch] of Object.entries(mutations)) {
    const e = d.querySelector(selector), r = { ...boxes.get(e), ...patch };
    r.width = r.right - r.left; r.height = r.bottom - r.top; r.x = r.left; r.y = r.top; boxes.set(e, r);
  }
  for (const [e, r] of boxes) {
    e.getBoundingClientRect = () => ({ ...r, toJSON: () => ({ ...r }) });
    for (const [key, value] of Object.entries({ clientWidth: r.width, clientHeight: r.height,
      scrollWidth: r.width, scrollHeight: r.height })) Object.defineProperty(e, key, { value, configurable: true });
    e.style.padding = '0px'; e.style.border = '0px';
  }
  d.querySelector('.th-chat-scrollport').style.overflow = 'clip';
  const auxiliary = d.querySelector('.th-chat-main-content'); auxiliary.style.overflowY = 'auto';
  Object.defineProperty(auxiliary, 'scrollHeight', { value: 1400, configurable: true });
  const transcript = d.querySelector('.th-chat-body'); transcript.style.overflowY = 'auto';
  Object.defineProperty(transcript, 'scrollHeight', { value: 1200, configurable: true });
  transcript.scrollTo = ({ top }) => {
    transcript.scrollTop = top;
    if (scrollDefect === 'wrapper') d.querySelector('.th-chat-scrollport').scrollTop = top;
    if (scrollDefect === 'draft') d.querySelector('textarea').value = 'lost';
    transcript.dispatchEvent(new w.Event('scroll'));
  };
  if (scrollDefect === 'clip') transcript.style.overflowY = 'clip';
  const panel = d.querySelector('.th-settings-panel');
  let premature = false, subscriptions = 0;
  const animation = { playState: entrance ? 'running' : 'finished', animationName: 'th-settings-in',
    effect: { getComputedTiming: () => ({ endTime: 120 }) },
    get finished() { subscriptions++; return Promise.resolve().then(() => { animation.playState = 'finished'; }); } };
  if (panel) {
    panel.style.overflowY = 'auto';
    const r = boxes.get(panel);
    panel.getBoundingClientRect = () => {
      const shift = animation.playState === 'running' ? 4 : 0;
      if (shift) { premature = true; animation.playState = 'finished'; }
      const value = { ...r, y: r.y + shift, top: r.top + shift, bottom: r.bottom + shift };
      return { ...value, toJSON: () => value };
    };
    panel.scrollTo = ({ top }) => { panel.scrollTop = top; panel.dispatchEvent(new w.Event('scroll')); };
  }
  d.querySelector('.th-sidebar').getAnimations = () => [animation];
  Object.defineProperty(d, 'fonts', { value: { ready: Promise.resolve() } });
  if (marker) d.documentElement.setAttribute('data-th-keyboard-open', '');
  if (clip) { d.querySelector('.th-settings-menu').style.overflowY = 'hidden';
    Object.defineProperty(d.querySelector('.th-settings-menu'), 'clientHeight', { value: 10 }); }
  d.elementFromPoint = (x, y) => {
    if (occlude) return d.body;
    const controls = [...d.querySelectorAll('button, textarea')];
    return [...controls, d.querySelector('.th-sidebar'), d.querySelector('.th-backdrop'), d.querySelector('#root')]
      .find(e => { const r = boxes.get(e); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) ?? null;
  };
  Object.defineProperty(w, 'visualViewport', { value: Object.assign(new w.EventTarget(), {
    width: 375, height: visualHeight ?? (bottom === 762 ? 762 : expectation.surface.height),
    offsetTop: top, offsetLeft: left, scale: 1 }) });
  Object.defineProperty(w, 'innerWidth', { value: 375 }); Object.defineProperty(w, 'innerHeight', { value: 762 });
  Object.defineProperty(w.navigator, 'standalone', { value: mode === 'standalone' });
  w.matchMedia = query => ({ matches: query === '(max-width: 768px)' });
  const page = { evaluate: (fn, args) => { w.captureArgs = args; return w.eval(`(${fn})(captureArgs)`); },
    locator: selector => ({ evaluate: (fn, args) => {
      w.element = d.querySelector(selector); w.captureArgs = args; return w.eval(`(${fn})(element, captureArgs)`);
    } }) };
  try {
    if (exercise) return await exercise(page, () => ({ premature, subscriptions }), { window: w, boxes });
    return await measure(page, expectation.safeInsets.bottom, expectation.safeInsets.top, expectation);
  }
  finally { dom.window.close(); }
}
const row = (g, id) => footerAssertions(g).find(r => r.id === id);

test('wrong open marker plus missing reserve cannot agree themselves green', async () => {
  // Given a closed keyboard independently and a product falsely releasing reserve.
  const g = await captured({ marker: true, reserve: 0 });
  // When the actual measurement flows through the shipped footer validator.
  expect(row(g, 'C5.bottom-reserve').pass).toBe(false);
});
test('wrong closed marker plus stale reserve cannot agree themselves green', async () => {
  const g = await captured({ marker: false, reserve: 34, expectation: expected({ expectedKeyboard: true }) });
  expect(row(g, 'C5.bottom-reserve').pass).toBe(false);
});
test('visible 762 surface and correct internal 34 reserve pass independently of layout height 812', async () => {
  const g = await captured({ bottom: 762, expectation: expected({ visibleSurface: bounds(0, 0, 375, 762) }) });
  expect(row(g, 'C5.bottom-reserve').pass).toBe(true);
  expect(row(g, 'PWA.root-coverage').pass).toBe(true);
  expect(row(g, 'PWA.sidebar-coverage').pass).toBe(true);
});
for (const [selector, patch] of [
  ['#root', { bottom: 762 }], ['.th-app', { bottom: 762 }], ['.th-main', { bottom: 762 }],
  ['.th-chat-input', { bottom: 762 }], ['.th-backdrop', { bottom: 762 }],
  ['#root', { top: 50 }], ['.th-sidebar', { top: 50 }],
]) test(`coverage rejects independent rectangle mutation ${selector} ${JSON.stringify(patch)}`, async () => {
  const g = await captured({ mutations: { [selector]: patch } });
  const id = { '#root': 'root', '.th-app': 'app', '.th-main': 'main', '.th-chat-input': 'composer',
    '.th-backdrop': 'backdrop', '.th-sidebar': 'sidebar' }[selector];
  expect(row(g, `PWA.${id}-coverage`).pass).toBe(false);
});

test('correct full surface and single reserve pass together', async () => {
  const g = await captured();
  expect(footerAssertions(g).every(r => r.pass)).toBe(true);
});
for (const defect of [{ occlude: true }, { clip: true }]) test(`real DOM hit/clipping fixture rejects ${JSON.stringify(defect)}`, async () => {
  expect(row(await captured(defect), 'C5.controls-bounded-and-hit').pass).toBe(false);
});

for (const [marker, reserve, expectedKeyboard] of [[false, 34, false], [true, 0, true]]) {
  test(`independent reserve happy path keyboard=${expectedKeyboard}`, async () => {
    const g = await captured({ marker, reserve, expectation: expected({ expectedKeyboard }) });
    expect(row(g, 'C5.bottom-reserve').pass).toBe(true);
    expect(row(g, 'PWA.keyboard').pass).toBe(true);
  });
}
test('keyboard marker mismatch fails even when reserve independently happens to be correct', async () => {
  const g = await captured({ marker: true });
  expect(row(g, 'C5.bottom-reserve').pass).toBe(true);
  expect(row(g, 'PWA.keyboard').pass).toBe(false);
});
test('standalone expectation cannot be satisfied by browser mode', async () => {
  expect(row(await captured({ mode: 'browser' }), 'PWA.mode').pass).toBe(false);
});
test('left and right safe cutouts check full footer rectangles', async () => {
  const g = await captured({ expectation: expected({ safeInsets: { top: 50, right: 300, bottom: 34, left: 20 } }) });
  expect(g.safe.left).toBe(20); expect(g.safe.right).toBe(75);
  expect(g.controls.map(c => c.bounded)).toEqual([false, false]);
});
test('surface origin is applied once, not twice', async () => {
  const g = await captured({ bottom: 872, expectation: expected({ surface: bounds(7, 60, 382, 872) }) });
  expect(row(g, 'PWA.root-coverage').pass).toBe(true);
  expect(row(g, 'PWA.app-coverage').pass).toBe(true);
  expect(g.safe.top).toBe(110);
});
test('bottom hit coverage rejects a non-app hit independently of positive rectangles', async () => {
  const g = await captured({ occlude: true });
  expect(row(g, 'PWA.root-coverage').pass).toBe(true);
  expect(row(g, 'PWA.bottom-hit-coverage').pass).toBe(false);
});
for (const field of ['expectedKeyboard', 'mode', 'surface', 'safeInsets']) test(`independent contract requires ${field}`, async () => {
  const e = expected(); delete e[field];
  await expect(measure(null, 34, 50, e)).rejects.toThrow();
});
for (const [id, mutation] of [
  ['PWA.independent-insets', g => { g.resolvedSafeInsets.bottom = 0; }],
  ['PWA.raw-visual-variables', g => { g.cssViewport.heightUnit = '7.62px'; }],
  ['PWA.draft', g => { g.draft = 'lost draft'; }],
]) test(`runner ${id} assertion detects its named mutation`, async () => {
  // Given a known input capture; unit tests do not claim a browser CSS/env result.
  const g = await captured();
  g.resolvedSafeInsets = { top: 50, right: 0, bottom: 34, left: 0 };
  g.cssViewport = { heightUnit: '8.12px', width: '375px', top: '0px', left: '0px' };
  expect(pwaAssertions(g, 'retained draft').find(r => r.id === id).pass).toBe(true);
  // When exactly one measurement regresses, its own assertion (not any failure) rejects it.
  mutation(g);
  expect(pwaAssertions(g, 'retained draft').find(r => r.id === id).pass).toBe(false);
});

for (const missing of ['goal', 'activity', 'transcript']) test(`both-shelf proof rejects missing ${missing}`, async () => {
  const g = await captured(); g.expectations.bothShelves = true;
  g.shelves = { goal: { rect: { height: 80 } }, activity: { rect: { height: 100 } },
    transcript: { clientHeight: 120, scrollHeight: 1200 } };
  expect(pwaAssertions(g, 'retained draft').find(r => r.id === 'PWA.both-shelves-with-transcript').pass).toBe(true);
  g.shelves[missing] = null;
  expect(pwaAssertions(g, 'retained draft').find(r => r.id === 'PWA.both-shelves-with-transcript').pass).toBe(false);
});

test('explicit QA driver uses installed Chrome without session-report dependency', async () => {
  expect(mobile.mobileBrowserOptions).toBeTypeOf('function');
  const options = await mobile.mobileBrowserOptions('/fixture/explicit-playwright/index.js');
  expect(options).toEqual({ driver: '/fixture/explicit-playwright/index.js',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
});

for (const [width, height, rawHeight, safeTop, safeBottom, panelBottom] of [
  [375, 812, 762, 50, 34, 746], [390, 844, 794, 0, 0, 812],
]) test(`Settings ${width}: a layout-sized anchor must still fit the visible safe bottom`, async () => {
  const e = expected({ surface: bounds(0, 0, width, height), visibleSurface: bounds(0, 0, width, rawHeight),
    safeInsets: { top: safeTop, right: 0, bottom: safeBottom, left: 0 } });
  const result = await captured({ bottom: height, visualHeight: rawHeight, expectation: e, settingsBottom: panelBottom,
    exercise: page => mobile.settingsReachability(page, safeBottom, safeTop, e) });
  expect(result.actual.safe.bottom).toBe(rawHeight - safeBottom);
  expect(result.actual.panelBounded).toBe(false);
  expect(result.pass).toBe(false);
});

test('Settings entrance is finished before the first geometry sample, including stable scroll checks', async () => {
  const e = expected();
  const { result, state } = await captured({ settingsBottom: 746, entrance: true, exercise: async (page, state) => ({
    result: await mobile.settingsReachability(page, 34, 50, e), state: state(),
  }) });
  expect(state.premature).toBe(false);
  expect(state.subscriptions).toBe(1);
  expect(result.actual.stable).toBe(true);
  expect(result.pass).toBe(true);
});

for (const defect of ['bounds', 'hit', 'clip']) test(`Settings still rejects real ${defect} failure`, async () => {
  const e = expected();
  const result = await captured({ settingsBottom: defect === 'bounds' ? 800 : 746,
    occlude: defect === 'hit', clip: defect === 'clip',
    exercise: page => mobile.settingsReachability(page, 34, 50, e) });
  expect(result.pass).toBe(false);
});

test('R1 combined-panel capture measures the scrolling child, not its 120px clip wrapper', async () => {
  const g = await captured({ expectation: expected({ bothShelves: true }) });
  expect(g.shelves.goal.rect.height).toBeGreaterThan(0);
  expect(g.shelves.activity.rect.height).toBeGreaterThan(0);
  expect(g.shelves.transcript.overflowY).toBe('auto');
  expect(g.shelves.transcript.scrollHeight).toBe(1200);
  expect(pwaAssertions(g, 'retained draft').find(r => r.id === 'PWA.both-shelves-with-transcript').pass).toBe(true);
});

for (const defect of [undefined, 'wrapper', 'draft', 'clip']) test(`transcript exercise preserves wrapper/composer/draft: ${defect ?? 'correct owner'}`, async () => {
  const e = expected({ bothShelves: true });
  const result = await captured({ scrollDefect: defect,
    exercise: page => mobile.transcriptReachability(page, 34, 50, e) });
  expect(result.pass).toBe(defect === undefined);
  if (!defect) {
    expect(result.actual.before.transcript.scrollTop).toBe(0);
    expect(result.actual.after.transcript.scrollTop).toBe(1080);
    expect(result.actual.after.scrollport.scrollTop).toBe(0);
  }
});

test('composer reserve cannot pass without an independently declared input profile or a capsule', async () => {
  const g = await captured();
  const assertion = () => pwaAssertions(g, 'retained draft').find(r => r.id === 'PWA.composer-reserve');
  expect(assertion().pass).toBe(true);
  delete g.expectations.inputProfile; expect(assertion().pass).toBe(false);
  g.expectations.inputProfile = 'touch'; g.composerCapsule = null; expect(assertion().pass).toBe(false);
});

for (const [profile, inset, keyboard, reserve, pass] of [
  ['touch', 0, false, 0, false], ['touch', 0, false, 4, true],
  ['touch', 34, false, 34, true], ['touch', 34, false, 38, false],
  ['touch', 34, true, 4, true], ['touch', 34, true, 0, false],
  ['fine', 0, false, 16, true], ['fine', 34, false, 34, true], ['fine', 34, true, 16, true],
]) test(`composer capsule independently reserves max(breathing, necessary inset): ${profile}/${inset}/${keyboard}/${reserve}`, async () => {
  const g = await captured({ capsuleReserve: reserve, expectation: expected({ inputProfile: profile,
    expectedKeyboard: keyboard, safeInsets: { top: 50, right: 0, bottom: inset, left: 0 } }) });
  const assertion = pwaAssertions(g, 'retained draft').find(r => r.id === 'PWA.composer-reserve');
  expect(assertion).toBeDefined();
  expect(assertion.pass).toBe(pass);
});

test('phone identity is explicit in portrait and landscape; boundary and desktop inventory is retained', () => {
  expect(cases.map(c => c.width)).toEqual([375, 390, 768, 769, 812, 1280]);
  for (const width of [375, 390, 812]) {
    const input = cases.find(c => c.width === width);
    expect(input.isMobile).toBe(true); expect(input.hasTouch).toBe(true);
  }
  expect(cases.find(c => c.width === 769).insets.bottom).toBe(34);
  expect(cases.find(c => c.width === 1280).hasTouch).toBe(false);
});

for (const [width, height, visible] of [[390, 844, 500], [844, 390, 270]]) {
  test(`footer keyboard driver preserves the unoccluded layout witness ${width}x${height}`, async () => {
    const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
      .find(source => source.includes('data-th-keyboard-open'));
    const dom = new JSDOM('<textarea>retained draft</textarea>', { runScripts: 'outside-only' });
    const w = dom.window, vv = new w.EventTarget();
    let layoutHeight = height;
    Object.defineProperties(w, { innerWidth: { get: () => width }, innerHeight: { get: () => layoutHeight },
      visualViewport: { value: vv } });
    const prototype = Object.create(Object.getPrototypeOf(vv));
    Object.defineProperties(prototype, { width: { get: () => width }, height: { get: () => layoutHeight },
      offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, scale: { get: () => 1 } });
    Object.setPrototypeOf(vv, prototype);
    signalOnAction(w, vv, 'resize');
    const page = { evaluate: (fn, args) => { w.args = args; return w.eval(`(${fn})(args)`); },
      setViewportSize: ({ height }) => { layoutHeight = height; vv.dispatchEvent(new w.Event('resize')); w.dispatchEvent(new w.Event('resize')); } };
    try {
      w.eval(script); w.document.querySelector('textarea').focus();
      await syntheticKeyboard(page, { width, height, keyboard: true });
      expect(w.innerHeight).toBe(height); expect(vv.height).toBe(visible);
      expect(w.document.documentElement.hasAttribute('data-th-keyboard-open')).toBe(true);
      await syntheticKeyboard(page, { width, height, keyboard: false });
      expect(w.innerHeight).toBe(height); expect(vv.height).toBe(height);
      expect(Object.hasOwn(vv, 'height')).toBe(false);
      expect(w.document.documentElement.hasAttribute('data-th-keyboard-open')).toBe(false);
      expect(w.document.activeElement.value).toBe('retained draft');
    } finally { w.close(); }
  });
}

for (const [selected, open, compact] of [['agents', true, false], ['agents', false, true], ['todo', true, false]]) {
  test(`activity tab normalization selected=${selected} open=${open} compact=${compact}`, async () => {
    const dom = new JSDOM('<button data-activity-tab="agents"></button>', { runScripts: 'outside-only' });
    const w = dom.window, d = w.document, tab = d.querySelector('button');
    let current = selected, expanded = open, clicks = 0;
    const render = () => {
      tab.setAttribute('aria-selected', String(current === 'agents'));
      d.querySelector('.th-activity-resize')?.remove(); d.querySelector('[data-activity-tabpanel]')?.remove();
      if (expanded) {
        const grip = d.createElement('div'); grip.className = 'th-activity-resize'; d.body.append(grip);
        if (!compact) { const panel = d.createElement('div'); panel.dataset.activityTabpanel = current; d.body.append(panel); }
      }
    };
    render();
    signalOnAction(w, d, 'activity-action-complete');
    const page = { evaluate: (fn, args) => { w.args = args; return w.eval(`(${fn})(args)`); },
      locator: selector => ({ getAttribute: name => d.querySelector(selector).getAttribute(name),
        count: () => d.querySelectorAll(selector).length, click: () => {
          clicks++; expanded = current === 'agents' ? !expanded : true; current = 'agents'; render();
          d.dispatchEvent(new w.Event('activity-action-complete'));
        } }) };
    try {
      await openActivityTab(page);
      expect(current).toBe('agents'); expect(expanded).toBe(true);
      expect(clicks).toBe(selected === 'agents' && open ? 0 : 1);
    } finally { w.close(); }
  });
}

test('compact contract is declared from the input; ten feasible themed scenarios still demand both panels', () => {
  expect(cases.filter(c => shelfExpectations(c, 'goal-activity-long-transcript', true).bothShelves).length * 2).toBe(10);
  const compact = cases.filter(c => c.compactShelves);
  expect(compact.map(c => [c.width, c.height])).toEqual([[812, 375]]);
  expect(compact[0].restorationViewport).toEqual({ width: 812, height: 844 });
  expect(shelfExpectations(compact[0], 'compact-adequate-space', true).bothShelves).toBe(true);
  expect(shelfExpectations(compact[0], 'compact-return', true).compactShelves).toBe(true);
});

test('compact auxiliary measurement selects its actual shell rather than the transcript or clip wrapper', async () => {
  const g = await captured();
  expect(g.shelves.auxiliary.clientHeight).toBe(520);
  expect(g.shelves.auxiliary.scrollHeight).toBe(1400);
  expect(g.shelves.auxiliary.overflowY).toBe('auto');
  expect(g.shelves.transcript.scrollHeight).toBe(1200);
  expect(g.shelves.scrollport.scrollHeight).toBe(120);
});

for (const initial of [false, true]) test(`Goal normalization uses retained intent with floor-clamped aria-expanded: ${initial}`, async () => {
  const dom = new JSDOM('<button class="th-goal-bar" aria-expanded="false"><span class="th-activity-caret"></span></button>', { runScripts: 'outside-only' });
  const w = dom.window, d = w.document, caret = d.querySelector('span');
  let open = initial, clicks = 0;
  const render = () => caret.classList.toggle('th-activity-caret--open', open);
  render(); signalOnAction(w, d, 'goal-action-complete');
  const page = { evaluate: (fn, args) => { w.args = args; return w.eval(`(${fn})(args)`); },
    locator: selector => ({ count: () => d.querySelectorAll(selector).length,
      getAttribute: name => d.querySelector(selector).getAttribute(name), click: () => {
        clicks++; open = !open; render(); d.dispatchEvent(new w.Event('goal-action-complete'));
      } }) };
  try {
    await openGoalBar(page);
    expect(open).toBe(true); expect(clicks).toBe(initial ? 0 : 1);
    expect(d.querySelector('button').getAttribute('aria-expanded')).toBe('false');
  } finally { w.close(); }
});

for (const field of ['goalOpen', 'activityOpen', 'selectedTab']) test(`compact retained intent rejects lost ${field}`, async () => {
  const g = await captured();
  Object.assign(g.expectations, shelfExpectations(cases.find(c => c.compactShelves), 'goal-activity-long-transcript', true));
  g.shelves.goal = null; g.shelves.activity = null;
  g.shelfIntent = { goalOpen: true, activityOpen: true, selectedTab: 'agents' };
  const rows = () => pwaAssertions(g, 'retained draft');
  expect(rows().find(r => r.id === 'PWA.compact-floor-collapse').pass).toBe(true);
  expect(rows().some(r => r.id === 'PWA.both-shelves-with-transcript')).toBe(false);
  expect(rows().find(r => r.id === 'PWA.retained-shelf-intent').pass).toBe(true);
  g.shelfIntent[field] = field === 'selectedTab' ? 'todo' : false;
  expect(rows().find(r => r.id === 'PWA.retained-shelf-intent').pass).toBe(false);
});

for (const panel of ['goal', 'activity']) test(`adequate-space restoration still rejects missing ${panel}`, async () => {
  const g = await captured();
  Object.assign(g.expectations, shelfExpectations(cases.find(c => c.compactShelves), 'compact-adequate-space', true));
  g.shelfIntent = { goalOpen: true, activityOpen: true, selectedTab: 'agents' };
  const row = () => pwaAssertions(g, 'retained draft').find(r => r.id === 'PWA.both-shelves-with-transcript');
  expect(row().pass).toBe(true); g.shelves[panel] = null; expect(row().pass).toBe(false);
});

async function compactSamples() {
  const before = await captured();
  before.shelfIntent = { goalOpen: true, activityOpen: true, selectedTab: 'agents' };
  before.shelves.auxiliary = { clientHeight: 200, scrollHeight: 240, overflowY: 'auto', scrollTop: 0 };
  before.editor = { rect: bounds(12, 237, 300, 281), clientHeight: 44, scrollHeight: 61, scrollTop: 0,
    overflowY: 'auto', value: before.draft, focused: true, selectionStart: 14, selectionEnd: 14 };
  const after = structuredClone(before); after.shelves.auxiliary.scrollTop = 40; after.editor.scrollTop = 17;
  const controls = ['goal', 'todo', 'agents', 'dag', 'resize'].map(key => ({ key, bounded: true, unclipped: true, hit: true, disabled: false, scrollTop: 40 }));
  return { before, after, controls };
}

for (const defect of ['goalOpen', 'activityOpen', 'selectedTab', 'overflow', 'no-scroll', 'transcript', 'scrollport', 'root',
  'missing-control', 'bounded', 'unclipped', 'hit', 'disabled', 'draft', 'composer-top', 'composer-bottom', 'composer-safe']) {
  test(`compact auxiliary oracle rejects ${defect}`, async () => {
    const { before, after, controls } = await compactSamples();
    const row = () => compactReachabilityAssertion(before, after, controls);
    expect(row().pass).toBe(true);
    if (['goalOpen', 'activityOpen', 'selectedTab'].includes(defect)) after.shelfIntent[defect] = false;
    else if (defect === 'overflow') before.shelves.auxiliary.overflowY = 'clip';
    else if (defect === 'no-scroll') { after.shelves.auxiliary.scrollTop = 0; controls.forEach(c => { c.scrollTop = 0; }); }
    else if (['transcript', 'scrollport'].includes(defect)) after.shelves[defect].scrollTop++;
    else if (defect === 'root') after.root.scrollTop++;
    else if (defect === 'missing-control') controls.pop();
    else if (['bounded', 'unclipped', 'hit'].includes(defect)) controls[0][defect] = false;
    else if (defect === 'disabled') controls[0].disabled = true;
    else if (defect === 'draft') after.draft = 'lost';
    else if (defect === 'composer-safe') after.composerControls[0].bounded = false;
    else after.composer.rect[defect === 'composer-top' ? 'top' : 'bottom'] += 2;
    expect(row().pass).toBe(false);
  });
}

for (const defect of ['no-scroll', 'overflow', 'value', 'focus', 'selection', 'rect', 'composer', 'draft', 'root', 'hit', 'clip', 'bounds', 'remount']) {
  test(`compact editor end oracle rejects ${defect}`, async () => {
    const { before, after } = await compactSamples();
    let sameNode = true;
    const row = () => editorEndAssertion(before, after, sameNode);
    expect(row().pass).toBe(true);
    if (defect === 'no-scroll') after.editor.scrollTop = 0;
    else if (defect === 'overflow') after.editor.overflowY = 'hidden';
    else if (defect === 'value') after.editor.value = 'lost';
    else if (defect === 'focus') after.editor.focused = false;
    else if (defect === 'selection') after.editor.selectionEnd++;
    else if (defect === 'rect') after.editor.rect.top += 2;
    else if (defect === 'composer') after.composer.rect.top += 2;
    else if (defect === 'draft') after.draft = 'lost';
    else if (defect === 'root') after.root.scrollTop++;
    else if (defect === 'remount') sameNode = false;
    else after.composerControls[0][{ hit: 'hit', clip: 'unclipped', bounds: 'bounded' }[defect]] = false;
    expect(row().pass).toBe(false);
  });
}

for (const top of [0, 20]) test(`visible contract rejects correct reserve inside oversized standalone surface at origin ${top}`, async () => {
  const e = expected({ surface: bounds(0, 0, 375, 812), visibleSurface: bounds(0, top, 375, top + 762) });
  const g = await captured({ bottom: 812, visualHeight: 762, expectation: e });
  expect(row(g, 'C5.bottom-reserve').pass).toBe(true);
  expect(row(g, 'PWA.root-coverage').pass).toBe(false);
  expect(row(g, 'PWA.sidebar-coverage').pass).toBe(false);
  expect(row(g, 'C5.controls-bounded-and-hit').pass).toBe(false);
});
test('Settings cannot use an oversized declared layout to excuse invisible controls', async () => {
  const e = expected({ visibleSurface: bounds(0, 0, 375, 762) });
  const result = await captured({ settingsBottom: 746, visualHeight: 762, expectation: e,
    exercise: page => mobile.settingsReachability(page, 34, 50, e) });
  expect(result.actual.safe.bottom).toBe(728);
  expect(result.pass).toBe(false);
});
test('acceptance measurement does not insert hidden geometry probes', async () => {
  const e = expected();
  const added = await captured({ exercise: async page => {
    await page.evaluate(() => { window.addedQAElements = 0;
      window.qaObserver = new MutationObserver(records => { for (const r of records) window.addedQAElements += r.addedNodes.length; });
      window.qaObserver.observe(document.body, { childList: true, subtree: true });
    });
    await measure(page, 34, 50, e);
    return page.evaluate(() => { window.qaObserver.disconnect(); return window.addedQAElements; });
  } });
  expect(added).toBe(0);
});

test('painted canvas coverage is separate from a correctly shortened interactive root', async () => {
  const g = await captured({ bottom: 762, expectation: expected({ surface: bounds(0, 0, 375, 762),
    paintedSurface: bounds(0, 0, 375, 812) }) });
  g.canvas = { rect: bounds(0, 0, 375, 812), backgroundColor: 'rgb(24, 24, 24)', opacity: '1' };
  const painted = () => row(g, 'PWA.canvas-painted-coverage');
  expect(painted()?.pass).toBe(true);
  expect(row(g, 'PWA.root-coverage').pass).toBe(true);
  g.canvas.rect.bottom = 762; expect(painted().pass).toBe(false);
  g.canvas.rect.bottom = 812; g.canvas.backgroundColor = 'rgba(0, 0, 0, 0)'; expect(painted().pass).toBe(false);
});
test('surface validation rejects page pan independently of matching rectangles', async () => {
  const g = await captured(); g.pageScroll = { x: 0, y: 0 }; g.root.scrollTop = 0;
  expect(row(g, 'PWA.no-page-pan')?.pass).toBe(true);
  g.pageScroll.y = 10; expect(row(g, 'PWA.no-page-pan').pass).toBe(false);
});

for (const defect of [null, 'overflow', 'scroll', 'hit', 'clip', 'bounds', 'missing']) {
  test(`tab-only compact controls fit without scrolling: ${defect ?? 'valid'}`, async () => {
    const { before, after, controls } = await compactSamples();
    before.expectations.auxiliaryScrollRequired = false;
    for (const g of [before, after]) g.shelves.auxiliary = { clientHeight: 183, scrollHeight: 183, scrollTop: 0, overflowY: 'auto' };
    controls.forEach(c => { c.scrollTop = 0; });
    if (defect === 'overflow') before.shelves.auxiliary.scrollHeight++;
    if (defect === 'scroll') after.shelves.auxiliary.scrollTop++;
    if (defect === 'hit') controls[0].hit = false;
    if (defect === 'clip') controls[0].unclipped = false;
    if (defect === 'bounds') controls[0].bounded = false;
    if (defect === 'missing') controls.pop();
    expect(compactReachabilityAssertion(before, after, controls).pass).toBe(defect === null);
  });
}
for (const mode of ['following', 'pending-follow', 'interference', 'reading']) {
  test(`viewport resize-follow finishes before auxiliary baseline: ${mode}`, async () => {
    const e = expected({ auxiliaryScrollRequired: true });
    const trace = [];
    const result = await captured({ exercise: async (page, _, { window: w, boxes }) => {
      const d = w.document, transcript = d.querySelector('.th-chat-body');
      const auxiliary = d.querySelector('.th-chat-main-content');
      const reading = mode === 'reading';
      if (reading) {
        const button = d.createElement('button'); button.className = 'th-chat-scroll-bottom';
        transcript.parentElement.append(button);
      }
      let top = reading ? 1000 : 7768, baselineTaken = false;
      Object.defineProperties(transcript, {
        clientHeight: { value: mode === 'pending-follow' ? 48 : 70, configurable: true },
        scrollHeight: { value: 7838, configurable: true },
        scrollTop: { get: () => top, set: () => { throw new Error('QA must not force transcript scrolling'); } },
      });
      Object.defineProperties(auxiliary, { clientHeight: { value: 200, configurable: true },
        scrollHeight: { value: 249, configurable: true } });
      Object.assign(boxes.get(auxiliary), bounds(0, 94, 375, 294));
      for (const [index, key] of ['goal', 'todo', 'agents', 'dag', 'resize'].entries()) {
        const control = d.createElement('button');
        if (key === 'goal') {
          control.className = 'th-goal-bar';
          control.innerHTML = '<span class="th-activity-caret--open"></span>';
        } else if (key === 'resize') control.className = 'th-activity-resize';
        else { control.dataset.activityTab = key; control.setAttribute('aria-selected', String(key === 'agents')); }
        auxiliary.append(control);
        const r = bounds(12, 200 + index * 20, 100, 220 + index * 20);
        boxes.set(control, r);
        control.getBoundingClientRect = () => {
          const shifted = bounds(r.left, r.top - auxiliary.scrollTop, r.right, r.bottom - auxiliary.scrollTop);
          boxes.set(control, shifted);
          return { ...shifted, toJSON: () => shifted };
        };
        control.style.padding = '0px'; control.style.border = '0px';
      }
      // Native hit-testing sees the same scrolled rectangles as measurement.
      d.elementFromPoint = (x, y) => [...d.querySelectorAll('button, textarea')].find(control => {
        const r = control.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      }) ?? d.querySelector('#root');
      auxiliary.scrollTo = ({ top: target }) => {
        trace.push({ event: 'auxiliary-action', transcriptTop: top });
        auxiliary.scrollTop = target;
        if (mode === 'interference' && top === 7790) top -= 22;
        auxiliary.dispatchEvent(new w.Event('scroll'));
      };
      const subscribed = Promise.withResolvers(), baseline = Promise.withResolvers();
      const listeners = new Set(), observers = new Set();
      const add = transcript.addEventListener.bind(transcript), remove = transcript.removeEventListener.bind(transcript);
      transcript.addEventListener = (type, listener, options) => {
        if (type === 'scroll') { listeners.add(listener); subscribed.resolve('subscribed'); }
        add(type, listener, options);
      };
      transcript.removeEventListener = (type, listener, options) => {
        if (type === 'scroll') listeners.delete(listener);
        remove(type, listener, options);
      };
      w.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
        observe(element) { this.targets.add(element); }
        disconnect() { observers.delete(this); }
      };
      w.visualViewport.addEventListener('resize', () => {
        trace.push({ event: 'viewport-input', subscribed: listeners.size > 0,
          observed: [...observers].some(observer => observer.targets.has(transcript)) });
        Object.defineProperty(transcript, 'clientHeight', { value: 48, configurable: true });
      });
      const originalRect = transcript.getBoundingClientRect;
      transcript.getBoundingClientRect = () => {
        if (!baselineTaken) {
          baselineTaken = true;
          trace.push({ event: 'baseline', transcriptTop: top });
          baseline.resolve('baseline');
        }
        return originalRect();
      };
      const work = (async () => {
        await visualInput(page, { height: 270, offsetTop: 20 });
        return compactReachability(page, 34, 50, e);
      })();
      // Either the driver arms its scroll listener or the old driver reaches
      // the premature baseline. No clock, frame count or polling chooses this.
      let timer;
      try {
        await Promise.race([subscribed.promise, baseline.promise,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Resize fixture deadline')), 1000); })]);
        trace.push({ event: 'resize-delivery', transcriptTop: top });
        for (const observer of [...observers]) observer.callback([...observer.targets].map(target => ({ target })));
        // Inspect the actual promise state synchronously: a resize notification
        // alone must not release a still-pending follow. No microtask flushing.
        trace.push({ event: 'after-resize', pending: Bun.peek.status(w.mobilePending) });
        // The product's delayed ResizeObserver follow, not an auxiliary action,
        // is the sole writer before the independently sampled baseline.
        if (!reading) { top = 7790; trace.push({ event: 'natural-follow', transcriptTop: top });
          transcript.dispatchEvent(new w.Event('scroll')); }
        const row = await work;
        expect(listeners.size).toBe(0); expect(observers.size).toBe(0);
        return row;
      } finally { clearTimeout(timer); }
    } });
    console.log(JSON.stringify({ resizeFollow: mode, trace, pass: result.pass,
      before: result.actual.before.shelves.transcript.scrollTop, after: result.actual.after.shelves.transcript.scrollTop }));
    expect(trace[0]).toEqual({ event: 'viewport-input', subscribed: true, observed: true });
    expect(trace.find(event => event.event === 'after-resize').pending).toBe(mode === 'reading' ? 'fulfilled' : 'pending');
    expect(result.actual.before.shelves.transcript.scrollTop).toBe(mode === 'reading' ? 1000 : 7790);
    expect(result.actual.after.shelves.auxiliary.scrollTop).toBe(49);
    expect(result.pass).toBe(mode !== 'interference');
    if (mode === 'reading') expect(result.actual.after.shelves.transcript.scrollTop).toBe(1000);
    else expect(trace.findIndex(event => event.event === 'natural-follow'))
      .toBeLessThan(trace.findIndex(event => event.event === 'baseline'));
  });
}

test('compact matrix independently requires overflow only in the smaller keyboard surface', () => {
  const input = cases.find(c => c.compactShelves);
  expect(shelfExpectations(input, 'compact-controls-reachable', true).auxiliaryScrollRequired).toBe(false);
  expect(shelfExpectations(input, 'compact-return', true).auxiliaryScrollRequired).toBe(false);
  expect(shelfExpectations(input, 'keyboard', true).auxiliaryScrollRequired).toBe(true);
});
