import { test, expect } from 'bun:test';
import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';
import * as mobile from './ui-mobile-helpers.mjs';
const { measure, footerAssertions } = mobile;
import { pwaAssertions } from './ui-pwa-viewport.mjs';

const bounds = (left, top, right, bottom) => ({ x: left, y: top, left, top, right, bottom,
  width: right - left, height: bottom - top });
const expected = (overrides = {}) => ({ expectedKeyboard: false, mode: 'standalone',
  safeInsets: { top: 50, right: 0, bottom: 34, left: 0 },
  surface: bounds(0, 0, 375, 812), sidebarOpen: true, ...overrides });

// A real DOM supplies selectors, ancestry and style. Geometry alone is a fixture:
// independent input rectangles, not CSS emulation and never physical-device proof.
// The 762/812 baseline below comes from physical-diagnosis.json, not a product formula.
async function captured({ marker = false, bottom = 812, reserve = 34, expectation = expected(),
  mutations = {}, occlude = false, clip = false, mode = 'standalone' } = {}) {
  const dom = new JSDOM(`<html><body><div id="root"><div class="th-app">
    <aside class="th-sidebar"><div class="th-sidebar-body"></div><footer class="th-sidebar-footer">
      <div class="th-settings-menu"><button id="settings">Settings</button></div><button id="logout">Logout</button>
    </footer></aside><main class="th-main"><div class="th-chat-pane th-pane--focused">
      <div class="th-chat-input"><textarea>retained draft</textarea><button>Send</button></div>
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
  if (marker) d.documentElement.setAttribute('data-th-keyboard-open', '');
  if (clip) { d.querySelector('.th-settings-menu').style.overflowY = 'hidden';
    Object.defineProperty(d.querySelector('.th-settings-menu'), 'clientHeight', { value: 10 }); }
  d.elementFromPoint = (x, y) => {
    if (occlude) return d.body;
    const controls = [...d.querySelectorAll('button, textarea')];
    return [...controls, d.querySelector('.th-sidebar'), d.querySelector('.th-backdrop'), d.querySelector('#root')]
      .find(e => { const r = boxes.get(e); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) ?? null;
  };
  Object.defineProperty(w, 'visualViewport', { value: { width: 375, height: bottom === 762 ? 762 : expectation.surface.height,
    offsetTop: top, offsetLeft: left, scale: 1 } });
  Object.defineProperty(w, 'innerWidth', { value: 375 }); Object.defineProperty(w, 'innerHeight', { value: 762 });
  Object.defineProperty(w.navigator, 'standalone', { value: mode === 'standalone' });
  w.matchMedia = query => ({ matches: query === '(max-width: 768px)' });
  const page = { evaluate: (fn, args) => { w.captureArgs = args; return w.eval(`(${fn})(captureArgs)`); } };
  try { return await measure(page, expectation.safeInsets.bottom, expectation.safeInsets.top, expectation); }
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
test('recorded native shortened surface fails coverage separately from its correct internal 34 reserve', async () => {
  const g = await captured({ bottom: 762 });
  expect(row(g, 'C5.bottom-reserve').pass).toBe(true);
  expect(row(g, 'PWA.root-coverage').pass).toBe(false);
  expect(row(g, 'PWA.sidebar-coverage').pass).toBe(false);
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
