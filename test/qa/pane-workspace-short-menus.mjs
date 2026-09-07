import assert from 'node:assert/strict';
import { layouts, leaf, models } from './pane-workspace-ui.mjs';
import { mixedInputScenario } from './model-control-mixed-input.mjs';
import { focusedFitScenarios } from './model-control-fit.mjs';
import { wheel } from './design-workbench-fixture.mjs';
import { transition } from './ui-composer-fixture.mjs';

/** Fixed desktop chrome with list-owned wheel/reveal, including short local panes. */
export async function shortMenuScenarios(q) {
  const { fixture } = q;
  const mixed = { kind: 'split', id: 'root', dir: 'h', ratio: .5, first: { ...layouts.v3, id: 'left-v3' }, second: leaf('right') };
  for (const [name, layout, width, height] of [
    ['normal53-model', layouts.single, 1440, 900], ['v3-900', layouts.v3, 1440, 900], ['v3-700', layouts.v3, 1440, 700],
    ['v4-900', layouts.v4, 1440, 900], ['v4-700', layouts.v4, 1440, 700],
    ['mixed-900', mixed, 1900, 900], ['mixed-700', mixed, 1900, 700],
  ]) {
    await q.scenario(`bounded-open-menu-${name}`, async () => {
      const page = await q.reset({ layout }, { width, height });
      await page.evaluate(() => window.qaSignal(() => document.querySelector('[data-pane-id="a"] .th-model-picker-thinking')?.textContent === 'low'));
      const trigger = page.locator('[data-pane-id="a"] .th-model-picker-btn');
      const shot = state => q.shot(`model-${name}-${state}.png`, { scenario: `bounded-open-menu-${name}`, state });
      const open = () => transition(page, () => !!document.querySelector('.th-model-picker-popover'), () => trigger.click());
      const measure = () => page.evaluate(() => {
        const pane = document.querySelector('[data-pane-id="a"]'), popup = document.querySelector('.th-model-picker-popover');
        const list = popup?.querySelector('.th-model-picker-list'), bounds = list?.getBoundingClientRect();
        return { popup: popup?.getBoundingClientRect().toJSON() ?? null, panel: popup?.classList.contains('th-model-picker-popover--panel'),
          popupScroll: popup?.scrollTop, listScroll: list?.scrollTop,
          chrome: popup && [...popup.children].filter(e => e !== list).map(e => e.getBoundingClientRect().toJSON()),
          column: pane.querySelector('.th-chat-main').getBoundingClientRect().toJSON(),
          composer: pane.querySelector('.th-chat-input').getBoundingClientRect().toJSON(),
          trigger: pane.querySelector('.th-model-picker-btn').getBoundingClientRect().toJSON(),
          ancestors: [...pane.querySelectorAll('.th-chat-main,.th-chat-scrollport')].map(e => [e.scrollTop, e.scrollLeft]),
          rows: list && [...list.children].map(e => { const r = e.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { rect: r.toJSON(), complete: r.top >= bounds.top && r.bottom <= bounds.bottom, hit: at === e || e.contains(at) }; }),
          documentWidth: document.documentElement.scrollWidth };
      });
      if (name === 'v4-700') {
        const baseline = fixture.frames.length;
        await transition(page, () => document.querySelector('.th-model-picker-thinking')?.textContent === 'high' && document.querySelector('.th-model-picker-label')?.textContent === 'provider-a/model-a', async () => {
          fixture.deliver('stored-a', { type: 'models', models: [] });
          fixture.deliver('stored-a', { type: 'state', model: models[0], thinkingLevel: 'high', isStreaming: false, isCompacting: false });
        });
        await open();
        const high = page.locator('.th-thinking-level').filter({ hasText: /^high$/ }); await high.focus();
        await page.evaluate(() => { window.qaHydrationFocus = document.activeElement; });
        await shot('before-hydration');
        await transition(page, () => document.querySelectorAll('.th-model-picker-list [role="option"]').length === 53,
          async () => fixture.deliver('stored-a', { type: 'models', models }));
        assert(await high.evaluate(e => e === document.activeElement && e === window.qaHydrationFocus));
        const box = await high.boundingBox(), popup = await page.locator('.th-model-picker-popover').boundingBox();
        assert(box.y >= popup.y && box.y + box.height <= popup.y + popup.height);
        assert.deepEqual(fixture.frames.slice(baseline).filter(f => f.type === 'chat.set'), []);
        await shot('after-hydration'); await page.keyboard.press('Escape');
      }
      const before = await measure(); await open(); const opened = await measure();
      assert.equal(opened.rows.length, 53); assert(opened.rows.some(r => r.complete && r.hit));
      assert(opened.popup.top >= 0 && opened.popup.bottom <= height);
      if (!opened.panel) {
        assert(opened.popup.height <= Math.min(280, height / 2));
        assert(opened.popup.top >= opened.column.top && opened.popup.bottom <= opened.trigger.top);
      } else assert.equal(await page.locator('.th-model-picker-popover').getAttribute('role'), 'dialog');
      await shot('OPEN');
      await wheel(page, page.locator('.th-model-picker-list'), 10000, true);
      const bottom = await measure(); assert(bottom.rows.at(-1).complete && bottom.rows.at(-1).hit);
      assert(bottom.listScroll > opened.listScroll); assert.equal(bottom.popupScroll, 0); assert.deepEqual(bottom.chrome, opened.chrome);
      assert.deepEqual(bottom.ancestors, before.ancestors); assert.deepEqual(bottom.composer, before.composer);
      assert.equal(bottom.documentWidth, width); await shot('SCROLLED');
      const last = bottom.rows.at(-1).rect, selection = fixture.wait('frame', f => f.type === 'chat.set' && !!f.model);
      await transition(page, () => !document.querySelector('.th-model-picker-popover'), () => page.mouse.click(last.x + last.width / 2, last.y + last.height / 2));
      const selected = await selection; assert.deepEqual(selected.model, { provider: 'long-provider', modelId: 'long-49' });
      await open();
      // All reasoning controls remain complete pointer targets, without scrolling chrome.
      for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        const button = page.locator('.th-thinking-level').filter({ hasText: new RegExp(`^${level}$`) });
        const r = await button.boundingBox(), p = await page.locator('.th-model-picker-popover').boundingBox();
        assert(r.y >= p.y && r.y + r.height <= p.y + p.height);
        const changed = fixture.wait('frame', f => f.type === 'chat.set' && f.thinkingLevel === level);
        await page.evaluate(() => {
          window.qaThinkingResult = new Promise((done, fail) => {
            const timer = setTimeout(() => { window.removeEventListener('qa:wire', received); fail(new Error('Thinking result deadline')); }, 8000);
            function received({ detail: frame }) {
              if (frame.type !== 'control.result' || frame.command !== 'set_thinking_level') return;
              clearTimeout(timer); window.removeEventListener('qa:wire', received); done(frame);
            }
            window.addEventListener('qa:wire', received);
          });
        });
        await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
        await Promise.all([changed, page.evaluate(() => window.qaThinkingResult)]);
        await page.evaluate(level => window.qaSignal(() => document.querySelector('.th-model-picker-thinking')?.textContent === level), level);
      }
      await page.keyboard.press('Escape'); assert(await trigger.evaluate(e => e === document.activeElement));
      await open(); const panel = await page.locator('.th-model-picker-popover--panel').count();
      if (panel) await page.keyboard.press('Tab');
      for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.textContent), level);
      }
      await page.keyboard.press('Tab'); assert(await page.locator('.th-model-picker-search').evaluate(e => e === document.activeElement));
      await page.keyboard.press('Tab');
      if (panel) {
        assert(await page.locator('.th-model-picker-current .th-btn-icon').evaluate(e => e === document.activeElement));
        await page.keyboard.press('Escape');
      } else {
        assert.equal(await page.locator('.th-model-picker-popover').count(), 0);
        assert(await page.locator('.th-chat-attach-btn').evaluate(e => e === document.activeElement));
      }
      await open(); await page.locator('.th-model-picker-search').fill('provider-b');
      const exactModel = fixture.wait('frame', f => f.type === 'chat.set' && !!f.model);
      await transition(page, () => !document.querySelector('.th-model-picker-popover'), () => page.keyboard.press('Enter'));
      const searched = await exactModel; assert.deepEqual(searched.model, { provider: 'provider-b', modelId: 'model-b' });
      assert(await trigger.evaluate(e => e === document.activeElement));
      const receipt = { name, before, opened, bottom, selected, searched, tabExit: panel ? 'panel-close' : 'attachment' };
      await q.save(`model-${name}.json`, receipt); return receipt;
    });
  }
  await q.scenario('mixed-input-v4-700', () => mixedInputScenario(q));
  await focusedFitScenarios(q);
}
