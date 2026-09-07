/** Real-App mobile QA support. No product DOM or stylesheet overrides. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startFixture } from './pane-workspace-ui.mjs';
import { designSeed } from './design-workbench-fixture.mjs';

// QA_PLAYWRIGHT wins; otherwise use only the dependency owner's session receipt.
// Never fall back to a shared runtime/profile or download a Playwright browser.
export async function mobileBrowserOptions(driver = process.env.QA_PLAYWRIGHT) {
  const entry = driver ?? JSON.parse(await readFile(new URL(
    '../../.omo/pwa-viewport-independent-20260907/reports/dependencies.json', import.meta.url), 'utf8')).qa_driver?.absolute_import_entry;
  assert(typeof entry === 'string' && entry.length > 0, 'QA_PLAYWRIGHT or dependencies.json qa_driver.absolute_import_entry required');
  return { driver: entry, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
}

export async function setupMobile(browser, { theme, list = 'short', layout = 'single', lang = 'en', fontSize = 14, beforeNavigate, viewport, isMobile = layout !== 'two', hasTouch = isMobile }, actions) {
  const fixture = startFixture({ ...designSeed(layout), port: 0, controlled: true });
  let context;
  try {
    context = await browser.newContext({ viewport: viewport ?? { width: layout === 'two' ? 1280 : 390, height: layout === 'two' ? 800 : 844 },
      isMobile, hasTouch, colorScheme: theme });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    let longItems;
    if (list === 'long') await page.route('**/api/workspaces/ws/sessions?*', async route => {
      const response = await route.fetch(), body = await response.json();
      const url = new URL(route.request().url());
      if (!longItems) longItems = [...body.items, ...Array.from({ length: 20 }, (_, i) => ({ id: `mobile-list-${i}`,
        name: `Session ${i + 1}`, provider: 'omo', source: 'discovered', recencyMs: -i - 1 }))];
      const start = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit'));
      const end = start + limit;
      actions.push({ action: 'seed-session-page', start, limit, total: longItems.length, boundary: 'HTTP response; real pagination and SessionTree' });
      await route.fulfill({ response, json: { items: longItems.slice(start, end), nextCursor: end < longItems.length ? String(end) : '' } });
    });
    await page.addInitScript(({ theme, lang, fontSize }) => {
      localStorage.setItem('th-lang', lang); localStorage.setItem('th-theme', theme);
      localStorage.setItem('th-font-size', String(fontSize));
      localStorage.setItem('th-ws-expanded', '["ws"]');
      window.mobileSignal = predicate => new Promise((done, fail) => {
        const mo = new MutationObserver(check), ro = new ResizeObserver(check);
        const timer = setTimeout(() => { cleanup(); fail(new Error('Mobile state deadline')); }, 30000);
        function cleanup() { clearTimeout(timer); mo.disconnect(); ro.disconnect(); }
        function check() { if (predicate()) { cleanup(); done(true); } }
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        for (const element of [document.documentElement, ...document.querySelectorAll('.th-sidebar-inner, .th-sidebar-footer')]) {
          if (element) ro.observe(element);
        }
        check();
      });
      window.mobileReady = window.mobileSignal(() => !!document.querySelector('.th-pane--focused textarea')
        && !!document.querySelector('[data-tool-call-id="design-failed"]'));
    }, { theme, lang, fontSize });
    actions.push({ action: 'navigate', url: fixture.url, authentication: 'isolated fixture /api/auth/check 204', theme, list, layout, lang, fontSize, isMobile, hasTouch });
    if (beforeNavigate) await beforeNavigate(page, fixture.url);
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => window.mobileReady);
    await page.evaluate(() => window.mobileSignal(() => document.querySelectorAll('.th-sidebar-body .th-tree-children > .th-tree-node').length >= 4));
    if (list === 'long') {
      await openSidebar(page);
      while (await page.locator('.th-tree-more').count()) {
        const before = await page.locator('.th-sidebar-body .th-tree-children > .th-tree-node').count();
        await page.evaluate(before => { window.mobilePending = window.mobileSignal(() =>
          document.querySelectorAll('.th-sidebar-body .th-tree-children > .th-tree-node').length > before
          && !document.querySelector('.th-tree-more[disabled]')); }, before);
        await page.locator('.th-tree-more').click(); await complete(page);
        actions.push({ action: 'load-more-sessions', before, after: await page.locator('.th-sidebar-body .th-tree-children > .th-tree-node').count() });
      }
    }
    return { page, context, fixture, errors, async close() {
      let stopped;
      try { await context.close(); } finally { stopped = await fixture.stop(); }
      return { contextClosed: page.isClosed(), ...stopped };
    } };
  } catch (error) {
    if (context) await context.close();
    const cleanup = await fixture.stop();
    throw new Error(`Mobile setup failed; cleanup=${JSON.stringify(cleanup)}`, { cause: error });
  }
}

