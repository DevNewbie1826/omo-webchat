/** Real-App mobile QA support. No product DOM or stylesheet overrides. */
import assert from 'node:assert/strict';
import { startFixture } from './pane-workspace-ui.mjs';
import { designSeed } from './design-workbench-fixture.mjs';

export async function setupMobile(browser, { theme, list = 'short', layout = 'single' }, actions) {
  const fixture = startFixture({ ...designSeed(layout), port: 0, controlled: true });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: layout === 'two' ? 1280 : 390, height: layout === 'two' ? 800 : 844 },
      isMobile: layout !== 'two', hasTouch: layout !== 'two', colorScheme: theme });
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
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('th-lang', 'en'); localStorage.setItem('th-theme', theme);
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
    }, { theme });
    actions.push({ action: 'navigate', url: fixture.url, authentication: 'isolated fixture /api/auth/check 204', theme, list, layout });
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
      let finite;
      while ((finite = sidebar.getAnimations({ subtree: true }).filter(a =>
        Number.isFinite(a.effect.getComputedTiming().endTime) && a.playState !== 'finished' && a.playState !== 'idle')).length) {
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

export async function measure(page, safeBottom, safeTop = 0) {
  return page.evaluate(({ safeBottom, safeTop }) => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const read = element => {
      const s = getComputedStyle(element), r = rect(element);
      return { rect: r, paddingTop: parseFloat(s.paddingTop), paddingBottom: parseFloat(s.paddingBottom),
        borderBottom: parseFloat(s.borderBottomWidth), position: s.position, transform: s.transform,
        height: s.height, boxSizing: s.boxSizing, overflowY: s.overflowY, clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    };
    const vv = visualViewport, root = document.documentElement;
    const viewport = { width: vv.width, height: vv.height, top: vv.offsetTop, left: vv.offsetLeft, scale: vv.scale,
      bottom: vv.offsetTop + vv.height, right: vv.offsetLeft + vv.width };
    const keyboardOpen = root.hasAttribute('data-th-keyboard-open');
    // The keyboard occludes the home-indicator region; retain its inset only when closed.
    const necessaryBottomInset = keyboardOpen ? 0 : safeBottom;
    // Insets are supplied by the scenario, never inferred from product padding.
    const safe = { top: viewport.top + safeTop, left: viewport.left, right: viewport.right, bottom: viewport.bottom - necessaryBottomInset };
    const button = element => {
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
        bounded: r.left >= safe.left - 1 && r.right <= safe.right + 1 && r.top >= safe.top - 1 && r.bottom <= safe.bottom + 1,
        focusVisible: element.matches(':focus-visible'), outlineStyle: getComputedStyle(element).outlineStyle };
    };
    const sidebar = document.querySelector('.th-sidebar'), footer = document.querySelector('.th-sidebar-footer');
    const settingsButtons = footer.querySelectorAll(':scope > .th-settings-menu > button');
    const logoutButtons = footer.querySelectorAll(':scope > button');
    if (settingsButtons.length !== 1 || logoutButtons.length !== 1) {
      throw new Error(`Expected exactly two footer controls: settings=${settingsButtons.length}, logout=${logoutButtons.length}`);
    }
    const controls = [...settingsButtons, ...logoutButtons].map(button);
    const bottom = Math.max(...controls.map(c => c.rect.bottom));
    const s = read(sidebar), f = read(footer), content = read(document.querySelector('.th-sidebar-body'));
    const paneNodes = [...document.querySelectorAll(document.querySelector('.th-pane-wrap') ? '.th-pane-wrap' : '.th-chat-pane')];
    const panel = document.querySelector('.th-settings-panel');
    return { layoutViewport: { width: innerWidth, height: innerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight },
      visualViewport: viewport, safe, safeBottom, safeTop, necessaryBottomInset, keyboardOpen,
      cssViewport: { heightUnit: root.style.getPropertyValue('--th-vh-unit'), top: root.style.getPropertyValue('--th-vv-top'),
        left: root.style.getPropertyValue('--th-vv-left') },
      displayMode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
      mobileMedia: matchMedia('(max-width: 768px)').matches,
      theme: root.getAttribute('data-theme'), root: read(document.querySelector('#root')), sidebar: s, footer: f, body: content,
      controls, sessionRows: document.querySelectorAll('.th-sidebar-body .th-tree-children > .th-tree-node').length,
      bottomGap: viewport.bottom - bottom, usableBottomGap: safe.bottom - bottom,
      contributions: { viewportToSidebarBottom: viewport.bottom - s.rect.bottom, sidebarPadding: s.paddingBottom,
        sidebarInnerToFooter: s.rect.bottom - s.paddingBottom - f.rect.bottom, footerToControl: f.rect.bottom - bottom,
        footerPadding: f.paddingBottom, unexplainedAfterPadding: viewport.bottom - bottom - s.paddingBottom - f.paddingBottom },
      panes: paneNodes.map(element => {
        const active = element.matches('.th-pane--focused') ? element : element.querySelector('.th-pane--focused');
        return { id: element.dataset.paneId, active: !!active, rect: rect(element),
          outlineStyle: getComputedStyle(active ?? element).outlineStyle, outlineWidth: getComputedStyle(active ?? element).outlineWidth };
      }),
      activeElement: { tag: document.activeElement.tagName, className: document.activeElement.className },
      settings: panel ? { ...read(panel), controls: [...panel.querySelectorAll('button, select')].map(button) } : null,
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1 };
  }, { safeBottom, safeTop });
}

