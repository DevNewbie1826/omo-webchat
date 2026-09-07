/** QA_PLAYWRIGHT=<installed playwright-core/index.mjs> bun test/qa/ui-mobile-polish.mjs --phase red|green --out PATH
 * Actual built SPA, disposable Chrome context, ephemeral localhost fixture. RED intentionally exits 1
 * only after collecting intended assertion failures; infrastructure errors exit 2. GREEN requires all assertions.
 * CDP safe insets and native viewport resize are browser emulation, not physical-device evidence.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupMobile, arm, complete, settle, measure, footerAssertions, openSidebar, settingsReachability } from './ui-mobile-helpers.mjs';

const git = async (...args) => {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  assert.equal(exitCode, 0, stderr);
  return stdout.trim();
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), '--phase must be red or green');
  assert(out && driver, '--out and QA_PLAYWRIGHT are required');
  const evidence = resolve(out); await mkdir(evidence, { recursive: true });
  const save = (name, data) => writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + '\n');
  const actions = [], results = [], cleanup = [], failures = [], screenshots = [];
  const [sha, tree, productDiff] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'),
    git('diff', 'HEAD', '--', 'frontend', 'DESIGN.md')]);
  const receipt = { phase, cwd: process.cwd(), sha, tree, productDiff, started: new Date().toISOString(),
    command: `QA_PLAYWRIGHT=${driver} bun test/qa/ui-mobile-polish.mjs --phase ${phase} --out ${out}`,
    sources: Object.fromEntries(await Promise.all(['ui-mobile-polish.mjs', 'ui-mobile-helpers.mjs'].map(async file =>
      [file, hash(await readFile(resolve('test/qa', file)))]))),
    productSources: Object.fromEntries(await Promise.all(['frontend/src/styles/settings-menu.css',
      'frontend/src/styles/sidebar.css', 'frontend/index.html', 'frontend/dist/index.html',
      ...Array.from(new Bun.Glob('frontend/dist/assets/*.{css,js}').scanSync('.'))].map(async file =>
      [file, hash(await readFile(file))]))),
    limitations: [
      'Bun.WebView default backend lacks CDP; installed playwright-core preserves the existing real-App fixture API.',
      'Headless Chrome emulates viewport/safe-area geometry, not iOS browser bars, physical keyboards or home-indicator hardware.',
      'CDP viewport clipping leaves visualViewport unchanged; native resize changes layout and visual height together.',
      'Pan probe overrides only visualViewport height/offsetTop and dispatches its scroll event; explicitly synthetic, no CSS/root geometry override.',
      'Keyboard-open necessary bottom inset is zero (keyboard occludes home-indicator); persistent 34px env is an emulated condition, not a measured iOS claim.',
    ] };
  let browser;
  async function capture(q, name, inset, extra = {}, safeTop = 0) {
    const motion = await settle(q.page);
    const geometry = await measure(q.page, inset, safeTop);
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
        const support = await cdp.send('Schema.getDomains');
        actions.push({ action: 'discover-CDP', scenario: name, domains: support.domains.map(d => d.name) });
        // This feature is accepted but not implemented by Chrome's media emulation.
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
        const standalone = await page.evaluate(() => matchMedia('(display-mode: standalone)').matches);
        actions.push({ action: 'probe-display-mode-standalone', supported: standalone });
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        for (const [width, height] of [[390, 844], [844, 390]]) {
          if (width !== 390) {
            await page.evaluate(expected => { window.mobilePending = window.mobileSignal(() => innerWidth === expected
              && Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--th-vh-unit')) * 100 - visualViewport.height) < 1); }, width);
            await page.setViewportSize({ width, height }); await complete(page);
            actions.push({ action: 'rotate', width, height });
          }
          if (list === 'short') {
            // Capture the chat rather than the covering drawer for C1.
            if (width === 390) {
              await arm(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true');
              await page.locator('.th-sidebar-nav-actions > button').last().click(); await complete(page);
            }
            const g = await capture(q, `C1-${phase}-${theme}-${width}x${height}`, 0);
            results.push({ scenario: name, width, id: width <= 768 ? 'C1.mobile-outline-none' : 'C1.wide-outline-visible',
              pass: g.panes.filter(p => p.active).length === 1 && g.panes.filter(p => p.active).every(p =>
                width <= 768 ? p.outlineStyle === 'none' : p.outlineStyle !== 'none'), actual: g.panes });
            if (width === 390) {
              await page.locator('.th-mobile-menu').focus(); await page.keyboard.press('Tab');
              const focus = await page.evaluate(() => ({ visible: document.activeElement.matches(':focus-visible'),
                outline: getComputedStyle(document.activeElement).outlineStyle, className: document.activeElement.className }));
              results.push({ scenario: name, id: 'C1.mobile-keyboard-focus-affordance', pass: focus.visible && focus.outline !== 'none', actual: focus });
            }
            await openSidebar(page);
          }
          for (const keyboard of [false, true]) {
            if (keyboard) {
              const keyboardHeight = height === 844 ? 500 : 270;
              await arm(page, () => document.documentElement.hasAttribute('data-th-keyboard-open'));
              await page.setViewportSize({ width, height: keyboardHeight }); await complete(page);
              actions.push({ action: 'native-keyboard-resize', width, layoutHeight: keyboardHeight, originalHeight: height,
                limitation: 'Chrome resizes layout and visual viewport together; no OS keyboard rendered' });
            }
            for (const safeTop of [0, 59]) for (const inset of [0, 34]) {
              const insets = { top: safeTop, left: 0, right: 0, bottom: inset };
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
              actions.push({ action: 'CDP-safe-area', method: 'Emulation.setSafeAreaInsetsOverride', insets });
              const key = `${name}-${width}x${height}-${keyboard ? 'keyboard' : 'closed'}-top${safeTop}-safe${inset}`;
              const g = await capture(q, `C5-${phase}-${key}`, inset, { keyboardEmulation: keyboard ? 'native-resize' : 'closed' }, safeTop);
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
                const scrolled = await measure(page, inset, safeTop);
                results.push({ scenario: key, id: 'C5.list-scroll-preserves-footer', pass: Math.abs(scrolled.footer.rect.bottom - g.footer.rect.bottom) < 1,
                  actual: { before: g.footer.rect, after: scrolled.footer.rect, listScrollTop: scrolled.body.scrollTop } });
                actions.push({ action: 'scroll-session-list', scenario: key, scrollTop: scrolled.body.scrollTop });
              }
              await arm(page, () => !!document.querySelector('.th-settings-panel'));
              await page.locator('.th-settings-menu > button').click(); await complete(page);
              await capture(q, `C5-${phase}-${key}-settings`, inset, {}, safeTop);
              const reachable = await settingsReachability(page, inset, safeTop);
              results.push({ scenario: key, ...reachable });
              actions.push({ action: 'reach-scrollable-settings-controls', scenario: key, ...reachable.actual });
              await capture(q, `C5-${phase}-${key}-settings-scrolled`, inset, {}, safeTop);
              await arm(page, () => !document.querySelector('.th-settings-panel'));
              await page.keyboard.press('Escape'); await complete(page);
              actions.push({ action: 'settings-open-close', scenario: key, closed: true, logoutClicked: false });
            }
            if (keyboard) {
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 34 } });
              // Restore the physical screenshot envelope before emulating a smaller, panned visual viewport.
              await arm(page, () => !document.documentElement.hasAttribute('data-th-keyboard-open'));
              await page.setViewportSize({ width, height }); await complete(page);
              // Supplementary pan test: production viewport event handler remains unmodified.
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
              actions.push({ action: 'synthetic-visual-viewport-pan', offsetTop: 60, measured: g.visualViewport, root: g.root.rect });
              await arm(page, () => !document.documentElement.hasAttribute('data-th-keyboard-open'));
              await page.evaluate(() => { delete visualViewport.offsetTop; delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); });
              await page.setViewportSize({ width, height }); await complete(page);
            }
          }
          await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
        }
        await cdp.detach();
      });
    }
    for (const theme of ['dark', 'light']) await scenario(`desktop-${theme}`, { theme, layout: 'two' }, async (q, name) => {
      const { page } = q;
      const before = await capture(q, `C1-${phase}-${name}-1280x800`, 0);
      const second = page.locator('.th-pane-wrap').nth(1);
      await arm(page, () => document.querySelectorAll('.th-pane-wrap')[1]?.classList.contains('th-pane--focused'));
      await second.click({ position: { x: 15, y: 15 } }); await complete(page);
      const after = await capture(q, `C1-${phase}-${name}-second-active`, 0);
      results.push({ scenario: name, id: 'C1.desktop-split-active-identity', pass: before.panes.length === 2 && after.panes.length === 2
        && before.panes[0].active && after.panes[1].active && after.panes.filter(p => p.active).length === 1
        && after.panes[1].outlineStyle !== 'none', actual: { before: before.panes, after: after.panes } });
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => ({ visible: document.activeElement.matches(':focus-visible'),
        outline: getComputedStyle(document.activeElement).outlineStyle, tag: document.activeElement.tagName, className: document.activeElement.className }));
      results.push({ scenario: name, id: 'C1.keyboard-focus-affordance', pass: focus.visible && focus.outline !== 'none', actual: focus });
    });
  } catch (error) { failures.push({ scenario: 'runner', error: String(error), stack: error.stack }); }
  finally {
    if (browser) { await browser.close(); cleanup.push({ browserClosed: !browser.isConnected(), disposableProfileManagedByPlaywright: true }); }
    receipt.productDiffAfter = await git('diff', 'HEAD', '--', 'frontend', 'DESIGN.md');
    receipt.finished = new Date().toISOString();
    const expectedFailures = ['C1.mobile-outline-none', 'C5.bottom-reserve', 'C5.mobile-bottom-gap-exact',
      'C5.controls-bounded-and-hit', 'C5.settings-reachable'];
    const redConfirmed = results.some(r => !r.pass) && failures.length === 0
      && cleanup.filter(row => row.contextClosed).length === 6
      && results.filter(r => !expectedFailures.includes(r.id)).every(r => r.pass);
    receipt.status = failures.length ? 'INFRASTRUCTURE_FAILURE' : phase === 'red' && redConfirmed ? 'RED_CONFIRMED'
      : results.every(r => r.pass) ? 'GREEN' : 'ASSERTION_FAILURE';
    receipt.exitStatus = failures.length ? 2 : phase === 'red' ? (redConfirmed ? 1 : 2) : results.every(r => r.pass) ? 0 : 1;
    await save('receipt.json', receipt); await save('results.json', results); await save('failures.json', failures);
    await save('actions.json', actions); await save('cleanup.json', cleanup); await save('screenshots.json', screenshots);
  }
  console.log(JSON.stringify({ status: receipt.status, exitStatus: receipt.exitStatus, phase, assertions: results.length,
    failed: results.filter(r => !r.pass).map(({ scenario, id, actual }) => ({ scenario, id, actual: id.endsWith('bottom-reserve') ? actual : undefined })),
    infrastructureFailures: failures, screenshots: screenshots.length, evidence }, null, 2));
  return receipt.exitStatus;
}
if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } }, strict: true });
  process.exitCode = await run(values);
}