export const arm = (page, predicate) => page.evaluate(source => {
  window.mobilePending = window.mobileSignal(new Function(`return (${source})`)());
}, String(predicate));
export const complete = page => page.evaluate(() => window.mobilePending);

export async function settle(page) {
  return page.evaluate(async () => {
    document.documentElement.getBoundingClientRect();
    const motion = [], sidebar = document.querySelector('.th-sidebar');
    let timer;
    const finished = async () => {
      await document.fonts.ready;
      while (true) {
        const finite = sidebar.getAnimations({ subtree: true }).filter(a =>
          Number.isFinite(a.effect.getComputedTiming().endTime) && a.playState !== 'finished' && a.playState !== 'idle');
        if (!finite.length) break;
        // Visibility:hidden legitimately cancels the drawer's transform transition.
        // Await exact finish/cancel signals, then inspect replacement animations; no timer readiness.
        await Promise.all(finite.map(async animation => {
          const name = animation.transitionProperty ?? animation.animationName;
          try { await animation.finished; motion.push({ name, outcome: 'finished' }); }
          catch (error) {
            if (error.name !== 'AbortError' || animation.playState !== 'idle') throw error;
            motion.push({ name, outcome: 'cancelled', playState: animation.playState });
          }
        }));
      }
      return motion;
    };
    try { return await Promise.race([finished(),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Mobile animation/font deadline')), 30000); })]);
    } finally { clearTimeout(timer); }
  });
}

// Fourth argument is the independent contract. Numeric-only calls remain compatible
// with historical QA; owned acceptance runners must always provide this argument.
export async function measure(page, safeBottom, safeTop = 0, expectations) {
  if (expectations) {
    assert.equal(typeof expectations.expectedKeyboard, 'boolean', 'independent expectedKeyboard required');
    assert(['standalone', 'browser'].includes(expectations.mode), 'independent mode required');
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      assert(Number.isFinite(expectations.surface?.[edge]), `independent surface.${edge} required`);
      assert(Number.isFinite(expectations.safeInsets?.[edge]) && expectations.safeInsets[edge] >= 0, `independent safeInsets.${edge} required`);
    }
    assert.equal(expectations.safeInsets.bottom, safeBottom);
    assert.equal(expectations.safeInsets.top, safeTop);
  }
  return page.evaluate(({ safeBottom, safeTop, expectations }) => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const read = element => {
      const s = getComputedStyle(element), r = rect(element);
      return { rect: r, paddingTop: parseFloat(s.paddingTop), paddingBottom: parseFloat(s.paddingBottom),
        borderBottom: parseFloat(s.borderBottomWidth), position: s.position, transform: s.transform,
        height: s.height, boxSizing: s.boxSizing, overflowY: s.overflowY, display: s.display, visibility: s.visibility,
        backgroundColor: s.backgroundColor, opacity: s.opacity, clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    };
    const vv = (typeof visualViewport === 'undefined' ? null : visualViewport) ?? { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 }, root = document.documentElement;
    const viewport = { width: vv.width, height: vv.height, top: vv.offsetTop, left: vv.offsetLeft, scale: vv.scale,
      bottom: vv.offsetTop + vv.height, right: vv.offsetLeft + vv.width };
    const keyboardOpen = root.hasAttribute('data-th-keyboard-open');
    // The keyboard occludes the home-indicator region; retain its inset only when closed.
    const necessaryBottomInset = (expectations ? expectations.expectedKeyboard : keyboardOpen) ? 0 : safeBottom;
    // Insets are supplied by the scenario, never inferred from product padding.
    const surface = expectations?.surface ?? viewport, drawerSurface = expectations?.drawerSurface ?? surface;
    const safe = { top: drawerSurface.top + safeTop, left: drawerSurface.left + (expectations?.safeInsets.left ?? 0),
      right: drawerSurface.right - (expectations?.safeInsets.right ?? 0), bottom: drawerSurface.bottom - necessaryBottomInset };
    // Raw visual height is a Settings max-height BUDGET, not its absolute bottom.
    // Its footer anchor can live on the independently declared full PWA surface.
    // Ordinary/keyboard scenarios declare their own usable surface in the same coordinates.
    const settingsSafe = { top: surface.top + safeTop, bottom: surface.bottom - necessaryBottomInset,
      left: surface.left + (expectations?.safeInsets.left ?? 0), right: surface.right - (expectations?.safeInsets.right ?? 0) };
    const button = (element, bounds = safe) => {
      const r = rect(element), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const clippingAncestors = [];
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), a = rect(ancestor);
        const clipsX = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
        const clipsY = ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const bounds = { left: a.left + ancestor.clientLeft, top: a.top + ancestor.clientTop,
          right: a.left + ancestor.clientLeft + ancestor.clientWidth, bottom: a.top + ancestor.clientTop + ancestor.clientHeight };
        clippingAncestors.push({ className: ancestor.className, bounds, clipsX, clipsY,
          contains: (!clipsX || r.left >= bounds.left - 1 && r.right <= bounds.right + 1)
            && (!clipsY || r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1) });
      }
      return { rect: r, hit: element === hit || element.contains(hit), disabled: element.disabled,
        unclipped: clippingAncestors.every(a => a.contains), clippingAncestors,
        bounded: r.left >= bounds.left - 1 && r.right <= bounds.right + 1 && r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1,
        focusVisible: element.matches(':focus-visible'), outlineStyle: getComputedStyle(element).outlineStyle };
    };
    const sidebar = document.querySelector('.th-sidebar'), footer = document.querySelector('.th-sidebar-footer');
    const settingsButtons = footer.querySelectorAll(':scope > .th-settings-menu > button');
    const logoutButtons = footer.querySelectorAll(':scope > button');
    if (settingsButtons.length !== 1 || logoutButtons.length !== 1) {
      throw new Error(`Expected exactly two footer controls: settings=${settingsButtons.length}, logout=${logoutButtons.length}`);
    }
    const controls = [...settingsButtons, ...logoutButtons].map(e => button(e));
    const bottom = Math.max(...controls.map(c => c.rect.bottom));
    const s = read(sidebar), f = read(footer), content = read(document.querySelector('.th-sidebar-body'));
    const paneNodes = [...document.querySelectorAll(document.querySelector('.th-pane-wrap') ? '.th-pane-wrap' : '.th-chat-pane')];
    const panel = document.querySelector('.th-settings-panel');
    const node = selector => { const e = document.querySelector(selector); return e ? read(e) : null; };
    let independent = {};
    if (expectations) {
      const units = {}, insets = {};
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;';
      document.body.appendChild(probe);
      try {
        for (const unit of ['vh', 'svh', 'lvh', 'dvh']) {
          probe.style.height = `100${unit}`; units[unit] = probe.getBoundingClientRect().height;
        }
        for (const edge of ['top', 'right', 'bottom', 'left']) {
          probe.style.paddingTop = `env(safe-area-inset-${edge}, 0px)`;
          insets[edge] = parseFloat(getComputedStyle(probe).paddingTop);
        }
      } finally { probe.remove(); }
      const appRoot = document.querySelector('#root');
      const bottomHits = [surface.left + 1, (surface.left + surface.right) / 2, surface.right - 1].map(x => {
        const y = surface.bottom - 1, hit = document.elementFromPoint(x, y);
        return { x, y, tag: hit?.tagName ?? null, className: hit?.className ?? null,
          withinRoot: !!hit && (hit === appRoot || appRoot.contains(hit)) };
      });
      const composer = document.querySelector('.th-pane--focused .th-chat-input') ?? document.querySelector('.th-chat-input');
      const capsule = composer?.querySelector('.th-chat-input-inner');
      independent = { expectations, app: node('.th-app'), main: node('.th-main'), composer: composer ? read(composer) : null,
        composerCapsule: capsule ? read(capsule) : null,
        composerReserve: composer && capsule ? rect(composer).bottom - rect(capsule).bottom : null,
        backdrop: node('.th-backdrop'), sidebarOpen: sidebar.getAttribute('aria-hidden') !== 'true',
        shelves: { goal: node('.th-goal-panel'), activity: node('.th-activity-panel'), transcript: node('.th-chat-body'),
          scrollport: node('.th-chat-scrollport') },
        composerControls: composer ? [...composer.querySelectorAll('textarea, button')].filter(e => e.getBoundingClientRect().width > 0).map(e => button(e)) : [],
        bottomHits, viewportUnitHeights: units, resolvedSafeInsets: insets,
        screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight,
          orientation: screen.orientation?.type ?? null, devicePixelRatio },
        navigatorStandalone: navigator.standalone === true,
        draft: composer?.querySelector('textarea')?.value ?? null,
        events: globalThis.pwaEvents ?? [], settingsSafe };
    }
    return { ...independent, layoutViewport: { width: innerWidth, height: innerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight },
      visualViewport: viewport, safe, safeBottom, safeTop, necessaryBottomInset, keyboardOpen,
      cssViewport: { heightUnit: root.style.getPropertyValue('--th-vh-unit'), width: root.style.getPropertyValue('--th-vv-width'), top: root.style.getPropertyValue('--th-vv-top'),
        left: root.style.getPropertyValue('--th-vv-left') },
      displayMode: matchMedia('(display-mode: standalone)').matches || (typeof navigator !== 'undefined' && navigator.standalone === true) ? 'standalone' : 'browser',
      mobileMedia: matchMedia('(max-width: 768px)').matches,
      theme: root.getAttribute('data-theme'), root: read(document.querySelector('#root')), sidebar: s, footer: f, body: content,
      controls, sessionRows: document.querySelectorAll('.th-sidebar-body .th-tree-children > .th-tree-node').length,
      bottomGap: surface.bottom - bottom,
      // Footer reserve is INTERNAL to its painted sidebar. Root/background coverage
      // is an independent assertion, so a 50px outside gap is not double padding.
      usableBottomGap: (expectations ? s.rect.bottom - necessaryBottomInset : safe.bottom) - bottom,
      contributions: { viewportToSidebarBottom: viewport.bottom - s.rect.bottom, sidebarPadding: s.paddingBottom,
        sidebarInnerToFooter: s.rect.bottom - s.paddingBottom - f.rect.bottom, footerToControl: f.rect.bottom - bottom,
        footerPadding: f.paddingBottom, unexplainedAfterPadding: viewport.bottom - bottom - s.paddingBottom - f.paddingBottom },
      panes: paneNodes.map(element => {
        const active = element.matches('.th-pane--focused') ? element : element.querySelector('.th-pane--focused');
        return { id: element.dataset.paneId, active: !!active, rect: rect(element),
          outlineStyle: getComputedStyle(active ?? element).outlineStyle, outlineWidth: getComputedStyle(active ?? element).outlineWidth };
      }),
      activeElement: { tag: document.activeElement.tagName, className: document.activeElement.className },
      settings: panel ? { ...read(panel), controls: [...panel.querySelectorAll('button, select')].map(e => button(e, settingsSafe)) } : null,
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1 };
  }, { safeBottom, safeTop, expectations });
}

