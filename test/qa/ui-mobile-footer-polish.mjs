/** QA_PLAYWRIGHT=<installed playwright-core/index.mjs> bun test/qa/ui-mobile-footer-polish.mjs --phase red|green --out PATH
 * C5-only companion to ui-mobile-polish.mjs: mobile sidebar footer bottom bounds on the real built SPA.
 * RED intentionally exits 1 only after collecting the intended assertion failures; infrastructure
 * errors exit 2. GREEN requires every scoped, strict and settings assertion green — settings rows
 * are part of C5 (footer scope per the governing brief) and are never excluded or classified.
 * Both runners share the exact zero-extra-gap footer contract and
 * full Settings safe-bound, ancestor-clipping, hit and interior-scroll checks.
 * CDP safe insets and visual-only keyboard occlusion are browser emulation.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupMobile, arm, complete, settle, measure, footerAssertions, openSidebar, settingsReachability, mobileBrowserOptions } from './ui-mobile-helpers.mjs';
import { observeAssets } from './ui-pwa-viewport.mjs';

const git = async (...args) => {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(exitCode, 0, stderr);
  return stdout.trim();
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const SCOPED = ['C5.bottom-reserve', 'C5.controls-bounded-and-hit'];
const SANITY = ['C5.no-horizontal-overflow', 'C5.session-row-coverage', 'C5.list-overflow-owner', 'C5.list-scroll-preserves-footer'];
const STRICT = ['C5.mobile-bottom-gap-exact'];
const SETTINGS = 'C5.settings-reachable';

export async function syntheticKeyboard(page, { width, height, keyboard }) {
  await page.evaluate(({ width, height, keyboard }) => {
    const visualHeight = keyboard ? (height === 844 ? 500 : 270) : height;
    window.mobilePending = window.mobileSignal(() => innerWidth === width && innerHeight === height
      && document.documentElement.hasAttribute('data-th-keyboard-open') === keyboard
      && Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--th-vh-unit')) * 100 - visualHeight) < 1
      && document.documentElement.style.getPropertyValue('--th-vv-top') === '0px');
    if (keyboard) {
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => visualHeight });
      Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 0 });
    } else { delete visualViewport.height; delete visualViewport.offsetTop; }
    visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
  }, { width, height, keyboard });
  await complete(page);
}

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), '--phase must be red or green');
  assert(out, '--out required');
  const browserOptions = await mobileBrowserOptions(driver);
  const evidence = resolve(out); await mkdir(evidence, { recursive: true });
  const save = (name, data) => writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + '\n');
  const actions = [], results = [], cleanup = [], failures = [], screenshots = [], bindings = [];
  const [sha, tree, productDiff] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'),
    git('diff', 'HEAD', '--', 'frontend', 'DESIGN.md')]);
  const receipt = { phase, browserOptions, cwd: process.cwd(), sha, tree, productDiff, started: new Date().toISOString(),
    command: `QA_PLAYWRIGHT=${browserOptions.driver} bun test/qa/ui-mobile-footer-polish.mjs --phase ${phase} --out ${out}`,
    sources: Object.fromEntries(await Promise.all(['ui-mobile-footer-polish.mjs', 'ui-mobile-helpers.mjs',
      'design-workbench-fixture.mjs', 'pane-workspace-ui.mjs'].map(async file =>
      [file, hash(await readFile(resolve('test/qa', file)))]))),
    scopeNote: 'Independent keyboard/inset/surface expectations; legacy C5 IDs remain intact. Browser emulation only.',
    productSources: Object.fromEntries(await Promise.all(['frontend/src/styles/settings-menu.css',
      'frontend/src/styles/sidebar.css', 'frontend/index.html', 'frontend/dist/index.html',
      ...Array.from(new Bun.Glob('frontend/dist/assets/*.{css,js}').scanSync('.'))].map(async file =>
      [file, hash(await readFile(file))]))),
    limitations: [
      'Installed playwright-core preserves the existing real-App fixture API; headless Chrome is a disposable profile.',
      'Chrome emulates viewport/safe-area geometry; it is not iOS browser-bar, physical-keyboard or home-indicator hardware.',
      'Synthetic keyboard occlusion reduces only VisualViewport; the layout remains an unoccluded witness. No OS keyboard is rendered.',
      'Pan probe overrides only visualViewport height/offsetTop and dispatches its scroll event; explicitly synthetic.',
      'Keyboard-open necessary bottom inset is zero (keyboard occludes the home-indicator region).',
    ] };
  let browser;
  async function capture(q, name, inset, extra = {}, safeTop = 0) {
    const motion = await settle(q.page);
    const geometry = await measure(q.page, inset, safeTop, q.expectations);
    const image = `${name}.png`, path = resolve(evidence, image);
    await q.page.screenshot({ path, animations: 'allow' });
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    screenshots.push({ path: image, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: hash(bytes) });
    await save(`${name}.json`, { name, ...extra, motion, geometry });
    actions.push({ action: 'capture', name, image, geometry: `${name}.json` });
    return geometry;
  }
  async function scenario(name, options, exercise) {
    let q, binding;
    try {
      q = await setupMobile(browser, { ...options, beforeNavigate(page, url) { binding = observeAssets(page, url); } }, actions);
      const assets = await binding(); bindings.push({ scenario: name, ...assets });
      results.push({ scenario: name, id: 'C5.served-byte-binding', pass: assets.pass, actual: assets });
      q.expectations = { expectedKeyboard: false, mode: 'browser', sidebarOpen: true,
        safeInsets: { top: 0, bottom: 0, left: 0, right: 0 }, surface: { top: 0, left: 0, right: 390, bottom: 844 } };
      await exercise(q, name);
      assert.deepEqual(q.errors, [], `${name}: browser exceptions`);
      assert.deepEqual(q.fixture.unexpected, [], `${name}: unexpected fixture traffic`);
      assert.equal(q.fixture.requests.some(r => r.path.includes('logout')), false, 'Never invoke logout');
    } catch (error) {
      failures.push({ scenario: name, error: String(error), cause: String(error.cause ?? ''), stack: error.stack });
      if (q) await capture(q, `${name}-infrastructure-failure`, q.expectations.safeInsets.bottom, {}, q.expectations.safeInsets.top);
    } finally {
      if (q) {
        await save(`${name}-traffic.json`, { requests: q.fixture.requests, frameTypes: q.fixture.frames.map(f => f.type),
          unexpected: q.fixture.unexpected, errors: q.errors });
        const closed = await q.close();
        let rebound;
        try { rebound = Bun.serve({ hostname: '127.0.0.1', port: closed.port, fetch: () => new Response('QA cleanup probe') }); }
        finally { if (rebound) await rebound.stop(true); }
        cleanup.push({ scenario: name, url: q.fixture.url, ...closed, portReboundAndReleased: !!rebound });
      }
      await save('actions.json', actions); await save('results.json', results); await save('cleanup.json', cleanup);
    }
  }
  try {
    const { chromium } = await import(browserOptions.driver);
    browser = await chromium.launch({ executablePath: browserOptions.executablePath, headless: true, timeout: 90000 });
    receipt.browserVersion = browser.version();
    for (const theme of ['dark', 'light']) for (const list of ['short', 'long']) {
      await scenario(`mobile-${theme}-${list}`, { theme, list, isMobile: true, hasTouch: true }, async (q, name) => {
        const { page, context } = q, cdp = await context.newCDPSession(page);
        await openSidebar(page);
        // Chrome accepts this feature but does not implement display-mode emulation.
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
        const standalone = await page.evaluate(() => matchMedia('(display-mode: standalone)').matches);
        actions.push({ action: 'probe-display-mode-standalone', scenario: name, supported: standalone });
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        for (const [width, height] of [[390, 844], [844, 390]]) {
          if (width !== 390) {
            await page.evaluate(expected => { window.mobilePending = window.mobileSignal(() => innerWidth === expected
              && Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--th-vh-unit')) * 100 - visualViewport.height) < 1); }, width);
            await page.setViewportSize({ width, height }); await complete(page);
            actions.push({ action: 'rotate', scenario: name, width, height });
          }
          for (const keyboard of [false, true]) {
            if (keyboard) {
              const keyboardHeight = height === 844 ? 500 : 270;
              await syntheticKeyboard(page, { width, height, keyboard: true });
              actions.push({ action: 'synthetic-visual-only-keyboard', scenario: name, width, layoutHeight: height,
                visualHeight: keyboardHeight, limitation: 'Synthetic VisualViewport occlusion; no OS keyboard rendered' });
            }
            for (const safeTop of [0, 59]) for (const inset of [0, 34]) {
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: safeTop, left: 0, right: 0, bottom: inset } });
              actions.push({ action: 'CDP-safe-area', scenario: name, method: 'Emulation.setSafeAreaInsetsOverride', insets: { top: safeTop, bottom: inset } });
              q.expectations = { expectedKeyboard: keyboard, mode: 'browser', sidebarOpen: true,
                safeInsets: { top: safeTop, bottom: inset, left: 0, right: 0 },
                surface: { top: 0, left: 0, right: width, bottom: keyboard ? (height === 844 ? 500 : 270) : height } };
              const key = `${name}-${width}x${height}-${keyboard ? 'keyboard' : 'closed'}-top${safeTop}-safe${inset}`;
              const g = await capture(q, `C5-${phase}-${key}`, inset, { keyboardEmulation: keyboard ? 'synthetic-visual-only' : 'closed' }, safeTop);
              results.push(...footerAssertions(g).map(row => ({ scenario: key, ...row })));
              results.push({ scenario: key, id: 'C5.session-row-coverage',
                pass: g.sessionRows === (list === 'long' ? 24 : 4), actual: { expected: list === 'long' ? 24 : 4, count: g.sessionRows } });
              if (list === 'long') results.push({ scenario: key, id: 'C5.list-overflow-owner',
                pass: g.sessionRows === 24 && g.body.clientHeight > 0 && g.body.scrollHeight > g.body.clientHeight
                  && g.body.overflowY === 'auto', actual: { sessionRows: g.sessionRows, ...g.body } });
              if (list === 'long') {
                await page.locator('.th-sidebar-body').evaluate(element => {
                  window.mobilePending = new Promise((done, fail) => {
                    const timer = setTimeout(() => { element.removeEventListener('scroll', finish); fail(new Error('List scroll deadline')); }, 30000);
                    function finish() { clearTimeout(timer); element.removeEventListener('scroll', finish); done(true); }
                    element.addEventListener('scroll', finish, { once: true });
                    element.scrollTop = element.scrollTop === 0 ? element.scrollHeight : 0;
                  });
                });
                await complete(page);
                const scrolled = await measure(page, inset, safeTop, q.expectations);
                results.push({ scenario: key, id: 'C5.list-scroll-preserves-footer', pass: Math.abs(scrolled.footer.rect.bottom - g.footer.rect.bottom) < 1,
                  actual: { before: g.footer.rect, after: scrolled.footer.rect, listScrollTop: scrolled.body.scrollTop } });
                actions.push({ action: 'scroll-session-list', scenario: key, scrollTop: scrolled.body.scrollTop });
              }
              await arm(page, () => !!document.querySelector('.th-settings-panel'));
              await page.locator('.th-settings-menu > button').click(); await complete(page);
              await capture(q, `C5-${phase}-${key}-settings`, inset, {}, safeTop);
              const reachable = await settingsReachability(page, inset, safeTop, q.expectations);
              results.push({ scenario: key, ...reachable });
              actions.push({ action: 'reach-scrollable-settings-controls', scenario: key, ...reachable.actual });
              await capture(q, `C5-${phase}-${key}-settings-scrolled`, inset, {}, safeTop);
              await arm(page, () => !document.querySelector('.th-settings-panel'));
              await page.keyboard.press('Escape'); await complete(page);
              actions.push({ action: 'settings-open-close', scenario: key, closed: true, logoutClicked: false });
            }
            if (keyboard) {
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 34 } });
              await syntheticKeyboard(page, { width, height, keyboard: false });
              await arm(page, () => document.documentElement.style.getPropertyValue('--th-vv-top') === '60px');
              await page.evaluate(visibleHeight => {
                Object.defineProperty(visualViewport, 'height', { configurable: true, value: visibleHeight });
                Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 60 });
                visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
              }, height === 844 ? 500 : 270);
              await complete(page);
              q.expectations = { expectedKeyboard: true, mode: 'browser', sidebarOpen: true,
                safeInsets: { top: 0, bottom: 34, left: 0, right: 0 },
                surface: { top: 60, left: 0, right: width, bottom: 60 + (height === 844 ? 500 : 270) } };
              const key = `${name}-${width}x${height}-synthetic-pan60-safe34`;
              const g = await capture(q, `C5-${phase}-${key}`, 34, { keyboardEmulation: 'synthetic visualViewport height and offsetTop=60 inside original layout viewport' });
              results.push(...footerAssertions(g).map(row => ({ scenario: key, ...row })));
              actions.push({ action: 'synthetic-visual-viewport-pan', scenario: key, offsetTop: 60, measured: g.visualViewport });
              await syntheticKeyboard(page, { width, height, keyboard: false });
            }
          }
          await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
        }
        await cdp.detach();
      });
    }
  } catch (error) { failures.push({ scenario: 'runner', error: String(error), stack: error.stack }); }
  finally {
    if (browser) { await browser.close(); cleanup.push({ browserClosed: !browser.isConnected(), disposableProfileManagedByPlaywright: true }); }
    receipt.productDiffAfter = await git('diff', 'HEAD', '--', 'frontend', 'DESIGN.md');
    receipt.inputsUnchanged = (await Promise.all(Object.entries(receipt.productSources).map(async ([path, digest]) => hash(await readFile(path)) === digest))).every(Boolean);
    receipt.finished = new Date().toISOString();
    const scoped = results.filter(r => SCOPED.includes(r.id)), sanity = results.filter(r => SANITY.includes(r.id)),
      strict = results.filter(r => STRICT.includes(r.id)), settings = results.filter(r => r.id === SETTINGS);
    receipt.tally = { assertions: results.length, scoped: { pass: scoped.filter(r => r.pass).length, total: scoped.length },
      strict: { pass: strict.filter(r => r.pass).length, total: strict.length },
      sanity: { pass: sanity.filter(r => r.pass).length, total: sanity.length },
      settings: { pass: settings.filter(r => r.pass).length, total: settings.length } };
    receipt.status = failures.length || !receipt.inputsUnchanged ? 'INFRASTRUCTURE_FAILURE'
      : phase === 'red'
        ? sanity.length && sanity.every(r => r.pass) && (scoped.some(r => !r.pass) || strict.some(r => !r.pass) || settings.some(r => !r.pass))
          && cleanup.filter(c => c.contextClosed).length === 4 ? 'RED_CONFIRMED' : 'UNEXPECTED_BASELINE'
        : sanity.length && sanity.every(r => r.pass) && scoped.every(r => r.pass) && strict.every(r => r.pass)
          && settings.every(r => r.pass) && results.every(r => r.pass) ? 'GREEN_SCOPED' : 'ASSERTION_FAILURE';
    receipt.exitStatus = receipt.status === 'INFRASTRUCTURE_FAILURE' ? 2 : receipt.status === 'RED_CONFIRMED' ? 1
      : receipt.status === 'GREEN_SCOPED' ? 0 : receipt.status === 'UNEXPECTED_BASELINE' ? 2 : 1;
    await save('receipt.json', receipt); await save('results.json', results); await save('failures.json', failures);
    await save('actions.json', actions); await save('cleanup.json', cleanup); await save('screenshots.json', screenshots); await save('served-bindings.json', bindings);
  }
  console.log(JSON.stringify({ status: receipt.status, exitStatus: receipt.exitStatus, phase, assertions: results.length,
    tally: receipt.tally, scopedFailures: results.filter(r => SCOPED.includes(r.id) && !r.pass)
      .map(({ scenario, id, actual }) => ({ scenario, id, actual: id === 'C5.bottom-reserve' ? actual : undefined })),
    strictFailures: results.filter(r => STRICT.includes(r.id) && !r.pass)
      .map(({ scenario, actual }) => ({ scenario, actual })),
    settingsFailures: results.filter(r => r.id === SETTINGS && !r.pass).map(r => r.scenario),
    infrastructureFailures: failures, screenshots: screenshots.length, evidence }, null, 2));
  return receipt.exitStatus;
}
if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } }, strict: true });
  process.exitCode = await run(values);
}
