/** Focused actual-App prerequisite regression; evidence is always a new directory. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setupDesign, arm, complete, wheel } from './design-workbench-fixture.mjs';
import { measure, contentAnchor, assertAnchor } from './design-workbench-measure.mjs';
import { exerciseControls, revealAuxiliaryControl, auxiliarySurfaces } from './design-workbench-controls.mjs';

const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2));
const { chromium } = await import(process.env.QA_PLAYWRIGHT);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], cleanup = [];
try {
  for (const layout of (process.argv[3] ? [process.argv[3]] : ['v4', 'single', 'mixed'])) {
    const q = await setupDesign(browser, { layout: layout === 'surfaces' ? 'single' : layout, viewport: layout === 'single' ? { width: 390, height: 844 } : { width: 1280, height: 900 }, coarse: layout === 'single' });
    const { page } = q;
    try {
      if (layout === 'surfaces') {
        await auxiliarySurfaces(q, suffix => page.screenshot({ path: resolve(evidence, `surfaces-${suffix}.png`) }));
      } else if (layout === 'v4') {
        const geometry = await page.evaluate(() => {
          const wrapper = document.querySelector('.th-chat-scrollport'), body = document.querySelector('.th-chat-body'), goal = document.querySelector('.th-goal-bar');
          const rect = goal.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { wrapper: wrapper.getBoundingClientRect().toJSON(), body: body.getBoundingClientRect().toJSON(), padding: getComputedStyle(body).padding, goal: rect.toJSON(), hit: hit?.className, reachable: goal.contains(hit) };
        });
        await save('v4-geometry.json', geometry);
        await page.screenshot({ path: resolve(evidence, 'v4.png') });
        assert(geometry.reachable, `zero-height transcript must not intercept Goal: ${JSON.stringify(geometry)}`);
        assert(geometry.wrapper.height >= 48, 'short transcript retains one inspectable tool target instead of hiding every record');
        await revealAuxiliaryControl(page, page.locator('.th-goal-bar'));
        await exerciseControls(q, suffix => page.screenshot({ path: resolve(evidence, `${layout}-${suffix}.png`) }));
      } else {
        await page.evaluate(() => {
          window.qaTrace = [];
          const sample = (type, target, stack) => {
            const body = document.querySelector('.th-chat-body'), bounds = body.getBoundingClientRect();
            window.qaTrace.push({ type, target: target?.className, time: performance.now(), top: body.scrollTop, height: body.scrollHeight, stack,
              rows: [...body.querySelectorAll('.th-chat-row')].map(e => ({ index: e.dataset.index, top: e.getBoundingClientRect().top - bounds.top, height: e.getBoundingClientRect().height, transform: e.style.transform })) });
          };
          for (const type of ['scroll', 'scrollend', 'focusin', 'wheel']) document.addEventListener(type, e => sample(type, e.target), true);
          const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
          Object.defineProperty(Element.prototype, 'scrollTop', { ...descriptor, set(value) { sample(`set:${value}`, this, new Error().stack); descriptor.set.call(this, value); } });
          const original = Element.prototype.scrollTo;
          Element.prototype.scrollTo = function(...args) { sample(`scrollTo:${JSON.stringify(args)}`, this, new Error().stack); return original.apply(this, args); };
          new ResizeObserver(() => sample('resize', document.querySelector('.th-chat-body'))).observe(document.querySelector('.th-chat-content'));
        });
        if (layout === 'single') {
          await arm(page, () => document.querySelector('[data-tool-call-id="design-failed"] .th-tool-head')?.getAttribute('aria-expanded') === 'false');
          await page.locator('[data-tool-call-id="design-failed"] .th-tool-head').click(); await complete(page);
          await wheel(page, page.locator('.th-chat-body'), -100000, true);
          await wheel(page, page.locator('.th-chat-body'), 100000, true);
        }
        await exerciseControls(q, async suffix => {
          await page.screenshot({ path: resolve(evidence, `${layout}-${suffix}.png`) });
          await save(`${layout}-${suffix}-trace.json`, await page.evaluate(() => window.qaTrace));
        });
      }
      assert.deepEqual(q.errors, [], 'no browser exceptions');
      assert.deepEqual(q.fixture.unexpected, [], 'no unexpected fixture traffic');
      if (layout === 'single' || layout === 'mixed') {
        const before = await contentAnchor(page);
        await wheel(page, page.locator('.th-chat-body'), -160, true);
        const after = await contentAnchor(page, before);
        assert.throws(() => assertAnchor(before, after), /anchor/, 'deliberate real transcript wheel must fail independence');
        await save(`${layout}-real-scroll-mutation.json`, { before, after, rejected: true });
        await page.screenshot({ path: resolve(evidence, `${layout}-real-scroll-mutation.png`) });
      }
      results.push({ layout, pass: true });
    } catch (error) {
      results.push({ layout, pass: false, error: String(error), stack: error.stack });
      await save(`${layout}-FAIL-geometry.json`, await measure(page));
      await save(`${layout}-FAIL-dividers.json`, await page.locator('.th-divider').evaluateAll(es => es.map(e => ({ min: e.ariaValueMin, max: e.ariaValueMax, now: e.ariaValueNow, parent: e.parentElement.dataset.splitId, rect: e.getBoundingClientRect().toJSON() }))));
      await page.screenshot({ path: resolve(evidence, `${layout}-FAIL.png`) });
    } finally {
      await save(`${layout}-trace.json`, await page.evaluate(() => window.qaTrace ?? []));
      cleanup.push(await q.close()); await save('results.json', results);
    }
  }
} finally { await browser.close(); cleanup.push({ browserClosed: !browser.isConnected() }); await save('cleanup.json', cleanup); }
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.pass)) process.exitCode = 1;
