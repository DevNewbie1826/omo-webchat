/** P3 real built-SPA synthetic visual-viewport/safe-area regression matrix.
 * QA_PLAYWRIGHT=<installed driver> bun test/qa/ui-followup-sidebar.mjs --phase red|green --out ABSOLUTE_PATH
 * No DOM/style injection, real user service, polling delay or shared browser profile.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupMobile, arm, complete, settle, measure, footerAssertions, openSidebar, settingsReachability } from './ui-mobile-helpers.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = async (...args) => {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, stderr); return stdout.trim();
};
const viewports = [[390, 844], [384, 844], [768, 844], [769, 844], [844, 390], [1280, 800]];
const states = ['baseline', 'nonkeyboard-origin34', 'nonkeyboard-top0', 'keyboard-origin', 'restored'];
const productPaths = ['frontend/src/styles/sidebar.css', 'frontend/src/styles/mobile-drawer.css', 'frontend/src/styles/global.css', 'frontend/index.html'];

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), 'phase must be red or green');
  assert(out && isAbsolute(out) && driver, 'absolute --out and QA_PLAYWRIGHT required');
  await mkdir(out, { recursive: true });
  const save = (name, data) => writeFile(resolve(out, name), JSON.stringify(data, null, 2) + '\n');
  const results = [], failures = [], actions = [], cleanup = [], screenshots = [];
  const sources = [...productPaths, 'DESIGN.md', 'test/qa/ui-followup-sidebar.mjs', 'test/qa/ui-mobile-helpers.mjs',
    'test/qa/design-workbench-fixture.mjs', 'test/qa/pane-workspace-ui.mjs', 'frontend/dist/index.html',
    ...new Bun.Glob('frontend/dist/assets/*.{css,js}').scanSync('.')];
  const receipt = { phase, command: `QA_PLAYWRIGHT=${driver} bun test/qa/ui-followup-sidebar.mjs --phase ${phase} --out ${out}`,
    cwd: process.cwd(), head: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'),
    dirty: await git('status', '--short'), productDiff: await git('diff', 'HEAD', '--', ...productPaths),
    inputHashes: Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))]))),
    inventory: { themes: ['dark', 'light'], languages: ['en', 'ko'], fonts: [13, 24], lists: ['short', 'long'], viewports, states,
      safeBottom: [0, 34], safeTop: '0 everywhere plus 59 at width390',
      captures: 'every state/viewport/theme/language/font/list with safeBottom34 and safeTop0; Settings keyboard/origin captures at width390 safeTop59 safeBottom34' },
    limitation: 'Synthetic visualViewport getters and CDP safe insets, not physical iPhone behavior. No product style or DOM overrides.',
    started: new Date().toISOString() };
  let browser;
  const check = (scenario, id, pass, actual) => results.push({ scenario, id, pass, actual });
  async function capture(page, name) {
    const path = resolve(out, `${name}.png`); await page.screenshot({ path, animations: 'allow' });
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    screenshots.push({ path, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  }
  try {
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 90000 });
    receipt.browserVersion = browser.version();
    for (const theme of ['dark', 'light']) for (const lang of ['en', 'ko']) for (const fontSize of [13, 24]) for (const list of ['short', 'long']) {
      const contextName = `${theme}-${lang}-font${fontSize}-${list}`;
      let q, cdp;
      try {
        q = await setupMobile(browser, { theme, lang, fontSize, list }, actions);
        const { page } = q;
        cdp = await q.context.newCDPSession(page);
        const draft = `Sidebar viewport draft ${contextName}`;
        // The controlled fixture leaves the real composer editable; no message is sent.
        await page.locator('.th-pane--focused textarea').fill(draft);
        await openSidebar(page);
        const dimensions = (await measure(page, 0)).controls.map(c => ({ width: c.rect.width, height: c.rect.height }));
        for (const [width, height] of viewports) {
          await page.evaluate(() => {
            delete visualViewport.height; delete visualViewport.offsetTop;
            visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
          });
          await page.evaluate(width => { window.mobilePending = window.mobileSignal(() => innerWidth === width
            && Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--th-vh-unit')) * 100 - visualViewport.height) < 1); }, width);
          await page.setViewportSize({ width, height }); await complete(page);
          await openSidebar(page);
          for (const state of states) {
            const visualHeight = state === 'keyboard-origin' ? Math.max(270, height - 340)
              : state.startsWith('nonkeyboard') ? height - 34 : height;
            const top = state === 'keyboard-origin' ? height - visualHeight : state === 'nonkeyboard-origin34' ? 34 : 0;
            await page.evaluate(({ visualHeight, top, restore }) => {
              if (restore) { delete visualViewport.height; delete visualViewport.offsetTop; }
              else {
                Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => visualHeight });
                Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => top });
              }
              visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
            }, { visualHeight, top, restore: state === 'restored' });
            actions.push({ action: 'synthetic-visual-input', context: contextName, width, height, state, visualHeight, top });
            for (const safeTop of width === 390 ? [0, 59] : [0]) for (const safeBottom of [0, 34]) {
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: safeTop, bottom: safeBottom, left: 0, right: 0 } });
              const name = `${contextName}-${width}x${height}-${state}-top${safeTop}-safe${safeBottom}`;
              await settle(page);
              const g = await measure(page, safeBottom, safeTop);
              const backdrop = await page.locator('.th-backdrop').evaluateAll(elements => elements.map(e => ({
                display: getComputedStyle(e).display, rect: e.getBoundingClientRect().toJSON() })));
              check(name, 'P3.input', Math.abs(g.visualViewport.height - visualHeight) <= 1 && g.visualViewport.top === top
                && g.keyboardOpen === (state === 'keyboard-origin'), { visualHeight, top, keyboard: g.keyboardOpen, measured: g.visualViewport });
              check(name, 'P3.sidebar-coordinates', Math.abs(g.sidebar.rect.bottom - g.visualViewport.bottom) <= 1
                && Math.abs(g.sidebar.rect.top - (top + (g.mobileMedia ? 0 : safeTop))) <= 1, { sidebar: g.sidebar.rect, viewport: g.visualViewport, safeTop });
              check(name, 'P3.backdrop-coordinates', g.mobileMedia ? backdrop.length === 1 && backdrop.every(b => b.display !== 'none'
                && Math.abs(b.rect.top - top) <= 1 && Math.abs(b.rect.bottom - g.visualViewport.bottom) <= 1)
                : backdrop.every(b => b.display === 'none'), backdrop);
              results.push(...footerAssertions(g).map(row => ({ scenario: name, ...row })));
              check(name, 'P3.zero-footer-padding', g.footer.paddingBottom === 0, g.contributions);
              check(name, 'P3.icon-dimensions', g.controls.every((c, i) => c.rect.width === dimensions[i].width && c.rect.height === dimensions[i].height),
                { before: dimensions, after: g.controls.map(c => c.rect) });
              check(name, 'P3.session-inventory', g.sessionRows === (list === 'long' ? 24 : 4), g.sessionRows);
              if (list === 'long' && g.body.clientHeight > 0 && g.body.scrollHeight > g.body.clientHeight) {
                await page.locator('.th-sidebar-body').evaluate(element => {
                  window.mobilePending = new Promise((done, fail) => {
                    const timer = setTimeout(() => { element.removeEventListener('scroll', finish); fail(new Error('Sidebar scroll deadline')); }, 30000);
                    function finish() { clearTimeout(timer); element.removeEventListener('scroll', finish); done(true); }
                    element.addEventListener('scroll', finish, { once: true });
                    element.scrollTop = element.scrollTop === 0 ? element.scrollHeight : 0;
                  });
                });
                await complete(page);
                const after = await measure(page, safeBottom, safeTop);
                check(name, 'P3.list-scroll-owner', g.body.overflowY === 'auto' && Math.abs(after.footer.rect.bottom - g.footer.rect.bottom) <= 1
                  && after.body.scrollTop !== g.body.scrollTop && after.sidebar.scrollTop === g.sidebar.scrollTop && after.root.scrollTop === g.root.scrollTop,
                  { before: g.body, after: after.body });
              } else if (list === 'long') check(name, 'P3.list-scroll-owner', false, g.body);
              await save(`${name}.json`, { geometry: g, backdrop });
              if (safeBottom === 34 && safeTop === 0) await capture(page, name);
              await arm(page, () => !!document.querySelector('.th-settings-panel'));
              await page.locator('.th-settings-menu > button').click(); await complete(page); await settle(page);
              const settings = await settingsReachability(page, safeBottom, safeTop);
              results.push({ scenario: name, ...settings });
              if (width === 390 && safeTop === 59 && safeBottom === 34 && ['nonkeyboard-origin34', 'keyboard-origin'].includes(state)) {
                await capture(page, `${name}-settings`);
              }
              await arm(page, () => !document.querySelector('.th-settings-panel'));
              await page.keyboard.press('Escape'); await complete(page);
            }
          }
        }
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
        await page.setViewportSize({ width: 390, height: 844 }); await openSidebar(page);
        await arm(page, () => document.querySelector('.th-sidebar').getAttribute('aria-hidden') === 'true');
        await page.locator('.th-backdrop').click({ position: { x: 380, y: 100 } }); await complete(page);
        await openSidebar(page);
        check(contextName, 'P3.draft-preserved', await page.locator('.th-pane--focused textarea').inputValue() === draft, draft);
        assert.deepEqual(q.errors, [], 'browser errors');
        assert.deepEqual(q.fixture.unexpected, [], 'unexpected fixture traffic');
        assert.equal(q.fixture.requests.some(r => /logout/.test(r.path)), false, 'logout must never be invoked');
      } catch (error) {
        failures.push({ scenario: contextName, error: String(error), cause: String(error.cause ?? ''), stack: error.stack });
      } finally {
        if (q) {
          try {
            if (!q.page.isClosed()) await q.page.evaluate(() => {
              delete visualViewport.height; delete visualViewport.offsetTop;
              visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));
            });
            if (cdp) {
              await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
              await cdp.detach();
            }
          } finally {
            await save(`${contextName}-traffic.json`, { requests: q.fixture.requests, unexpected: q.fixture.unexpected, errors: q.errors });
            const closed = await q.close();
            let rebound;
            try { rebound = Bun.serve({ hostname: '127.0.0.1', port: closed.port, fetch: () => new Response('cleanup probe') }); }
            finally { if (rebound) await rebound.stop(true); }
            cleanup.push({ context: contextName, url: q.fixture.url, ...closed, portReboundAndReleased: !!rebound });
          }
        }
        await save('results.json', results); await save('failures.json', failures); await save('cleanup.json', cleanup);
      }
    }
  } catch (error) { failures.push({ scenario: 'runner', error: String(error), stack: error.stack }); }
  finally {
    if (browser) { await browser.close(); cleanup.push({ browserClosed: !browser.isConnected() }); }
    const expectedScenarios = 16 * (20 + 5 * 10);
    const completeInventory = results.filter(r => r.id === 'P3.input').length === expectedScenarios;
    const clean = cleanup.filter(c => c.contextClosed && c.serverStopped && c.pendingWebSockets === 0
      && c.pendingOpens === 0 && c.pendingCreates === 0 && c.portReboundAndReleased).length === 16 && cleanup.at(-1)?.browserClosed;
    const failed = results.filter(r => !r.pass);
    receipt.summary = { scenarios: results.filter(r => r.id === 'P3.input').length, expectedScenarios, assertions: results.length,
      failed: failed.length, screenshots: screenshots.length, completeInventory, clean,
      failureIds: Object.fromEntries([...new Set(failed.map(r => r.id))].map(id => [id, failed.filter(r => r.id === id).length])) };
    receipt.status = failures.length || !completeInventory || !clean ? 'INFRASTRUCTURE_FAILURE'
      : phase === 'red' ? failed.some(r => r.id === 'P3.sidebar-coordinates') && failed.some(r => r.id === 'P3.zero-footer-padding')
        ? 'RED_CONFIRMED' : 'UNEXPECTED_BASELINE'
        : failed.length ? 'ASSERTION_FAILURE' : 'GREEN';
    receipt.exitStatus = receipt.status === 'GREEN' ? 0 : receipt.status === 'RED_CONFIRMED' || receipt.status === 'ASSERTION_FAILURE' ? 1 : 2;
    receipt.finished = new Date().toISOString();
    await save('receipt.json', receipt); await save('results.json', results); await save('failures.json', failures);
    await save('actions.json', actions); await save('cleanup.json', cleanup); await save('screenshots.json', screenshots);
  }
  console.log(JSON.stringify({ status: receipt.status, exitStatus: receipt.exitStatus, ...receipt.summary, failures, out }, null, 2));
  return receipt.exitStatus;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } }, strict: true });
  process.exitCode = await run(values);
}
