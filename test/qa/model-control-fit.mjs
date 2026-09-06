import assert from 'node:assert/strict';
import { models } from './pane-workspace-ui.mjs';

/** Passive v4 resize must preserve reasoning focus independently of the catalog. */
export async function focusedFitScenarios(q) {
  for (const catalog of ['full', 'empty']) {
    const scenario = `focused-fit-${catalog}-v4-900-to-700`;
    await q.scenario(scenario, async () => {
      // Given authoritative high in the taller v4 pane.
      const page = await q.reset({ layout: 'v4' }, { width: 1440, height: 900 });
      await page.evaluate(() => window.qaSignal(() =>
        document.querySelector('[data-pane-id="a"] .th-model-picker-label')?.textContent === 'Model A'
        && document.querySelector('[data-pane-id="a"] .th-model-picker-thinking')?.textContent === 'low'));
      const baseline = q.fixture.frames.length;
      await page.evaluate(empty => {
        window.qaFitSeed = window.qaSignal(() =>
          document.querySelector('[data-pane-id="a"] .th-model-picker-thinking')?.textContent === 'high'
          && document.querySelector('[data-pane-id="a"] .th-model-picker-label')?.textContent
            === (empty ? 'provider-a/model-a' : 'Model A'));
      }, catalog === 'empty');
      if (catalog === 'empty') q.fixture.deliver('stored-a', { type: 'models', models: [] });
      q.fixture.deliver('stored-a', { type: 'state', model: models[0],
        thinkingLevel: 'high', isStreaming: false, isCompacting: false });
      await page.evaluate(() => window.qaFitSeed);
      await page.mouse.move(0, 0);
      const trigger = page.locator('[data-pane-id="a"] .th-model-picker-btn');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.evaluate(() => window.qaSignal(() =>
        !!document.querySelector('[data-pane-id="a"] .th-model-picker-popover')?.style.maxHeight));
      for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), level);
      }
      await page.evaluate(() => { window.qaFitFocus = document.activeElement; });
      const measure = () => page.evaluate(() => {
        const pane = document.querySelector('[data-pane-id="a"]');
        const popup = pane.querySelector('.th-model-picker-popover');
        const high = [...popup.querySelectorAll('.th-thinking-level')]
          .find(element => element.textContent === 'high');
        const ancestors = [];
        for (let element = popup.parentElement; element; element = element.parentElement) {
          ancestors.push([element.className, element.scrollTop, element.scrollLeft]);
        }
        return { popup: popup.getBoundingClientRect().toJSON(),
          high: high.getBoundingClientRect().toJSON(), scrollTop: popup.scrollTop,
          sameFocus: document.activeElement === window.qaFitFocus,
          focused: document.activeElement === high,
          catalogSize: popup.querySelectorAll('[role="option"]').length,
          ancestors, maxHeight: popup.style.maxHeight };
      });
      const before = await measure();
      assert.equal(before.catalogSize, catalog === 'empty' ? 0 : 53);
      assert(before.focused && before.sameFocus);
      assert(before.high.top >= before.popup.top - .5 && before.high.bottom <= before.popup.bottom + .5,
        'Focused high is fully visible before resizing');
      await q.shot(`model-${scenario}-before.png`, { scenario, state: 'focused-high-before-fit' });
      await page.evaluate(() => {
        const popup = document.querySelector('[data-pane-id="a"] .th-model-picker-popover');
        const initial = popup.style.maxHeight;
        window.qaFitChanged = new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (popup.style.maxHeight === initial) return;
            observer.disconnect(); clearTimeout(timer); resolve(true);
          });
          const timer = setTimeout(() => {
            observer.disconnect(); reject(new Error('Popup fit change deadline'));
          }, 8000);
          observer.observe(popup, { attributes: true, attributeFilter: ['style'] });
        });
      });

      // When the actual viewport tightens, await the popup's committed fit change.
      await page.setViewportSize({ width: 1440, height: 700 });
      await page.evaluate(() => window.qaFitChanged);
      const after = await measure();
      const sets = q.fixture.frames.slice(baseline).filter(frame => frame.type === 'chat.set');
      const receipt = { catalog, before, after, sets };
      await q.save(`model-${scenario}.json`, receipt);
      await q.shot(`model-${scenario}-after.png`, { scenario, state: 'focused-high-after-fit' });

      // Then high is still wholly visible without selection or ancestor scrolling.
      assert(after.popup.height < before.popup.height);
      assert(after.focused && after.sameFocus);
      assert.equal(after.catalogSize, before.catalogSize);
      assert(after.high.top >= after.popup.top - .5 && after.high.bottom <= after.popup.bottom + .5,
        'Focused reasoning remains completely visible after passive fit, including an empty catalog');
      assert.deepEqual(after.ancestors, before.ancestors);
      assert.deepEqual(sets, []);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-pane-id="a"] .th-model-picker-popover').count(), 0);
      assert(await trigger.evaluate(element => document.activeElement === element));
      return receipt;
    });
  }
}