export function footerAssertions(g) {
  assert.equal(g.controls.length, 2, 'Expected exactly two footer controls');
  return [
    { id: 'C5.controls-bounded-and-hit', pass: g.controls.every(c => c.bounded && c.unclipped && c.hit && !c.disabled), actual: g.controls },
    { id: 'C5.bottom-reserve', pass: Math.abs(g.usableBottomGap) <= 1,
      actual: { bottomGap: g.bottomGap, necessaryBottomInset: g.necessaryBottomInset, usableBottomGap: g.usableBottomGap } },
    { id: 'C5.mobile-bottom-gap-exact', pass: Math.abs(g.usableBottomGap) <= 1,
      actual: { expectedGap: 0, usableBottomGap: g.usableBottomGap,
        bottomGap: g.bottomGap, necessaryBottomInset: g.necessaryBottomInset } },
    { id: 'C5.no-horizontal-overflow', pass: !g.horizontalOverflow, actual: g.horizontalOverflow },
    ...(g.expectations ? surfaceAssertions(g) : []),
  ];
}

export function surfaceAssertions(g) {
  const e = g.expectations, s = e.surface, d = e.drawerSurface ?? s, inset = e.safeInsets;
  const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1;
  const box = (actual, expected) => !!actual && actual.rect.width > 0 && actual.rect.height > 0
    && Object.entries(expected).every(([edge, value]) => near(actual.rect[edge], value));
  const content = { top: s.top + inset.top, bottom: s.bottom, left: s.left + inset.left, right: s.right - inset.right };
  return [
    { id: 'PWA.keyboard', pass: g.keyboardOpen === e.expectedKeyboard, actual: { expected: e.expectedKeyboard, marker: g.keyboardOpen } },
    { id: 'PWA.sidebar-state', pass: g.sidebarOpen === e.sidebarOpen, actual: g.sidebarOpen },
    { id: 'PWA.mode', pass: g.displayMode === e.mode, actual: g.displayMode },
    { id: 'PWA.root-coverage', pass: box(g.root, { top: s.top, bottom: s.bottom, left: s.left, right: s.right }), actual: g.root },
    { id: 'PWA.app-coverage', pass: box(g.app, content), actual: g.app },
    { id: 'PWA.main-coverage', pass: box(g.main, { top: content.top, bottom: s.bottom, right: content.right })
      && g.main.rect.left >= content.left - 1, actual: g.main },
    { id: 'PWA.composer-coverage', pass: box(g.composer, { bottom: s.bottom, left: g.main?.rect.left, right: content.right }), actual: g.composer },
    { id: 'PWA.sidebar-coverage', pass: !e.sidebarOpen || box(g.sidebar, { top: d.top + (g.mobileMedia ? 0 : inset.top), bottom: d.bottom }), actual: g.sidebar },
    { id: 'PWA.backdrop-coverage', pass: g.mobileMedia && e.sidebarOpen
      ? box(g.backdrop, { top: d.top, bottom: d.bottom, left: d.left, right: d.right }) && g.backdrop.display !== 'none'
      : !g.backdrop || g.backdrop.display === 'none', actual: g.backdrop },
    { id: 'PWA.bottom-hit-coverage', pass: g.bottomHits.length === 3 && g.bottomHits.every(h => h.withinRoot), actual: g.bottomHits },
  ];
}

