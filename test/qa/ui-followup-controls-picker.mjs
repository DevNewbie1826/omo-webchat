import assert from 'node:assert/strict';
import { models } from './pane-workspace-ui.mjs';
import { transition } from './ui-composer-fixture.mjs';

export function ancestorGeometry() {
  return [...document.querySelectorAll('.th-chat-main,.th-chat-scrollport,.th-chat-body,.th-chat-pane')].map(el => ({
    selector: el.className, top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, extent: el.scrollHeight,
  }));
}
export async function pickerRegression(page, fixture, shot) {
  await transition(page, () => document.querySelector('.th-model-picker-label')?.textContent?.startsWith('Long model 49'), async () =>
    fixture.deliver('stored-a', { type: 'state', model: models.at(-1), thinkingLevel: 'max', isStreaming: false, isCompacting: false }));
  const before = await page.evaluate(ancestorGeometry);
  assert(before.some(r => r.selector.includes('th-chat-body') && r.extent > r.height), 'Real transcript must scroll');
  await transition(page, () => !!document.querySelector('.th-model-picker-popover'), () => page.locator('.th-model-picker-btn').click());
  const reveal = await page.locator('.th-model-picker-list').evaluate(list => {
    const option = list.querySelector('[aria-selected="true"]'), r = option.getBoundingClientRect(), b = list.getBoundingClientRect();
    return { listScroll: list.scrollTop, popupScroll: list.parentElement.scrollTop, complete: r.top >= b.top && r.bottom <= b.bottom + 1 };
  });
  const after = await page.evaluate(ancestorGeometry);
  assert(reveal.listScroll > 0 && reveal.popupScroll === 0 && reveal.complete);
  assert.deepEqual(after, before); await shot('initial-offscreen-current');
  const search = page.locator('.th-model-picker-search'); await search.fill('provider-b');
  const viewport = page.viewportSize();
  await transition(page, () => !!document.querySelector('.th-model-picker-popover--dense'), () => page.setViewportSize({ width: 1440, height: 150 }));
  const states = [];
  for (const catalog of [[], models]) {
    await transition(page, `() => document.querySelectorAll('.th-model-picker-list [role="option"]').length === ${catalog.length ? 1 : 0}`, async () => fixture.deliver('stored-a', { type: 'models', models: catalog }));
    const state = { query: await search.inputValue(), focus: await search.evaluate(el => el === document.activeElement), options: await page.locator('.th-model-picker-list [role="option"]').count() };
    assert.equal(state.query, 'provider-b'); assert.equal(state.focus, true); states.push(state);
  }
  await shot('query-dense-hydrated');
  await page.keyboard.press('Escape');
  assert(await page.locator('.th-model-picker-btn').evaluate(el => el === document.activeElement));
  await page.setViewportSize(viewport);
  return { before, after, reveal, states };
}
