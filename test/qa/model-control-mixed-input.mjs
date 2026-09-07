import assert from 'node:assert/strict';
import { models } from './pane-workspace-ui.mjs';
import { wheel } from './design-workbench-fixture.mjs';
import { transition } from './ui-composer-fixture.mjs';

/** Native keyboard reasoning -> list wheel -> raw model hover/click in the SPA. */
export async function mixedInputScenario(q) {
  const { fixture } = q;
  const page = await q.reset({ layout: 'v4' }, { width: 1440, height: 700 });
  const scenario = 'mixed-input-v4-700';
  const shot = state => q.shot(`model-${scenario}-${state}.png`, { scenario, state });
  await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-model-picker-thinking')?.textContent === 'low'));
  const baseline = fixture.frames.length;
  await transition(page, () => document.querySelector('.th-model-picker-thinking')?.textContent === 'high', async () => {
    fixture.deliver('stored-a', { type: 'state', model: models[0], thinkingLevel: 'high', isStreaming: false, isCompacting: false });
  });
  const trigger = page.locator('[data-pane-id="a"] .th-model-picker-btn');
  await trigger.focus();
  await transition(page, () => !!document.querySelector('.th-model-picker-popover--panel'), () => page.keyboard.press('Enter'));
  await page.keyboard.press('Tab'); // Panel close precedes reasoning.
  for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.textContent), level);
  }
  await page.evaluate(() => { window.qaMixedFocus = document.activeElement; });
  const measure = () => page.evaluate(() => {
    const popup = document.querySelector('.th-model-picker-popover'), list = popup?.querySelector('.th-model-picker-list');
    const target = list?.querySelector('[role="option"]:last-child'), rect = target?.getBoundingClientRect(), bounds = list?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const pane = document.querySelector('[data-pane-id="a"]');
    return { popup: popup?.getBoundingClientRect().toJSON() ?? null, popupScroll: popup?.scrollTop ?? null,
      scrollTop: list?.scrollTop ?? null, sameFocus: document.activeElement === window.qaMixedFocus,
      focusedLevel: document.activeElement?.textContent,
      chrome: popup && [...popup.children].filter(e => e !== list).map(e => e.getBoundingClientRect().toJSON()),
      composer: pane.querySelector('.th-chat-input').getBoundingClientRect().toJSON(),
      trigger: pane.querySelector('.th-model-picker-btn').getBoundingClientRect().toJSON(),
      ancestors: [...pane.querySelectorAll('.th-chat-main,.th-chat-scrollport')].map(e => [e.scrollTop, e.scrollLeft]),
      target: target ? { rect: rect.toJSON(), active: target.dataset.active === 'true', hit: target === hit || target.contains(hit),
        complete: rect.top >= bounds.top && rect.bottom <= bounds.bottom } : null };
  });
  const focused = await measure(); assert(focused.sameFocus && focused.focusedLevel === 'high'); await shot('keyboard-high');
  await wheel(page, page.locator('.th-model-picker-list'), 10000, true);
  const bottom = await measure();
  assert(bottom.sameFocus && bottom.target.complete && bottom.target.hit); assert.equal(bottom.target.active, false);
  assert.equal(bottom.popupScroll, 0); assert.deepEqual(bottom.chrome, focused.chrome); await shot('before-hover');
  const point = { x: bottom.target.rect.x + bottom.target.rect.width / 2, y: bottom.target.rect.y + bottom.target.rect.height / 2 };
  await transition(page, () => document.querySelector('.th-model-picker-list [role="option"]:last-child')?.dataset.active === 'true',
    () => page.mouse.move(point.x, point.y));
  const hovered = await measure(); await shot('after-hover');
  assert(hovered.sameFocus && hovered.target.complete && hovered.target.hit);
  assert.equal(hovered.scrollTop, bottom.scrollTop); assert.deepEqual(hovered.chrome, focused.chrome);
  const requested = fixture.wait('frame', f => f.type === 'chat.set' && f.sessionId === 'stored-a');
  await transition(page, () => !document.querySelector('.th-model-picker-popover'), () => page.mouse.click(point.x, point.y));
  const request = await requested, after = await measure(); await shot('after-click');
  const intended = { provider: 'long-provider', modelId: 'long-49' };
  const sets = fixture.frames.slice(baseline).filter(f => f.type === 'chat.set');
  assert.deepEqual(sets, [{ type: 'chat.set', sessionId: 'stored-a', requestId: request.requestId, model: intended }]);
  for (const state of [bottom, hovered, after]) {
    assert.deepEqual(state.composer, focused.composer); assert.deepEqual(state.ancestors, focused.ancestors);
    assert.deepEqual([state.trigger.top, state.trigger.right, state.trigger.bottom], [focused.trigger.top, focused.trigger.right, focused.trigger.bottom]);
  }
  assert.equal(after.popup, null); assert(await trigger.evaluate(e => e === document.activeElement));
  const receipt = { focused, bottom, hovered, after, point, intended, request, sets };
  await q.save('model-mixed-input-v4-700.json', receipt); return receipt;
}