export function footerAssertions(g) {
  assert.equal(g.controls.length, 2, 'Expected exactly two footer controls');
  return [
    { id: 'C5.controls-bounded-and-hit', pass: g.controls.every(c => c.bounded && c.unclipped && c.hit && !c.disabled), actual: g.controls },
    { id: 'C5.bottom-reserve', pass: g.usableBottomGap >= -1 && g.usableBottomGap <= 8.5,
      actual: { bottomGap: g.bottomGap, necessaryBottomInset: g.necessaryBottomInset, usableBottomGap: g.usableBottomGap } },
    { id: 'C5.mobile-bottom-gap-exact', pass: Math.abs(g.usableBottomGap - (g.mobileMedia ? 4 : 8)) <= 0.5,
      actual: { expectedGap: g.mobileMedia ? 4 : 8, usableBottomGap: g.usableBottomGap,
        bottomGap: g.bottomGap, necessaryBottomInset: g.necessaryBottomInset } },
    { id: 'C5.no-horizontal-overflow', pass: !g.horizontalOverflow, actual: g.horizontalOverflow },
  ];
}

export async function settingsReachability(page, safeBottom, safeTop) {
  const before = await measure(page, safeBottom, safeTop), panel = before.settings, p = panel.rect, safe = before.safe;
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
      const g = await measure(page, safeBottom, safeTop);
      interiorScrolled ||= g.settings.scrollTop !== panel.scrollTop;
      controls.push({ ...g.settings.controls[index], scrollTop: g.settings.scrollTop });
    }
  } else controls.push(...panel.controls);
  const after = await measure(page, safeBottom, safeTop);
  const stable = Math.abs(after.settings.rect.top - p.top) < 1 && Math.abs(after.footer.rect.bottom - before.footer.rect.bottom) < 1
    && after.body.scrollTop === before.body.scrollTop && after.sidebar.scrollTop === before.sidebar.scrollTop
    && after.root.scrollTop === before.root.scrollTop;
  return { id: 'C5.settings-reachable', pass: panelBounded && controls.length > 0
    && controls.every(c => c.bounded && c.unclipped && c.hit) && stable
    && (panel.scrollHeight <= panel.clientHeight || interiorScrolled),
    actual: { panel, safe, controls, panelBounded, interiorScrolled, stable } };
}

export async function openSidebar(page) {
  if (await page.locator('.th-sidebar').getAttribute('aria-hidden') === 'true') {
    await arm(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true');
    await page.locator('.th-mobile-menu').click(); await complete(page); await settle(page);
  }
  assert.equal(await page.locator('.th-sidebar').getAttribute('aria-hidden'), null);
}