export async function settingsReachability(page, safeBottom, safeTop, expectations) {
  await settle(page);
  const before = await measure(page, safeBottom, safeTop, expectations), panel = before.settings, p = panel.rect, safe = before.settingsSafe ?? before.safe;
  const panelBounded = p.top >= safe.top - 1 && p.bottom <= safe.bottom + 1
    && p.left >= safe.left - 1 && p.right <= safe.right + 1;
  const controls = [];
  let interiorScrolled = false;
  // An unbounded panel is already a product failure, not an automation timeout.
  if (panelBounded && ['auto', 'scroll'].includes(panel.overflowY)) {
    for (let index = 0; index < panel.controls.length; index++) {
      await page.locator('.th-settings-panel').evaluate((element, index) => {
        const control = element.querySelectorAll('button, select')[index];
        const r = control.getBoundingClientRect(), p = element.getBoundingClientRect();
        const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
          element.scrollTop + r.top - p.top - element.clientTop - (element.clientHeight - r.height) / 2));
        window.mobilePending = new Promise((done, fail) => {
          if (Math.abs(element.scrollTop - target) < 1) { done(true); return; }
          const timer = setTimeout(() => { element.removeEventListener('scroll', finish); fail(new Error('Settings scroll deadline')); }, 30000);
          function finish() { clearTimeout(timer); element.removeEventListener('scroll', finish); done(true); }
          element.addEventListener('scroll', finish, { once: true });
          element.scrollTo({ top: target, behavior: 'instant' });
        });
      }, index);
      await complete(page);
      const g = await measure(page, safeBottom, safeTop, expectations);
      interiorScrolled ||= g.settings.scrollTop !== panel.scrollTop;
      controls.push({ ...g.settings.controls[index], scrollTop: g.settings.scrollTop });
    }
  } else controls.push(...panel.controls);
  const after = await measure(page, safeBottom, safeTop, expectations);
  const stable = Math.abs(after.settings.rect.top - p.top) < 1 && Math.abs(after.footer.rect.bottom - before.footer.rect.bottom) < 1
    && after.body.scrollTop === before.body.scrollTop && after.sidebar.scrollTop === before.sidebar.scrollTop
    && after.root.scrollTop === before.root.scrollTop;
  return { id: 'C5.settings-reachable', pass: panelBounded && controls.length > 0
    && controls.every(c => c.bounded && c.unclipped && c.hit) && stable
    && (panel.scrollHeight <= panel.clientHeight || interiorScrolled),
    actual: { panel, safe, controls, panelBounded, interiorScrolled, stable } };
}

