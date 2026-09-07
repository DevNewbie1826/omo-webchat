/** QA_PLAYWRIGHT=<installed playwright-core/index.mjs> bun test/qa/ui-mobile-footer-polish.mjs --phase red|green --out PATH
 * C5-only companion to ui-mobile-polish.mjs: mobile sidebar footer bottom bounds on the real built SPA.
 * RED intentionally exits 1 only after collecting the intended assertion failures; infrastructure
 * errors exit 2. GREEN requires every scoped, strict and settings assertion green — settings rows
 * are part of C5 (footer scope per the governing brief) and are never excluded or classified.
 * Lead verification detail: the shared helper's <=8px guard cannot prove the tighter mobile
 * target, so every capture also asserts the exact intentional bottom gap — 4px at mobile widths
 * and wherever the platform reports a bottom safe inset, 8px only on inset-less desktop —
 * additively (id C5.mobile-bottom-gap-exact). No existing guard is weakened; the shared harness
 * stays read-only. CDP safe insets and native viewport resize are browser emulation.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupMobile, arm, complete, settle, measure, footerAssertions, openSidebar } from './ui-mobile-helpers.mjs';

const git = async (...args) => {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(exitCode, 0, stderr);
  return stdout.trim();
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Observable stricter target: the measured gap from the usable safe bottom to
// the lowest footer control is exactly the intentional padding — 4px at mobile
// widths (the closed tightened target), 8px outside mobile width where the
// brief preserves normal spacing and the shell carries the platform's bottom
// safe inset. Tolerance 0.5px absorbs subpixel rounding only.
const strictGapRow = (key, g) => {
  const expectedGap = g.mobileMedia ? 4 : 8;
  return { scenario: key, id: 'C5.mobile-bottom-gap-exact',
    pass: Math.abs(g.usableBottomGap - expectedGap) <= 0.5,
    actual: { expectedGap, usableBottomGap: g.usableBottomGap, bottomGap: g.bottomGap,
      necessaryBottomInset: g.necessaryBottomInset, safeBottom: g.safe.bottom, mobileMedia: g.mobileMedia,
      footerPaddingBottom: g.footer.paddingBottom, sidebarPaddingBottom: g.sidebar.paddingBottom } };
};

const SCOPED = ['C5.bottom-reserve', 'C5.controls-bounded-and-hit'];
const SANITY = ['C5.no-horizontal-overflow', 'C5.session-row-coverage', 'C5.list-overflow-owner', 'C5.list-scroll-preserves-footer'];
const STRICT = ['C5.mobile-bottom-gap-exact'];
const SETTINGS = 'C5.settings-reachable';

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), '--phase must be red or green');
  assert(out && driver, '--out and QA_PLAYWRIGHT are required');
  const evidence = resolve(out); await mkdir(evidence, { recursive: true });
  const save = (name, data) => writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + '\n');
  const actions = [], results = [], cleanup = [], failures = [], screenshots = [];
  const [sha, tree, productDiff] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'),
    git('diff', 'HEAD', '--', 'frontend', 'DESIGN.md')]);
  const receipt = { phase, cwd: process.cwd(), sha, tree, productDiff, started: new Date().toISOString(),
    command: `QA_PLAYWRIGHT=${driver} bun test/qa/ui-mobile-footer-polish.mjs --phase ${phase} --out ${out}`,
    sources: Object.fromEntries(await Promise.all(['ui-mobile-footer-polish.mjs', 'ui-mobile-helpers.mjs',
      'design-workbench-fixture.mjs', 'pane-workspace-ui.mjs'].map(async file =>
      [file, hash(await readFile(resolve('test/qa', file)))]))),
    scopeNote: 'split-view.css / mobileOutline.test.ts changes in productDiff belong to the parallel outline producer; '
      + 'C5 footer geometry is independent of active-pane outline paint.',
    limitations: [
      'Installed playwright-core preserves the existing real-App fixture API; headless Chrome is a disposable profile.',
      'Chrome emulates viewport/safe-area geometry; it is not iOS browser-bar, physical-keyboard or home-indicator hardware.',
      'Keyboard emulation resizes layout and visual viewport together; no OS keyboard is rendered.',
      'Pan probe overrides only visualViewport height/offsetTop and dispatches its scroll event; explicitly synthetic.',
      'Keyboard-open necessary bottom inset is zero (keyboard occludes the home-indicator region).',
    ] };
  let browser;
  async function capture(q, name, inset, extra = {}) {
    const motion = await settle(q.page);
    const geometry = await measure(q.page, inset);
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
    let q;
    try {
      q = await setupMobile(browser, options, actions);
      await exercise(q, name);
      assert.deepEqual(q.errors, [], `${name}: browser exceptions`);
      assert.deepEqual(q.fixture.unexpected, [], `${name}: unexpected fixture traffic`);
      assert.equal(q.fixture.requests.some(r => r.path.includes('logout')), false, 'Never invoke logout');
    } catch (error) {
      failures.push({ scenario: name, error: String(error), cause: String(error.cause ?? ''), stack: error.stack });
      if (q) await capture(q, `${name}-infrastructure-failure`, 0);
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
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 90000 });
    receipt.browserVersion = browser.version();
    for (const theme of ['dark', 'light']) for (const list of ['short', 'long']) {
      await scenario(`mobile-${theme}-${list}`, { theme, list }, async (q, name) => {
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
              await arm(page, () => document.documentElement.hasAttribute('data-th-keyboard-open'));
              await page.setViewportSize({ width, height: keyboardHeight }); await complete(page);
              actions.push({ action: 'native-keyboard-resize', scenario: name, width, layoutHeight: keyboardHeight,
                originalHeight: height, limitation: 'Chrome resizes layout and visual viewport together; no OS keyboard rendered' });
            }
            for (const inset of [0, 34]) {
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: inset } });
              actions.push({ action: 'CDP-safe-area', scenario: name, method: 'Emulation.setSafeAreaInsetsOverride', insets: { bottom: inset } });
              const key = `${name}-${width}x${height}-${keyboard ? 'keyboard' : 'closed'}-safe${inset}`;
              const g = await capture(q, `C5-${phase}-${key}`, inset, { keyboardEmulation: keyboard ? 'native-resize' : 'closed' });
              results.push(...footerAssertions(g).map(row => ({ scenario: key, ...row })));
              results.push(strictGapRow(key, g));
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
                const scrolled = await measure(page, inset);
                results.push({ scenario: key, id: 'C5.list-scroll-preserves-footer', pass: Math.abs(scrolled.footer.rect.bottom - g.footer.rect.bottom) < 1,
                  actual: { before: g.footer.rect, after: scrolled.footer.rect, listScrollTop: scrolled.body.scrollTop } });
                actions.push({ action: 'scroll-session-list', scenario: key, scrollTop: scrolled.body.scrollTop });
              }
              await arm(page, () => !!document.querySelector('.th-settings-panel'));
              await page.locator('.th-settings-menu > button').click(); await complete(page);
              const settings = await capture(q, `C5-${phase}-${key}-settings`, inset);
              const panel = settings.settings, p = panel.rect, safe = settings.safe;
              const panelBounded = p.top >= safe.top - 1 && p.bottom <= safe.bottom + 1 && p.left >= safe.left - 1 && p.right <= safe.right + 1;
              let reachable = panel.controls.every(c => c.hit && c.bounded);
              if (panelBounded && ['auto', 'scroll'].includes(panel.overflowY)) {
                const controls = page.locator('.th-settings-panel').locator('button, select');
                const scrolledControls = [];
                for (let index = 0; index < await controls.count(); index++) {
                  await controls.nth(index).scrollIntoViewIfNeeded();
                  scrolledControls.push((await measure(page, inset)).settings.controls[index]);
                }
                reachable = scrolledControls.every(c => c.hit && c.bounded);
                actions.push({ action: 'reach-scrollable-settings-controls', scenario: key, controls: scrolledControls });
              }
              results.push({ scenario: key, id: SETTINGS, pass: panelBounded && reachable, actual: panel });
              await arm(page, () => !document.querySelector('.th-settings-panel'));
              await page.keyboard.press('Escape'); await complete(page);
              actions.push({ action: 'settings-open-close', scenario: key, closed: true, logoutClicked: false });
            }
            if (keyboard) {
              await arm(page, () => !document.documentElement.hasAttribute('data-th-keyboard-open'));
              await page.setViewportSize({ width, height }); await complete(page);
              await arm(page, () => document.documentElement.style.getPropertyValue('--th-vv-top') === '60px');
              await page.evaluate(visibleHeight => {
                Object.defineProperty(visualViewport, 'height', { configurable: true, value: visibleHeight });
                Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 60 });
                visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
              }, height === 844 ? 500 : 270);
              await complete(page);
              const key = `${name}-${width}x${height}-synthetic-pan60-safe34`;
              const g = await capture(q, `C5-${phase}-${key}`, 34, { keyboardEmulation: 'synthetic visualViewport height and offsetTop=60 inside original layout viewport' });
              results.push(...footerAssertions(g).map(row => ({ scenario: key, ...row })));
              results.push(strictGapRow(key, g));
              actions.push({ action: 'synthetic-visual-viewport-pan', scenario: key, offsetTop: 60, measured: g.visualViewport });
              await page.evaluate(() => { delete visualViewport.offsetTop; delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); });
              await arm(page, () => !document.documentElement.hasAttribute('data-th-keyboard-open'));
              await page.setViewportSize({ width, height }); await complete(page);
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
    receipt.finished = new Date().toISOString();
    const scoped = results.filter(r => SCOPED.includes(r.id)), sanity = results.filter(r => SANITY.includes(r.id)),
      strict = results.filter(r => STRICT.includes(r.id)), settings = results.filter(r => r.id === SETTINGS);
    receipt.tally = { assertions: results.length, scoped: { pass: scoped.filter(r => r.pass).length, total: scoped.length },
      strict: { pass: strict.filter(r => r.pass).length, total: strict.length },
      sanity: { pass: sanity.filter(r => r.pass).length, total: sanity.length },
      settings: { pass: settings.filter(r => r.pass).length, total: settings.length } };
    receipt.status = failures.length ? 'INFRASTRUCTURE_FAILURE'
      : phase === 'red'
        ? sanity.length && sanity.every(r => r.pass) && (scoped.some(r => !r.pass) || strict.some(r => !r.pass))
          && cleanup.filter(c => c.contextClosed).length === 4 ? 'RED_CONFIRMED' : 'UNEXPECTED_BASELINE'
        : sanity.length && sanity.every(r => r.pass) && scoped.every(r => r.pass) && strict.every(r => r.pass)
          && settings.every(r => r.pass) ? 'GREEN_SCOPED' : 'ASSERTION_FAILURE';
    receipt.exitStatus = failures.length ? 2 : receipt.status === 'RED_CONFIRMED' ? 1
      : receipt.status === 'GREEN_SCOPED' || receipt.status === 'UNEXPECTED_BASELINE' ? 0 : 1;
    await save('receipt.json', receipt); await save('results.json', results); await save('failures.json', failures);
    await save('actions.json', actions); await save('cleanup.json', cleanup); await save('screenshots.json', screenshots);
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
