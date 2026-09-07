/** Corrective confirmation counter-cases and falsifying visual-observable mutations. */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startFixture } from './pane-workspace-ui.mjs';
import { designSeed, installSignals } from './design-workbench-fixture.mjs';
import { transition } from './ui-composer-fixture.mjs';
import { mixedInputScenario } from './model-control-mixed-input.mjs';
import { confirmControl, installControlSignals } from './model-control-confirmation.mjs';
import { pressureGeometry, assertPressure, motionSample, assertMotion } from './ui-followup-controls-status.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const cases = ['success', 'rejected', 'wrong-session', 'wrong-request', 'wrong-command', 'missing'];
export async function run({ phase, out }) {
  assert(['red', 'green'].includes(phase)); assert(out?.startsWith('/'));
  await mkdir(out, { recursive: true });
  const save = (name, data) => writeFile(resolve(out, name), JSON.stringify(data, null, 2) + '\n');
  const paths = [...new Set([...git('ls-files').split('\n'), ...(await readdir('test/qa')).filter(p => p.endsWith('.mjs')).map(p => `test/qa/${p}`)])]
    .filter(p => /^(frontend\/src\/.*\.(tsx?|css)|test\/qa\/.*\.mjs)$/.test(p));
  const receipt = { phase, cwd: process.cwd(), command: process.argv.join(' '), startedAt: new Date().toISOString(),
    head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), dirty: git('status', '--short'),
    sources: Object.fromEntries(await Promise.all(paths.map(async p => [p, hash(await readFile(p))]))),
    assets: Object.fromEntries(await Promise.all((await readdir('frontend/dist/assets')).map(async p => [p, hash(await readFile(`frontend/dist/assets/${p}`))]))),
    indexHtmlSha256: hash(await readFile('frontend/dist/index.html')), cases, results: [], captures: [], cleanup: [] };
  await save('inputs.json', receipt);
  const { chromium } = await import(process.env.QA_PLAYWRIGHT);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  receipt.browserVersion = browser.version();
  try {
    for (const command of ['set_model', 'set_thinking_level']) for (const mode of cases) {
      const transformed = [];
      const fixture = startFixture({ controlled: true, port: 0, controlResult(request, normal) {
        const frame = structuredClone(normal);
        if (mode === 'rejected') { frame.success = false; frame.error = 'fixture rejected control'; }
        if (mode === 'wrong-session') frame.sessionId = 'not-stored-a';
        if (mode === 'wrong-request') frame.requestId += '-wrong';
        if (mode === 'wrong-command') frame.command = command === 'set_model' ? 'set_thinking_level' : 'set_model';
        transformed.push({ request, original: normal, received: mode === 'missing' ? null : frame });
        return mode === 'missing' ? null : frame;
      } });
      const context = await browser.newContext({ viewport: { width: 1440, height: 700 } });
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      const result = { command, mode, urlBeforeGoto: fixture.url, transformed, saved: [], errors: [] };
      receipt.results.push(result);
      page.on('pageerror', e => result.errors.push(String(e)));
      const shot = async state => {
        const file = `${command}-${mode}-${state}.png`, bytes = await page.screenshot({ path: resolve(out, file) });
        receipt.captures.push({ file, sha256: hash(bytes), command, mode, state });
      };
      try {
        await installSignals(page); await installControlSignals(page);
        const reset = async (seed, viewport) => {
          fixture.reset(seed); await page.setViewportSize(viewport);
          const ready = fixture.wait('frame', f => f.type === 'chat.stats');
          await page.goto(fixture.url); await ready; return page;
        };
        let failure;
        try {
          if (command === 'set_model') result.confirmation = await mixedInputScenario({ fixture, reset, shot, save: async (name, value) => result.saved.push({ name, value }) });
          else {
            await reset({ layout: 'single' }, { width: 1440, height: 700 });
            await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-model-picker-thinking')?.textContent === 'low'));
            await transition(page, () => !!document.querySelector('.th-model-picker-popover'), () => page.locator('.th-model-picker-btn').click());
            result.confirmation = await confirmControl(page, fixture, { thinkingLevel: 'max' }, () => page.locator('.th-thinking-level').filter({ hasText: /^max$/ }).click());
          }
        } catch (error) { failure = error; result.failure = String(error); }
        if (mode === 'success') assert.ifError(failure);
        else { assert(failure instanceof assert.AssertionError, `Expected confirmation assertion, got ${failure}`); assert.equal(result.transformed.length, 1); }
        if (mode === 'rejected') await page.evaluate(command => window.qaSignal(() => command === 'set_model'
          ? document.querySelector('.th-model-picker-label')?.textContent === 'Model A'
          : document.querySelector('.th-model-picker-thinking')?.textContent === 'low'), command);
        result.finalUI = { model: await page.locator('.th-model-picker-label').textContent(), thinking: await page.locator('.th-model-picker-thinking').textContent(),
          popup: await page.locator('.th-model-picker-popover').count() };
        await shot('final'); assert.deepEqual(result.errors, []); assert.deepEqual(fixture.unexpected, []);
        result.pass = true;
      } finally {
        await context.close(); receipt.cleanup.push({ command, mode, url: fixture.url, contextClosed: true, ...await fixture.stop() });
        await save(`${command}-${mode}-traffic.json`, fixture.traffic); await save('results.json', receipt);
      }
    }
    const fixture = startFixture({ ...designSeed(), controlled: true, running: [], shelves: false, port: 0 });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); await installSignals(page, { fontSize: 24, lang: 'ko' });
    const mutations = { name: 'status-observable-mutations', urlBeforeGoto: fixture.url, cases: [] }; receipt.results.push(mutations);
    try {
      const ready = fixture.wait('frame', f => f.type === 'chat.stats'); await page.goto(fixture.url); await ready;
      await transition(page, () => document.querySelectorAll('.th-chat-status-num').length === 2, async () => fixture.deliver('stored-a', { type: 'stats', contextUsage: { percent: 42 }, tokens: { input: 30, cacheRead: 70, output: 5 } }));
      await transition(page, () => !!document.querySelector('[data-chat-run-state="responding"]'), async () => fixture.deliver('stored-a', { type: 'run.started' }));
      for (const [name, selector, property, value, reduced] of [
        ['micro', '.th-chat-status-num', 'font-size', '1px'],
        ['glyphs', '.th-chat-status-num', 'width', '1px'],
        ['bounds', '.th-chat-status-num', 'transform', 'translateX(500px)'],
        ['rotation', '.th-chat-status-spinner', 'animation-play-state', 'paused', false],
        ['reduced', '.th-chat-status-spinner', 'animation', 'th-chat-status-spin 700ms linear infinite', true],
      ]) {
        if (reduced !== undefined) await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
        const el = page.locator(selector).first(), original = await el.getAttribute('style');
        let failed = false, red, green;
        try {
          await el.evaluate((e, { property, value }) => e.style.setProperty(property, value, 'important'), { property, value });
          red = reduced === undefined ? await page.evaluate(pressureGeometry) : await motionSample(page);
          try { reduced === undefined ? assertPressure(red) : assertMotion(red, reduced); } catch (error) { assert(error instanceof assert.AssertionError); failed = true; }
          assert(failed, `${name} mutation must falsify its assertion`);
        } finally {
          await el.evaluate((e, original) => original === null ? e.removeAttribute('style') : e.setAttribute('style', original), original);
          assert.equal(await el.getAttribute('style'), original);
        }
        green = reduced === undefined ? await page.evaluate(pressureGeometry) : await motionSample(page);
        reduced === undefined ? assertPressure(green) : assertMotion(green, reduced);
        mutations.cases.push({ name, selector, property, value, original, red, failed, restoredExactly: true, green });
      }
      mutations.pass = true;
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' }); await context.close();
      receipt.cleanup.push({ name: mutations.name, url: fixture.url, contextClosed: true, ...await fixture.stop() });
    }
  } finally {
    await browser.close(); receipt.browserClosed = !browser.isConnected(); receipt.finishedAt = new Date().toISOString();
    receipt.pass = receipt.results.length === 13 && receipt.results.every(r => r.pass);
    await save('results.json', receipt);
  }
  console.log(JSON.stringify({ pass: receipt.pass, out, cases: receipt.results.length })); return receipt;
}
if (import.meta.main) {
  const value = key => process.argv[process.argv.indexOf(key) + 1];
  const receipt = await run({ phase: value('--phase'), out: value('--out') }); process.exitCode = receipt.pass ? 0 : 1;
}
