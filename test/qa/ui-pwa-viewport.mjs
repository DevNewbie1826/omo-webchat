/** Independent built-SPA PWA geometry QA. All Chrome inputs are SYNTHETIC.
 * bun test/qa/ui-pwa-viewport.mjs --phase green --out .omo/evidence/pwa-viewport/green
 * Run only after the build owner freezes dist. No shared fixture or product edits.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupMobile, arm, complete, settle, measure, footerAssertions, surfaceAssertions,
  openSidebar, settingsReachability, transcriptReachability, mobileBrowserOptions } from './ui-mobile-helpers.mjs';
import { bindingAssertion } from './ui-followup-sidebar.mjs';

const ROOT = resolve(import.meta.dir, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const productPaths = ['frontend/index.html', 'frontend/src/styles/global.css', 'frontend/src/styles/sidebar.css',
  'frontend/src/styles/mobile-drawer.css', 'frontend/src/styles/chat-composer.css', 'frontend/src/styles/chat-pane.css'];
const ownedPaths = ['test/qa/ui-mobile-helpers.mjs', 'test/qa/ui-followup-sidebar.mjs', 'test/qa/ui-mobile-footer-polish.mjs',
  'test/qa/ui-pwa-viewport.mjs', 'test/qa/ui-pwa-viewport.test.mjs'];
const git = async (...args) => {
  const p = Bun.spawn(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  assert.equal(code, 0, err); return out.trim();
};
const hashes = paths => Promise.all(paths.map(async path => [path, hash(await readFile(resolve(ROOT, path)))])).then(Object.fromEntries);

// Bind response bytes to local dist, not just filenames or DOM URLs. The enclosing
// runner also compares the entire immutable input manifest before/after the run.
export function observeAssets(page, url) {
  const responses = [], jobs = [];
  page.on('response', response => {
    const resource = new URL(response.url());
    if (resource.origin !== url || !(resource.pathname === '/' || /\.(js|css)$/.test(resource.pathname))) return;
    jobs.push((async () => {
      const bytes = await response.body(), localPath = `frontend/dist/${resource.pathname === '/' ? 'index.html' : resource.pathname.slice(1)}`;
      const local = await readFile(resolve(ROOT, localPath));
      responses.push({ url: response.url(), status: response.status(), bytes: bytes.length, sha256: hash(bytes),
        localPath, localBytes: local.length, localSha256: hash(local) });
    })().then(() => null, error => ({ error: String(error) })));
  });
  return async () => {
    const domURLs = await page.evaluate(() => [location.href, ...[...document.querySelectorAll('script[src]')].map(e => e.src),
      ...[...document.querySelectorAll('link[rel="stylesheet"]')].map(e => e.href)]);
    const errors = (await Promise.all(jobs)).filter(Boolean);
    return { domURLs, responses, errors, pass: errors.length === 0 && bindingAssertion({ domURLs, responses }) };
  };
}

export function pwaAssertions(g, draft) {
  const e = g.expectations, rows = e.sidebarOpen ? footerAssertions(g) : surfaceAssertions(g);
  const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1;
  const breathing = { touch: 4, fine: 16 }[e.inputProfile];
  const reserve = Math.max(breathing, e.expectedKeyboard ? 0 : e.safeInsets.bottom);
  return [...rows,
    { id: 'PWA.composer-reserve', pass: g.composerCapsule?.rect.height > 0 && near(g.composerReserve, reserve),
      actual: { inputProfile: e.inputProfile, minimumBreathing: breathing, expected: reserve, measured: g.composerReserve, capsule: g.composerCapsule } },
    { id: 'PWA.independent-insets', pass: Object.entries(e.safeInsets).every(([edge, value]) => near(g.resolvedSafeInsets[edge], value)), actual: g.resolvedSafeInsets },
    { id: 'PWA.raw-visual-variables', pass: near(parseFloat(g.cssViewport.heightUnit) * 100, g.visualViewport.height)
      && near(parseFloat(g.cssViewport.width), g.visualViewport.width)
      && near(parseFloat(g.cssViewport.top), g.visualViewport.top) && near(parseFloat(g.cssViewport.left), g.visualViewport.left), actual: g.cssViewport },
    { id: 'PWA.draft', pass: g.draft === draft, actual: { expected: draft, actual: g.draft } },
    ...(e.bothShelves ? [{ id: 'PWA.both-shelves-with-transcript', pass: g.shelves.goal?.rect.height > 0
      && g.shelves.activity?.rect.height > 0 && g.shelves.transcript?.clientHeight > 0
      && g.shelves.transcript.scrollHeight > g.shelves.transcript.clientHeight, actual: g.shelves }] : []),
    ...(e.shelfIntent ? [{ id: 'PWA.retained-shelf-intent', pass: g.shelfIntent.goalOpen === e.shelfIntent.goalOpen
      && g.shelfIntent.activityOpen === e.shelfIntent.activityOpen && g.shelfIntent.selectedTab === e.shelfIntent.selectedTab,
      actual: { expected: e.shelfIntent, measured: g.shelfIntent } }] : []),
    ...(e.compactShelves ? [{ id: 'PWA.compact-floor-collapse', pass: g.shelves.goal === null && g.shelves.activity === null
      && g.shelves.transcript?.clientHeight > 0 && g.shelves.transcript.scrollHeight > g.shelves.transcript.clientHeight,
      actual: g.shelves }] : []),
    ...(!e.sidebarOpen || !g.mobileMedia ? [{ id: 'PWA.composer-access', pass: g.composerControls.length >= 2
      && g.composerControls.every(c => c.bounded && c.unclipped && c.hit), actual: g.composerControls }] : []),
  ];
}

export const cases = [
  { width: 375, height: 812, isMobile: true, hasTouch: true, mode: 'standalone', list: 'long', insets: { top: 50, right: 0, bottom: 34, left: 0 } },
  { width: 390, height: 844, isMobile: true, hasTouch: true, mode: 'standalone', list: 'short', insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  { width: 768, height: 844, isMobile: true, hasTouch: true, mode: 'browser', list: 'long', insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  { width: 769, height: 844, isMobile: false, hasTouch: false, mode: 'browser', list: 'short', insets: { top: 0, right: 0, bottom: 34, left: 0 } },
  { width: 812, height: 375, isMobile: true, hasTouch: true, mode: 'standalone', list: 'short', compactShelves: true,
    restorationViewport: { width: 812, height: 844 }, insets: { top: 0, right: 44, bottom: 21, left: 44 } },
  { width: 1280, height: 800, isMobile: false, hasTouch: false, mode: 'browser', list: 'long', insets: { top: 0, right: 0, bottom: 0, left: 0 } },
];

export async function openGoalBar(page) {
  // aria-expanded is actual allocation, not retained intent at the 48px floor.
  if (await page.locator('.th-goal-bar .th-activity-caret--open').count()) return;
  await arm(page, () => !!document.querySelector('.th-goal-bar .th-activity-caret--open'));
  await page.locator('.th-goal-bar').click(); await complete(page);
}

export function shelfExpectations(input, state, opened) {
  const combined = state === 'goal-activity-long-transcript';
  return { bothShelves: combined && !input.compactShelves || state === 'compact-adequate-space',
    compactShelves: input.compactShelves === true && (combined || ['compact-controls-reachable', 'compact-return'].includes(state)),
    shelfIntent: opened && (input.compactShelves || combined) ? { goalOpen: true, activityOpen: true, selectedTab: 'agents' } : null };
}

const sameRect = (a, b) => ['top', 'bottom', 'left', 'right'].every(edge => Math.abs(a[edge] - b[edge]) < 1);
const retainedIntent = g => g.shelfIntent.goalOpen && g.shelfIntent.activityOpen && g.shelfIntent.selectedTab === 'agents';

export function compactReachabilityAssertion(before, after, controls) {
  const owner = before.shelves.auxiliary;
  return { id: 'PWA.compact-auxiliary-reachable', pass: owner.clientHeight > 0 && owner.scrollHeight > owner.clientHeight
    && ['auto', 'scroll'].includes(owner.overflowY) && after.shelves.auxiliary.scrollTop !== owner.scrollTop
    && ['goal', 'todo', 'agents', 'dag', 'resize'].every(key => controls.some(c => c.key === key))
    && controls.every(c => c.bounded && c.unclipped && c.hit && !c.disabled)
    && ['transcript', 'scrollport'].every(key => after.shelves[key].scrollTop === before.shelves[key].scrollTop)
    && after.root.scrollTop === before.root.scrollTop && retainedIntent(before) && retainedIntent(after)
    && after.draft === before.draft && sameRect(after.composer.rect, before.composer.rect)
    && after.composerControls.every(c => c.bounded && c.unclipped && c.hit),
    actual: { before, after, controls } };
}

export async function compactReachability(page, safeBottom, safeTop, expectations) {
  const before = await measure(page, safeBottom, safeTop, expectations), controls = [];
  // Scroll only the actual auxiliary owner, never scrollIntoView (which can move
  // ancestors). Each control is measured at its own reachable native hit point.
  for (let index = 0; index < before.auxiliaryControls.length; index++) {
    await page.locator('.th-chat-main-content').evaluate((element, index) => {
      const control = element.querySelectorAll('.th-goal-bar, [data-activity-tab], .th-activity-resize')[index];
      const r = control.getBoundingClientRect(), p = element.getBoundingClientRect();
      const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
        element.scrollTop + r.top - p.top - element.clientTop - (element.clientHeight - r.height) / 2));
      window.mobilePending = new Promise((done, fail) => {
        if (Math.abs(element.scrollTop - target) < 1) { done(true); return; }
        const timer = setTimeout(() => { element.removeEventListener('scroll', finish); fail(new Error('Auxiliary scroll deadline')); }, 30000);
        function finish() { clearTimeout(timer); done(true); }
        element.addEventListener('scroll', finish, { once: true });
        element.scrollTo({ top: target, behavior: 'instant' });
      });
    }, index);
    await complete(page);
    const g = await measure(page, safeBottom, safeTop, expectations);
    controls.push({ ...g.auxiliaryControls[index], scrollTop: g.shelves.auxiliary.scrollTop });
  }
  const after = await measure(page, safeBottom, safeTop, expectations);
  return compactReachabilityAssertion(before, after, controls);
}

export function editorEndAssertion(before, after, sameNode) {
  const a = before.editor, b = after.editor;
  return { id: 'PWA.editor-end-reachable', pass: sameNode && a.focused && b.focused && a.value === b.value
    && a.selectionStart === b.selectionStart && a.selectionEnd === b.selectionEnd
    && b.clientHeight > 0 && b.scrollHeight > b.clientHeight && ['auto', 'scroll'].includes(b.overflowY)
    && Math.abs(b.scrollTop + b.clientHeight - b.scrollHeight) <= 1
    && (a.scrollTop + a.clientHeight >= a.scrollHeight - 1 || b.scrollTop > a.scrollTop)
    && sameRect(a.rect, b.rect) && sameRect(before.composer.rect, after.composer.rect)
    && after.root.scrollTop === before.root.scrollTop && after.draft === before.draft
    && after.composerControls.every(c => c.bounded && c.unclipped && c.hit),
    actual: { before, after, sameNode } };
}

export async function editorEndReachability(page, safeBottom, safeTop, expectations) {
  const before = await measure(page, safeBottom, safeTop, expectations);
  const sameNode = await page.locator('.th-pane--focused textarea').evaluate(async element => {
    await new Promise((done, fail) => {
      const target = element.scrollHeight - element.clientHeight;
      if (Math.abs(element.scrollTop - target) < 1) { done(true); return; }
      const timer = setTimeout(() => { element.removeEventListener('scroll', finish); fail(new Error('Editor end deadline')); }, 30000);
      function finish() { clearTimeout(timer); done(true); }
      element.addEventListener('scroll', finish, { once: true });
      element.scrollTo({ top: target, behavior: 'instant' });
    });
    return element.isConnected && element === document.querySelector('.th-pane--focused textarea');
  });
  return editorEndAssertion(before, await measure(page, safeBottom, safeTop, expectations), sameNode);
}

export async function openActivityTab(page) {
  if (await page.locator('[data-activity-tab="agents"]').getAttribute('aria-selected') === 'true'
    && await page.locator('.th-activity-resize').count()) return;
  // Resize chrome witnesses open intent even when the compact allocator omits the panel.
  // Feasible scenarios and adequate-space restoration still require both panels.
  await arm(page, () => document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected') === 'true'
    && !!document.querySelector('.th-activity-resize'));
  await page.locator('[data-activity-tab="agents"]').click(); await complete(page);
}

// Only browser API getters/events are synthesized. CSS, DOM and product markers
// remain untouched. Chrome's dvh/lvh do NOT reproduce WebKit's native divergence.
async function visualInput(page, input, event = 'resize') {
  await page.evaluate(({ input, event }) => {
    window.mobilePending = new Promise((done, fail) => {
      const target = ['pageshow', 'orientationchange', 'pagehide'].includes(event) ? window : visualViewport;
      const timer = setTimeout(() => { target.removeEventListener(event, finish); fail(new Error('Viewport input event deadline')); }, 30000);
      function finish() { clearTimeout(timer); done(true); }
      target.addEventListener(event, finish, { once: true });
      for (const [key, value] of Object.entries(input)) Object.defineProperty(visualViewport, key, { configurable: true, get: () => value });
      target.dispatchEvent(new Event(event));
    });
  }, { input, event });
  await complete(page); await settle(page);
}

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), '--phase must be red or green');
  assert(out, '--out required');
  const browserOptions = await mobileBrowserOptions(driver);
  const evidence = resolve(out); await mkdir(evidence, { recursive: true });
  const save = (name, data) => writeFile(resolve(evidence, name), `${JSON.stringify(data, null, 2)}\n`);
  const rows = [], actions = [], captures = [], failures = [], cleanup = [], bindings = [];
  const receipt = { phase, browserOptions, command: `bun test/qa/ui-pwa-viewport.mjs --phase ${phase} --out ${out}`, cwd: process.cwd(),
    source: { head: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'), dirty: await git('status', '--short') },
    started: new Date().toISOString(), inventory: { cases, themes: ['dark', 'light'] },
    evidenceKind: 'SYNTHETIC_CHROME_BUILT_SPA', nativePwaStatus: 'NOT_VERIFIED',
    limitations: ['navigator.standalone, visualViewport and CDP safe insets are synthetic; no native PWA PASS.',
      'Chrome CSS viewport units do not model the native iOS 762dvh/812lvh split. Dedicated recorded-geometry tests guard that regression.',
      'pagehide/pageshow and orientation events are synthetic, not OS foreground or hardware rotation.',
      'Screenshots cover the Chrome viewport, not an iPhone display or OS keyboard. Actual iOS and same-device Safari remain separate gates.'] };
  let browser, paths;
  try {
    paths = [...productPaths, ...ownedPaths, 'test/qa/design-workbench-fixture.mjs', 'test/qa/pane-workspace-ui.mjs',
      'frontend/dist/index.html', ...new Bun.Glob('frontend/dist/assets/*.{css,js}').scanSync({ cwd: ROOT })];
    receipt.source.hashes = await hashes(paths);
    const { chromium } = await import(browserOptions.driver);
    browser = await chromium.launch({ executablePath: browserOptions.executablePath, headless: true, timeout: 90000 });
    receipt.browserVersion = browser.version();
    for (const theme of ['dark', 'light']) for (const input of cases) {
      const name = `${theme}-${input.mode}-${input.width}x${input.height}-${input.list}`;
      let q, cdp, binding;
      try {
        q = await setupMobile(browser, { theme, list: input.list, viewport: { width: input.width, height: input.height },
          isMobile: input.isMobile, hasTouch: input.hasTouch, async beforeNavigate(page, url) {
            binding = observeAssets(page, url);
            await page.addInitScript(mode => {
              Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => mode === 'standalone' });
              window.pwaEvents = [];
              const log = event => window.pwaEvents.push({ sequence: window.pwaEvents.length + 1, event: event.type,
                target: event.target === visualViewport ? 'visualViewport' : 'window/document', at: performance.now(),
                visibility: document.visibilityState, width: visualViewport.width, height: visualViewport.height,
                top: visualViewport.offsetTop, left: visualViewport.offsetLeft, scale: visualViewport.scale,
                keyboardMarker: document.documentElement.hasAttribute('data-th-keyboard-open') });
              for (const type of ['resize', 'scroll', 'orientationchange', 'pageshow', 'pagehide', 'focusin', 'focusout']) window.addEventListener(type, log);
              document.addEventListener('visibilitychange', log);
              visualViewport.addEventListener('resize', log); visualViewport.addEventListener('scroll', log);
            }, input.mode);
          } }, actions);
        const { page } = q;
        const assets = await binding(); bindings.push({ name, ...assets });
        rows.push({ scenario: name, id: 'PWA.served-byte-binding', pass: assets.pass, actual: assets });
        cdp = await q.context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: input.insets });
        let width = input.width, height = input.height, shelvesOpened = false;
        const draft = `PWA retained draft ${name}`;
        await page.locator('.th-pane--focused textarea').fill(draft);
        const capture = async (state, keyboard = false, top = 0, visualHeight = height, sidebarOpen = false) => {
          const surface = { top: keyboard ? top : 0, left: 0, right: width, bottom: keyboard ? top + visualHeight : height };
          const expectations = { expectedKeyboard: keyboard, safeInsets: input.insets, surface, mode: input.mode, sidebarOpen,
            ...shelfExpectations(input, state, shelvesOpened),
            inputProfile: input.hasTouch ? 'touch' : 'fine',
            drawerSurface: input.mode === 'standalone' && !keyboard ? surface : { top, left: 0, right: width, bottom: top + visualHeight } };
          if (sidebarOpen && width > 768 && (await page.locator('.th-sidebar').getAttribute('class')).includes('th-sidebar--collapsed')) {
            await arm(page, () => !document.querySelector('.th-sidebar').classList.contains('th-sidebar--collapsed'));
            await page.locator('.th-sidebar-rail .th-sidebar-toggle').click(); await complete(page);
          }
          await settle(page);
          if (expectations.bothShelves || expectations.compactShelves) rows.push({ scenario: `${name}-${state}`,
            ...await transcriptReachability(page, input.insets.bottom, input.insets.top, expectations) });
          if (['compact-controls-reachable', 'compact-return'].includes(state)) rows.push({ scenario: `${name}-${state}`,
            ...await compactReachability(page, input.insets.bottom, input.insets.top, expectations) });
          const g = await measure(page, input.insets.bottom, input.insets.top, expectations);
          rows.push(...pwaAssertions(g, draft).map(row => ({ scenario: `${name}-${state}`, ...row })));
          const image = `${name}-${state}.png`, imagePath = resolve(evidence, image);
          await page.screenshot({ path: imagePath, animations: 'allow' });
          const bytes = await readFile(imagePath); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          captures.push({ name, state, image, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
          await save(`${name}-${state}.json`, { geometry: g, evidenceKind: receipt.evidenceKind });
          actions.push({ name, state, expectations, events: g.events });
          return g;
        };
        const closeDrawer = async () => {
          if (width <= 768) {
            await arm(page, () => document.querySelector('.th-sidebar').getAttribute('aria-hidden') === 'true');
            await page.locator('.th-backdrop').click({ position: { x: width - 2, y: 100 } }); await complete(page); await settle(page);
          }
        };
        // Long-list setup may already have opened the drawer; normalize via its real control.
        if (width <= 768 && await page.locator('.th-sidebar').getAttribute('aria-hidden') !== 'true') await closeDrawer();
        const restingHeight = input.mode === 'standalone' && width <= 768 ? height - 50 : height;
        await visualInput(page, { width, height: restingHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
        await capture('cold-draft', false, 0, restingHeight, width > 768);
        await openSidebar(page); await capture('drawer-open', false, 0, restingHeight, true);
        await arm(page, () => !!document.querySelector('.th-settings-panel'));
        await page.locator('.th-settings-menu > button').click(); await complete(page);
        const settingsExpectations = { expectedKeyboard: false, mode: input.mode,
          safeInsets: input.insets, surface: { top: 0, left: 0, right: width, bottom: height }, sidebarOpen: true };
        rows.push({ scenario: name, ...await settingsReachability(page, input.insets.bottom, input.insets.top, settingsExpectations) });
        await arm(page, () => !document.querySelector('.th-settings-panel'));
        await page.keyboard.press('Escape'); await complete(page); await closeDrawer();
        await openGoalBar(page);
        await openActivityTab(page);
        shelvesOpened = true;
        await capture('goal-activity-long-transcript', false, 0, restingHeight, width > 768);
        if (input.compactShelves) {
          await capture('compact-controls-reachable', false, 0, height, true);
          // A subsequent real viewport, not a taller original compact root.
          // No Goal/tab open action occurs anywhere in this restoration cycle.
          for (const adequate of [true, false]) {
            ({ width, height } = adequate ? input.restorationViewport : input);
            await page.evaluate(({ width, height, adequate }) => {
              window.compactResizePending = window.mobileSignal(() => innerWidth === width && innerHeight === height
                && Math.abs(document.querySelector('#root').getBoundingClientRect().height - height) < 1
                && (adequate ? ['.th-goal-panel', '.th-activity-panel'].every(s => document.querySelector(s)?.getBoundingClientRect().height > 0)
                  : !document.querySelector('.th-goal-panel, .th-activity-panel')));
            }, { width, height, adequate });
            await page.setViewportSize({ width, height });
            await visualInput(page, { width, height, offsetTop: 0 });
            await page.evaluate(() => window.compactResizePending);
            await capture(adequate ? 'compact-adequate-space' : 'compact-return', false, 0, height, true);
          }
        }
        await page.locator('.th-pane--focused textarea').focus();
        let keyboardHeight = Math.max(270, height - 340), keyboardTop = height > 500 ? 60 : 20;
        await visualInput(page, { width, height: keyboardHeight, offsetTop: keyboardTop, offsetLeft: 0, scale: 1 });
        await capture('keyboard', true, keyboardTop, keyboardHeight, width > 768);
        await visualInput(page, { width: width + 2, height: keyboardHeight, offsetTop: keyboardTop });
        await capture('keyboard-width-drift', true, keyboardTop, keyboardHeight, width > 768);
        await visualInput(page, { width, height: keyboardHeight, offsetTop: keyboardTop }, 'pageshow');
        await capture('pageshow-shrunk', true, keyboardTop, keyboardHeight, width > 768);
        await visualInput(page, { width, height: restingHeight, offsetTop: 0 });
        const recovered = await capture('dismiss-without-blur', false, 0, restingHeight, width > 768);
        rows.push({ scenario: name, id: 'PWA.focus-retained', pass: recovered.activeElement.tag === 'TEXTAREA', actual: recovered.activeElement });
        // Rotate real Chrome layout, independently drive the visual input, then restore.
        for (const keyboard of [false, true]) {
          for (const rotated of [true, false]) {
            [width, height] = rotated ? [input.height, input.width] : [input.width, input.height];
            await page.setViewportSize({ width, height });
            if (width <= 768 && await page.locator('.th-sidebar').getAttribute('aria-hidden') !== 'true') await closeDrawer();
            keyboardHeight = Math.max(270, height - 340); keyboardTop = keyboard ? (height > 500 ? 60 : 20) : 0;
            const visible = keyboard ? keyboardHeight : height;
            await visualInput(page, { width, height: visible, offsetTop: keyboardTop }, 'orientationchange');
            const rotatedState = await capture(`rotation-${keyboard ? 'open' : 'closed'}-${rotated ? 'away' : 'back'}`, keyboard, keyboardTop, visible, width > 768);
            if (input.compactShelves && keyboard && !rotated) {
              // Preserve the original capture first. Drawer/rail actions can move
              // focus during rotation; explicitly focus this same unchanged editor
              // for the internal-scroll exercise, without scrolling its ancestors.
              await page.locator('.th-pane--focused textarea').evaluate(element => element.focus({ preventScroll: true }));
              actions.push({ name, action: 'focus-editor-for-end-reachability', priorActive: rotatedState.activeElement });
              rows.push({ scenario: name, ...await editorEndReachability(page, input.insets.bottom, input.insets.top, rotatedState.expectations) });
              await capture('rotation-open-back-editor-end', true, keyboardTop, visible, width > 768);
            }
          }
        }
        await visualInput(page, { width, height, offsetTop: 0 }, 'pagehide');
        await visualInput(page, { width, height, offsetTop: 0 }, 'pageshow');
        await capture('foreground-restored', false, 0, height, width > 768);
        assert.deepEqual(q.errors, [], 'browser exceptions'); assert.deepEqual(q.fixture.unexpected, [], 'unexpected fixture traffic');
        assert(!q.fixture.requests.some(r => /logout/.test(r.path)), 'logout is never invoked');
      } catch (error) { failures.push({ name, error: String(error), stack: error.stack, cause: String(error.cause ?? '') }); }
      finally {
        if (q) {
          try { if (cdp) await cdp.detach(); }
          finally {
            await save(`${name}-traffic.json`, { requests: q.fixture.requests, errors: q.errors, unexpected: q.fixture.unexpected });
            const closed = await q.close(); let probe;
            try { probe = Bun.serve({ hostname: '127.0.0.1', port: closed.port, fetch: () => new Response('cleanup probe') }); }
            finally { if (probe) await probe.stop(true); }
            cleanup.push({ name, ...closed, portReboundAndReleased: !!probe });
          }
        }
        await save('results.json', rows); await save('failures.json', failures);
      }
    }
    receipt.source.afterHashes = await hashes(paths);
    assert.deepEqual(receipt.source.afterHashes, receipt.source.hashes, 'source/dist changed during capture; evidence invalid');
  } catch (error) { failures.push({ name: 'runner', error: String(error), stack: error.stack }); }
  finally {
    if (browser) { await browser.close(); cleanup.push({ browserClosed: !browser.isConnected() }); }
    const originalStates = ['cold-draft', 'drawer-open', 'goal-activity-long-transcript', 'keyboard', 'keyboard-width-drift',
      'pageshow-shrunk', 'dismiss-without-blur', 'rotation-closed-away', 'rotation-closed-back', 'rotation-open-away',
      'rotation-open-back', 'foreground-restored'];
    const compactStates = ['compact-controls-reachable', 'compact-adequate-space', 'compact-return', 'rotation-open-back-editor-end'];
    const completeInventory = bindings.length === cases.length * 2 && ['dark', 'light'].every(theme => cases.every(input => {
      const name = `${theme}-${input.mode}-${input.width}x${input.height}-${input.list}`;
      const states = [...originalStates, ...(input.compactShelves ? compactStates : [])];
      return states.every(state => captures.filter(c => c.name === name && c.state === state).length === 1);
    })) && captures.length === cases.length * 2 * 12 + cases.filter(c => c.compactShelves).length * 2 * 4;
    const clean = cleanup.filter(c => c.contextClosed && c.serverStopped && c.portReboundAndReleased
      && c.pendingWebSockets === 0 && c.pendingOpens === 0 && c.pendingCreates === 0).length === cases.length * 2 && cleanup.at(-1)?.browserClosed;
    const failed = rows.filter(r => !r.pass);
    receipt.summary = { assertions: rows.length, failed: failed.length, captures: captures.length, completeInventory, clean };
    receipt.status = failures.length || !completeInventory || !clean ? 'BLOCKED' : failed.length ? (phase === 'red' ? 'RED_CONFIRMED' : 'ASSERTION_FAILURE')
      : phase === 'green' ? 'SYNTHETIC_GREEN' : 'UNEXPECTED_BASELINE';
    receipt.exitStatus = receipt.status === 'SYNTHETIC_GREEN' ? 0 : ['RED_CONFIRMED', 'ASSERTION_FAILURE'].includes(receipt.status) ? 1 : 2;
    receipt.finished = new Date().toISOString();
    for (const [name, data] of Object.entries({ receipt, results: rows, actions, captures, failures, cleanup, bindings })) await save(`${name}.json`, data);
  }
  console.log(JSON.stringify({ status: receipt.status, ...receipt.summary, failures, evidence }, null, 2));
  return receipt.exitStatus;
}
if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } }, strict: true });
  process.exitCode = await run(values);
}
