import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSummaryFixture, stages, viewports } from './dag-summary-fixture.mjs';
import { armDOM, doneDOM, readSummaryDOM, assertSummaryDOM, assertVisibleBadge, settleCapture } from './dag-summary-surface.mjs';
import { confirmPortReleased, installDOMSignals } from './dag-state-ordering.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('Chrome DOM machinery observes exact post-arm mutations, rejects false exact/hidden badges, and cancels pending signals', { timeout: 30000 }, async () => {
  const copy = JSON.parse(await readFile(join(root, 'frontend/src/i18n/locales/en.json'), 'utf8'));
  const assets = await mkdtemp(join(tmpdir(), 'dag-summary-dom-test-'));
  const profile = await mkdtemp(join(tmpdir(), 'dag-summary-dom-profile-'));
  let fixture, context;
  const cleanup = { errors: [] }, observations = [];
  const clean = async (key, action) => { try { cleanup[key] = await action() ?? true; } catch (error) { cleanup.errors.push({ key, error: String(error) }); } };
  try {
    // Deliberately not a product surface. This tests the oracle and DOM barriers only.
    await writeFile(join(assets, 'index.html'), '<!doctype html><html><body><div class="th-chat-body">ordering-entry-159</div><div class="th-chat-input"><textarea></textarea></div></body></html>');
    fixture = startSummaryFixture({ assetsDir: assets });
    const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href);
    context = await chromium.launchPersistentContext(profile, { executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, timeout: 15000 });
    context.setDefaultTimeout(15000);
    const page = context.pages()[0]; await installDOMSignals(page);
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.__dagQA.done(window.__dagQA.initial));
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<aside class="th-sidebar"><div class="th-tree-node"><button class="th-tree-activation"><span class="th-tree-label">Stored A</span></button><span class="th-tree-running"></span></div></aside><div class="th-overview-card"><span class="th-overview-card-name">Stored A</span><span class="th-overview-card-running"></span><span class="th-overview-card-line"></span></div>'));
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const stage of stages) {
        const text = ['complete2', 'compact-duplicate-ids', 'complete2-empty-optional-ids', 'complete2-recovery'].includes(stage) ? '2'
          : ['partial-retained1', 'compact-mixed-ids', 'required-empty-node-id'].includes(stage) ? '1+' : '?';
        const suffix = text === '?' ? 'Unknown' : text.endsWith('+') ? 'Partial' : '';
        const marker = `${viewport.width}-${stage}`;
        const signal = await armDOM(page, marker => document.querySelector('.th-overview-card-line').textContent === marker, marker);
        await page.evaluate(({ text, suffix, copy, marker }) => {
          for (const [selector, key] of [['.th-tree-running', 'sidebar.tm.runningAgents'], ['.th-overview-card-running', 'overview.runningAria']]) {
            const node = document.querySelector(selector); node.textContent = text;
            node.setAttribute('aria-label', copy[key + suffix].replace('{n}', String(Number.parseInt(text, 10))));
          }
          document.querySelector('.th-overview-card-line').textContent = marker;
        }, { text, suffix, copy, marker });
        await doneDOM(page, signal); await settleCapture(page);
        const dom = await page.evaluate(readSummaryDOM), binary = assertSummaryDOM(dom, stage, copy);
        assert.equal(dom.marker, marker); assertVisibleBadge(dom, 'sidebar'); assertVisibleBadge(dom, 'overview');
        observations.push({ viewport, stage, dom, binary });
      }
    }
    await page.evaluate(copy => { const badge = document.querySelector('.th-tree-running'); badge.textContent = '1'; badge.setAttribute('aria-label', copy['sidebar.tm.runningAgents'].replace('{n}', '1')); }, copy);
    assert.throws(() => assertSummaryDOM(observations[0].dom, 'complete2', copy));
    const falseExact = await page.evaluate(readSummaryDOM);
    assert.throws(() => assertSummaryDOM(falseExact, 'partial-retained1', copy));
    await page.evaluate(() => document.querySelector('.th-overview-card-running').style.display = 'none');
    const hidden = await page.evaluate(readSummaryDOM); assert.throws(() => assertVisibleBadge(hidden, 'overview'));
    const pending = await armDOM(page, () => !!document.querySelector('[data-never-created]'));
    const cancelled = doneDOM(page, pending), rejection = assert.rejects(cancelled, /cancelled/);
    assert.equal(await page.evaluate(() => window.__dagQA.stop()), 0); await rejection;
  } finally {
    if (context) await clean('contextClosed', () => context.close());
    if (fixture) {
      await clean('fixture', () => fixture.stop());
      await clean('portsReleased', () => Promise.all([fixture.url, fixture.base.url].map(url => confirmPortReleased(Number(new URL(url).port)))));
    }
    for (const [key, path] of [['profileRemoved', profile], ['assetsRemoved', assets]]) await clean(key, async () => {
      await rm(path, { recursive: true, force: true }); await assert.rejects(access(path), { code: 'ENOENT' }); return true;
    });
    if (process.env.QA_HELPER_EVIDENCE) await writeFile(join(process.env.QA_HELPER_EVIDENCE, 'qa-tools-chrome-machinery.json'), JSON.stringify({ productQA: false, observations, cleanup }, null, 2) + '\n');
    assert.deepEqual(cleanup.errors, []);
  }
});
