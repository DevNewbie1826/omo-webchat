import assert from 'node:assert/strict';
import { models } from './pane-workspace-ui.mjs';
import { transition } from './ui-composer-fixture.mjs';

/** Passive pane resize preserves fixed reasoning focus, even with no catalog. */
export async function focusedFitScenarios(q) {
  for (const catalog of ['full', 'empty']) {
    const scenario = `focused-fit-${catalog}-v4-900-to-700`;
    await q.scenario(scenario, async () => {
      const page = await q.reset({ layout: 'v4' }, { width: 1440, height: 900 });
      await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-model-picker-thinking')?.textContent === 'low'));
      const baseline = q.fixture.frames.length;
      await transition(page, () => document.querySelector('.th-model-picker-thinking')?.textContent === 'high', async () => {
        if (catalog === 'empty') q.fixture.deliver('stored-a', { type: 'models', models: [] });
        q.fixture.deliver('stored-a', { type: 'state', model: models[0], thinkingLevel: 'high', isStreaming: false, isCompacting: false });
      });
      const trigger = page.locator('[data-pane-id="a"] .th-model-picker-btn');
      await trigger.focus();
      await transition(page, () => !!document.querySelector('.th-model-picker-popover--panel'), () => page.keyboard.press('Enter'));
      await page.keyboard.press('Tab'); // Separate panel close control.
      for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
        await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.textContent), level);
      }
      await page.evaluate(() => { window.qaFitFocus = document.activeElement; });
      const measure = () => page.evaluate(() => {
        const popup = document.querySelector('.th-model-picker-popover');
        const high = [...popup.querySelectorAll('.th-thinking-level')].find(e => e.textContent === 'high');
        return { popup: popup.getBoundingClientRect().toJSON(), high: high.getBoundingClientRect().toJSON(),
          sameFocus: document.activeElement === window.qaFitFocus && document.activeElement === high,
          scrollTop: popup.scrollTop, catalogSize: popup.querySelectorAll('[role="option"]').length,
          ancestors: [...document.querySelectorAll('.th-chat-main,.th-chat-scrollport')].map(e => [e.scrollTop, e.scrollLeft]) };
      });
      const before = await measure();
      await q.shot(`model-${scenario}-before.png`, { scenario, state: 'focused-high-before-fit' });
      await transition(page, () => innerHeight === 700 && document.querySelector('[data-pane-id="a"]').getBoundingClientRect().height < 200,
        () => page.setViewportSize({ width: 1440, height: 700 }));
      const after = await measure(), sets = q.fixture.frames.slice(baseline).filter(f => f.type === 'chat.set');
      for (const state of [before, after]) {
        assert(state.sameFocus); assert.equal(state.scrollTop, 0);
        assert.equal(state.catalogSize, catalog === 'empty' ? 0 : 53);
        assert(state.high.top >= state.popup.top && state.high.bottom <= state.popup.bottom);
      }
      assert(after.popup.bottom <= 700); assert.deepEqual(after.ancestors, before.ancestors); assert.deepEqual(sets, []);
      await q.shot(`model-${scenario}-after.png`, { scenario, state: 'focused-high-after-fit' });
      const receipt = { catalog, before, after, sets }; await q.save(`model-${scenario}.json`, receipt);
      await page.keyboard.press('Escape'); assert(await trigger.evaluate(e => e === document.activeElement));
      return receipt;
    });
  }
}