export async function transcriptReachability(page, safeBottom, safeTop, expectations) {
  const before = await measure(page, safeBottom, safeTop, expectations), owner = before.shelves.transcript;
  const scrollable = owner?.clientHeight > 0 && owner.scrollHeight > owner.clientHeight
    && ['auto', 'scroll'].includes(owner.overflowY);
  if (scrollable) {
    await page.locator('.th-chat-body').evaluate(element => {
      window.mobilePending = new Promise((done, fail) => {
        const timer = setTimeout(() => { element.removeEventListener('scroll', finish); fail(new Error('Transcript scroll deadline')); }, 30000);
        function finish() { clearTimeout(timer); done(true); }
        element.addEventListener('scroll', finish, { once: true });
        element.scrollTo({ top: element.scrollTop > 0 ? 0 : element.scrollHeight - element.clientHeight, behavior: 'instant' });
      });
    });
    await complete(page);
  }
  const after = await measure(page, safeBottom, safeTop, expectations);
  return { id: 'PWA.transcript-scroll-owner', pass: !!scrollable && after.shelves.transcript.scrollTop !== owner.scrollTop
    && after.shelves.scrollport.scrollTop === before.shelves.scrollport.scrollTop && after.root.scrollTop === before.root.scrollTop
    && after.draft === before.draft && Math.abs(after.composer.rect.bottom - before.composer.rect.bottom) < 1,
    actual: { before: before.shelves, after: after.shelves, draftBefore: before.draft, draftAfter: after.draft,
      composerBefore: before.composer, composerAfter: after.composer } };
}

export async function openSidebar(page) {
  if (await page.locator('.th-sidebar').getAttribute('aria-hidden') === 'true') {
    await arm(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true');
    await page.locator('.th-mobile-menu').click(); await complete(page); await settle(page);
  }
  assert.equal(await page.locator('.th-sidebar').getAttribute('aria-hidden'), null);
}
