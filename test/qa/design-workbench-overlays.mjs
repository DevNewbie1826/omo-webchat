/** Actual-App Settings/dialog proof, using the same reusable capture gate as C1.
 * QA_PLAYWRIGHT=<installed-driver> bun test/qa/design-workbench-overlays.mjs EVIDENCE
 * Captures/DOM receipts are not a rendered-image acceptance verdict.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setupDesign, arm, complete } from './design-workbench-fixture.mjs';
import { captureSettled } from './design-workbench-capture.mjs';

const root = resolve(import.meta.dir, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
async function identity() {
  const files = [];
  for (const path of git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()) {
    files.push({ path, sha256: hash(await readFile(resolve(root, path))) });
  }
  const assets = [];
  for (const path of (await readdir(resolve(root, 'frontend/dist'), { recursive: true })).sort()) {
    const full = resolve(root, 'frontend/dist', path);
    if ((await stat(full)).isFile()) assets.push({ path: `frontend/dist/${path}`, sha256: hash(await readFile(full)) });
  }
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), status, dirty: status !== '',
    sourceDigest: hash(JSON.stringify(files)), files, assets, buildDigest: hash(JSON.stringify(assets)) };
}

export async function runOverlayProbes(evidence, driver = process.env.QA_PLAYWRIGHT) {
  assert(driver, 'QA_PLAYWRIGHT must identify an installed driver');
  evidence = resolve(evidence); await mkdir(evidence, { recursive: true });
  const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + '\n');
  const source = await identity(), results = [], cleanup = [], traffic = [];
  const catalogs = Object.fromEntries(await Promise.all(['en', 'ko'].map(async lang =>
    [lang, JSON.parse(await readFile(resolve(root, `frontend/src/i18n/locales/${lang}.json`), 'utf8'))])));
  const { chromium } = await import(driver);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  await save('source.json', { ...source, driver, browserVersion: browser.version(), pid: process.pid, started: new Date().toISOString() });
  async function scenario(key, options, kind) {
    let q;
    try {
      q = await setupDesign(browser, options);
      const { page, fixture } = q, lang = options.lang ?? 'en', fontSize = options.fontSize ?? 14;
      const catalog = catalogs[lang];
      let readiness, opened, dom;
      if (kind === 'settings') {
        if (await page.locator('.th-sidebar').getAttribute('aria-hidden') === 'true') {
          await arm(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true');
          await page.locator('.th-mobile-menu').click(); await complete(page, { target: '.th-sidebar' });
        }
        readiness = { target: '.th-settings-panel', settings: { fontSize, lang } };
        await arm(page, () => !!document.querySelector('.th-settings-panel'));
        await page.locator('.th-settings-menu > button').click(); opened = await complete(page, readiness);
        assert.equal(await page.getByRole('region', { name: catalog['settings.title'], exact: true }).count(), 1);
        dom = { controls: await page.locator('.th-settings-panel').innerText() };
      } else {
        assert(Object.hasOwn(catalog, 'common.cancel'), `${lang} requires its own cancellation entry`);
        assert(catalog['common.cancel'] && catalog['common.cancel'] !== 'common.cancel');
        if (lang === 'ko') assert.notEqual(catalog['common.cancel'], catalogs.en['common.cancel']);
        readiness = { target: '[role="dialog"][aria-modal="true"]' };
        const trigger = page.locator('.th-disconnect-btn');
        await trigger.focus();
        await arm(page, () => document.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true');
        await trigger.click(); opened = await complete(page, readiness);
        // Playwright's role query computes the accessible name, not just the attribute.
        const dialog = page.getByRole('dialog', { name: catalog['chat.disconnect'], exact: true });
        assert.equal(await dialog.count(), 1, 'actual accessible dialog name');
        assert.equal(await dialog.getByRole('button', { name: catalog['common.cancel'], exact: true }).count(), 1);
        dom = await dialog.evaluate(panel => ({ title: panel.querySelector('h2').textContent,
          titleId: panel.querySelector('h2').id, labelledBy: panel.getAttribute('aria-labelledby'),
          focusInside: panel.contains(document.activeElement), buttons: [...panel.querySelectorAll('button')].map(button => {
            const r = button.getBoundingClientRect(), p = panel.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { text: button.textContent, label: button.getAttribute('aria-label'), disabled: button.disabled,
              hit: button === hit || button.contains(hit), bounded: r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom };
          }) }));
        assert(dom.titleId && dom.labelledBy === dom.titleId && dom.focusInside);
        assert(dom.buttons.every(button => button.hit && button.bounded && !button.disabled));
      }
      const full = `${key}-full.png`, crop = `${key}-crop.png`;
      const fullReady = await captureSettled(page, readiness, { path: resolve(evidence, full) });
      const cropReady = await captureSettled(page, readiness, { path: resolve(evidence, crop), clip: fullReady.rect });
      const cancellation = [];
      if (kind === 'dialog') {
        for (const action of ['Cancel', 'Escape']) {
          if (action === 'Escape') {
            await arm(page, () => !!document.querySelector('[role="dialog"]'));
            await page.locator('.th-disconnect-btn').click(); await complete(page, readiness);
          }
          await arm(page, () => !document.querySelector('[role="dialog"]') && document.activeElement?.matches('.th-disconnect-btn'));
          if (action === 'Cancel') await page.getByRole('dialog').getByRole('button', { name: catalog['common.cancel'], exact: true }).click();
          else await page.keyboard.press('Escape');
          await complete(page);
          assert.equal(fixture.frames.filter(frame => frame.type === 'chat.disconnect').length, 0);
          assert.equal(await page.locator('.th-chat-pane').count(), 1);
          cancellation.push({ action, focusRestored: true, disconnectFrames: 0, paneRetained: true });
        }
      } else {
        await arm(page, () => !document.querySelector('.th-settings-panel'));
        await page.keyboard.press('Escape'); await complete(page);
      }
      assert.deepEqual(q.errors, []); assert.deepEqual(fixture.unexpected, []);
      const images = await Promise.all([full, crop].map(async path => ({ path, sha256: hash(await readFile(resolve(evidence, path))) })));
      const row = { key, kind, options, pass: true, opened, fullReady, cropReady, dom, cancellation, images };
      results.push(row); await save(`${key}.json`, row);
    } catch (error) {
      results.push({ key, kind, options, pass: false, error: String(error), stack: error.stack });
    } finally {
      if (q) {
        cleanup.push({ key, ...await q.close() });
        traffic.push({ key, frames: q.fixture.frames, requests: q.fixture.requests, unexpected: q.fixture.unexpected, errors: q.errors });
      }
      await save('results.json', results);
    }
  }
  try {
    // Keep the six R3 rejected Settings keys; also cover both locales/themes/geometries.
    for (const lang of ['en', 'ko']) for (const theme of ['dark', 'light']) {
      await Promise.all([[1280, 900], [390, 844]].map(async ([width, height]) => {
        const options = { lang, theme, viewport: { width, height }, coarse: width === 390 };
        await scenario(`Settings.${theme}.${width}x${height}${lang === 'ko' ? '.ko' : ''}`, options, 'settings');
        await scenario(`dialog.${lang}.${theme}.${width}x${height}`, options, 'dialog');
      }));
    }
    for (const fontSize of [13, 14, 15]) await scenario(`font.${fontSize}.dark.1280x900.settings`, { fontSize, theme: 'dark' }, 'settings');
  } finally {
    await browser.close(); cleanup.push({ browserClosed: !browser.isConnected() });
    await save('cleanup.json', cleanup); await save('traffic.json', traffic);
    const final = await identity(); await save('source-after.json', final);
    assert.deepEqual(final, source, 'source and built assets must stay stable during probes');
  }
  const pass = results.every(row => row.pass);
  console.log(JSON.stringify({ pass, results: results.map(({ key, pass, error }) => ({ key, pass, error })), evidence }, null, 2));
  return pass;
}
if (import.meta.main && !await runOverlayProbes(process.argv[2])) process.exitCode = 1;
