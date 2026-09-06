import assert from 'node:assert/strict';
import { layouts, leaf, models } from './pane-workspace-ui.mjs';
import { mixedInputScenario } from './model-control-mixed-input.mjs';
/** Desktop popup owns scrolling. Use real wheel, clipping bounds and raw pointer selection. */
export async function shortMenuScenarios(q) {
  const { fixture } = q;
  const mixed = { kind: 'split', id: 'root', dir: 'h', ratio: .5,
    first: { ...layouts.v3, id: 'left-v3' }, second: leaf('right') };
  for (const [name, layout, width, height] of [
    ['normal53-model', layouts.single, 1440, 900],
    ['v3-900', layouts.v3, 1440, 900], ['v3-700', layouts.v3, 1440, 700],
    ['v4-900', layouts.v4, 1440, 900], ['v4-700', layouts.v4, 1440, 700],
    ['mixed-900', mixed, 1900, 900], ['mixed-700', mixed, 1900, 700],
  ]) {
    await q.scenario(`bounded-open-menu-${name}`, async () => {
    const page = await q.reset({ layout }, { width, height });
    await page.evaluate(() => window.qaSignal(() =>
      document.querySelector('[data-pane-id="a"] .th-model-picker-label')?.textContent === 'Model A'
      && document.querySelector('[data-pane-id="a"] .th-model-picker-thinking')?.textContent === 'low'));
    const trigger = page.locator('[data-pane-id="a"] .th-model-picker-btn');
    const armControl = command => page.evaluate(command => {
      window.controlDone = new Promise((done, fail) => {
        const timer = setTimeout(() => { window.removeEventListener('qa:wire', listener); fail(new Error('Control completion deadline: ' + command)); }, 8000);
        function listener(event) { if (event.detail.type === 'control.result' && event.detail.command === command) {
          clearTimeout(timer); window.removeEventListener('qa:wire', listener); done(event.detail);
        } }
        window.addEventListener('qa:wire', listener);
      });
    }, command);
    const controlDone = () => page.evaluate(() => window.controlDone);
    const measure = () => page.evaluate(() => {
      const pane = document.querySelector('[data-pane-id="a"]');
      const box = selector => pane.querySelector(selector)?.getBoundingClientRect().toJSON();
      const popup = pane.querySelector('.th-model-picker-popover');
      const column = pane.querySelector('.th-chat-main').getBoundingClientRect();
      const bounds = popup?.getBoundingClientRect();
      const clips = [];
      for (let e = popup?.parentElement; e; e = e.parentElement) {
        const css = getComputedStyle(e);
        if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) clips.push({ className: e.className, rect: e.getBoundingClientRect().toJSON() });
      }
      const rows = popup ? [...popup.querySelectorAll('[role="option"]')].map(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { text: element.textContent, rect: rect.toJSON(),
          complete: rect.top >= Math.max(bounds.top + popup.clientTop, column.top, ...clips.map(clip => clip.rect.top)) - .5
            && rect.bottom <= Math.min(bounds.top + popup.clientTop + popup.clientHeight, column.bottom, ...clips.map(clip => clip.rect.bottom)) + .5,
          hit: element === hit || element.contains(hit) };
      }) : [];
      const ancestors = [];
      for (let e = pane.querySelector('.th-model-picker-btn'); e; e = e.parentElement)
        ancestors.push([e.className, e.scrollTop, e.scrollLeft]);
      return { pane: pane.getBoundingClientRect().toJSON(), column: column.toJSON(),
        composer: box('.th-chat-input'), trigger: box('.th-model-picker-btn'),
        popup: bounds?.toJSON(), maxHeight: popup && getComputedStyle(popup).maxHeight,
        popupScrollTop: popup?.scrollTop, popupClientHeight: popup?.clientHeight,
        reasoning: popup && [...popup.querySelectorAll('.th-thinking-level')].map(e => ({
          level: e.textContent, focused: e === document.activeElement, rect: e.getBoundingClientRect().toJSON() })),
        rows, ancestors, clips, documentWidth: document.documentElement.scrollWidth };
    });
    if (name === 'v4-700') {
      // Given authoritative high with an empty catalog, reached by native keys.
      const baseline = fixture.frames.length;
      await page.evaluate(() => { window.qaEmpty = window.qaSignal(() =>
        document.querySelector('.th-model-picker-label')?.textContent === 'provider-a/model-a'
        && document.querySelector('.th-model-picker-thinking')?.textContent === 'high'); });
      fixture.deliver('stored-a', { type: 'models', models: [] });
      fixture.deliver('stored-a', { type: 'state', model: models[0], thinkingLevel: 'high', isStreaming: false, isCompacting: false });
      await page.evaluate(() => window.qaEmpty);
      await trigger.focus(); await page.keyboard.press('Enter');
      for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), level);
      }
      const empty = await measure(), initialHigh = empty.reasoning.find(e => e.level === 'high');
      assert(initialHigh.focused && initialHigh.rect.top >= empty.popup.top && initialHigh.rect.bottom <= empty.popup.bottom);
      await q.shot('model-v4-700-before-hydration.png', { scenario: 'short-catalog-hydration', state: 'empty-focused-high' });
      // Subscribe to catalog, layout and scroll completion before delivery.
      await page.evaluate(() => {
        const popup = document.querySelector('.th-model-picker-popover'), list = popup.querySelector('.th-model-picker-list');
        const focused = document.activeElement, initialScroll = popup.scrollTop;
        window.qaHydration = new Promise((resolve, reject) => {
          let catalogReady = false, layoutReady = false, settledScroll = initialScroll, frame = 0;
          const mutations = new MutationObserver(() => { catalogReady = list.children.length === 53; finish(); });
          const layout = new ResizeObserver(() => { layoutReady = list.children.length === 53; finish(); });
          function cleanup() {
            clearTimeout(timer); cancelAnimationFrame(frame); mutations.disconnect(); layout.disconnect();
            popup.removeEventListener('scrollend', scrolled);
          }
          function finish() {
            if (!catalogReady || !layoutReady) return;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              if (popup.scrollTop !== initialScroll && popup.scrollTop !== settledScroll) return;
              cleanup(); resolve(document.activeElement === focused);
            });
          }
          function scrolled() { settledScroll = popup.scrollTop; finish(); }
          const timer = setTimeout(() => { cleanup(); reject(new Error('Catalog layout/scroll completion deadline')); }, 8000);
          mutations.observe(list, { childList: true }); layout.observe(list);
          popup.addEventListener('scrollend', scrolled);
        });
      });
      // When the complete catalog arrives, without any explicit selection.
      fixture.deliver('stored-a', { type: 'models', models });
      const sameFocus = await page.evaluate(() => window.qaHydration);
      const hydrated = await measure(), high = hydrated.reasoning.find(e => e.level === 'high');
      const sets = fixture.frames.slice(baseline).filter(frame => frame.type === 'chat.set');
      await q.save('model-v4-700-hydration.json', { empty, hydrated, sameFocus, sets });
      await q.shot('model-v4-700-after-hydration.png', { scenario: 'short-catalog-hydration', state: 'hydrated-focused-high' });
      // Then the focused reasoning control remains completely visible.
      assert(sameFocus && high.focused, 'Catalog arrival preserves the same reasoning focus');
      assert(high.rect.top >= hydrated.popup.top && high.rect.bottom <= hydrated.popup.bottom,
        'Catalog arrival must keep the focused reasoning control visible');
      assert.equal(hydrated.rows.length, 53); assert.deepEqual(sets, []);
      assert.deepEqual(hydrated.ancestors, empty.ancestors); assert.deepEqual(hydrated.composer, empty.composer);
      assert.deepEqual([hydrated.trigger.top, hydrated.trigger.right, hydrated.trigger.bottom],
        [empty.trigger.top, empty.trigger.right, empty.trigger.bottom]);
      assert.deepEqual(hydrated.popup, empty.popup);
      await page.keyboard.press('Escape');
      assert(await trigger.evaluate(e => document.activeElement === e));
    }
    const before = await measure();
    await trigger.click();
    await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-model-picker-popover')?.style.maxHeight));
    const open = await measure();
    assert(open.popup.height <= Math.min(280, height / 2), `${name}: upper cap`);
    assert(open.popup.top >= open.column.top, `${name}: actual column clip`);
    assert(open.clips.every(clip => open.popup.top >= clip.rect.top - .5 && open.popup.bottom <= clip.rect.bottom + .5), 'popup respects every clipping ancestor');
    assert(open.popup.bottom <= open.trigger.top, `${name}: upward anchor`);
    assert(open.rows.some(row => row.complete && row.hit), `${name}: complete row on open`);
    assert.equal(open.rows.length, 53);
    const shot = suffix => q.shot(`model-${name}-${suffix}.png`,
      { scenario: `bounded-open-menu-${name}`, state: suffix });
    await shot('OPEN');

    async function wheel(delta) {
      await page.evaluate(() => {
        const popup = document.querySelector('.th-model-picker-popover');
        window.scrolled = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { popup.removeEventListener('scrollend', done); reject(new Error('menu scrollend deadline')); }, 8000);
          function done() { clearTimeout(timer); popup.removeEventListener('scrollend', done); resolve(true); }
          popup.addEventListener('scrollend', done);
        });
      });
      await page.mouse.wheel(0, delta);
      await page.evaluate(() => window.scrolled);
    }
    await page.mouse.move(open.popup.x + open.popup.width / 2, open.popup.y + open.popup.height / 2);
    await wheel(10000);
    const bottom = await measure();
    assert(bottom.rows.some(row => row.complete && row.hit), `${name}: complete row after wheel`);
    assert.deepEqual(bottom.ancestors, before.ancestors, `${name}: no ancestor scroll`);
    assert.deepEqual(bottom.composer, before.composer, `${name}: composer stable`);
    assert.deepEqual(bottom.trigger, before.trigger, `${name}: trigger stable`);
    assert.equal(bottom.documentWidth, width);
    await shot('SCROLLED');
    // Raw pointer coordinates: no locator auto-scroll or scrollIntoView fallback.
    const last = bottom.rows.at(-1);
    assert(last.complete && last.hit, `${name}: last option pointer reachable`);
    const selected = fixture.wait('frame', frame => frame.type === 'chat.set' && frame.model);
    await armControl('set_model');
    await page.mouse.click(last.rect.x + last.rect.width / 2, last.rect.y + last.rect.height / 2);
    const selection = await selected; await controlDone();
    assert.deepEqual(selection.model, { provider: 'long-provider', modelId: 'long-49' });

    // Every thinking button and search can be exposed with ordinary wheel
    // input and clicked even in v4/700, not by scrolling a hidden ancestor.
    await trigger.click();
    const controlRects = await page.evaluate(() => [...document.querySelectorAll('.th-model-picker-search, .th-thinking-level')].map(e => e.className));
    for (let index = 0; index < controlRects.length; index++) {
      const popupBox = await page.locator('.th-model-picker-popover').boundingBox();
      await page.mouse.move(popupBox.x + 2, popupBox.y + popupBox.height / 2);
      const delta = await page.evaluate(index => {
        const e = document.querySelectorAll('.th-model-picker-search, .th-thinking-level')[index];
        const rect = e.getBoundingClientRect(), popup = document.querySelector('.th-model-picker-popover').getBoundingClientRect();
        if (rect.top >= popup.top + 1 && rect.bottom <= popup.bottom - 1) return 0;
        return rect.y + rect.height / 2 - popup.y - popup.height / 2;
      }, index);
      if (Math.abs(delta) > 1) await wheel(delta);
      const control = await page.evaluate(index => {
        const e = document.querySelectorAll('.th-model-picker-search, .th-thinking-level')[index];
        const rect = e.getBoundingClientRect(), popup = document.querySelector('.th-model-picker-popover').getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { rect: rect.toJSON(), popup: popup.toJSON(), hit: e === hit || e.contains(hit), text: e.textContent, thinking: e.classList.contains('th-thinking-level') };
      }, index);
      assert(control.hit && control.rect.top >= control.popup.top && control.rect.bottom <= control.popup.bottom,
        `${name}: complete pointer control ${index}`);
      const changed = control.thinking ? fixture.wait('frame', frame => frame.type === 'chat.set' && frame.thinkingLevel === control.text) : null;
      if (changed) await armControl('set_thinking_level');
      await page.mouse.click(control.rect.x + control.rect.width / 2, control.rect.y + control.rect.height / 2);
      if (changed) { await changed; await controlDone(); }
    }
    const controls = await measure();
    assert.deepEqual(controls.ancestors, before.ancestors, `${name}: control clicks preserve ancestors`);
    assert.deepEqual(controls.composer, before.composer);
    await page.keyboard.press('Escape');

    // Start at the trigger; opening focuses the non-text popup container.
    // All internal traversal and Enter activation use native keyboard input.
    await trigger.focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('.th-model-picker-popover').evaluate(e => document.activeElement === e));
    const keyboardStart = fixture.frames.length;
    for (const expected of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), expected);
    }
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'high');
    await shot('KEYBOARD-high');
    const high = fixture.wait('frame', frame => frame.type === 'chat.set' && frame.thinkingLevel === 'high');
    await armControl('set_thinking_level');
    await page.keyboard.press('Enter'); await high; await controlDone();
    const keyboardRequests = fixture.frames.slice(keyboardStart).filter(frame => frame.type === 'chat.set');
    assert.equal(keyboardRequests.length, 1);
    assert.equal(keyboardRequests[0].thinkingLevel, 'high');
    await page.keyboard.press('Escape');
    assert(await trigger.evaluate(e => document.activeElement === e));
    await page.keyboard.press('Enter');
    assert(await page.locator('.th-model-picker-popover').evaluate(e => document.activeElement === e));
    for (const expected of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), expected);
    }
    await page.keyboard.press('Tab');
    assert(await page.locator('.th-model-picker-search').evaluate(e => document.activeElement === e));
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.th-model-picker-popover').count(), 0);
    assert(await page.locator('.th-chat-attach-btn').evaluate(e => e === document.activeElement));
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.th-model-picker-popover').count(), 0);
    assert(await trigger.evaluate(e => document.activeElement === e));
    await page.keyboard.press('Enter');
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    assert(await page.locator('.th-model-picker-search').evaluate(e => document.activeElement === e));
    await page.keyboard.type('provider-b');
    await page.keyboard.press('ArrowDown');
    const exactModel = fixture.wait('frame', frame => frame.type === 'chat.set' && frame.model);
    await armControl('set_model');
    await page.keyboard.press('Enter');
    const searched = await exactModel; await controlDone();
    assert.deepEqual(searched.model, { provider: 'provider-b', modelId: 'model-b' });
    assert(await trigger.evaluate(e => document.activeElement === e));
    const receipt = { name, before, open, bottom, selection, searched, forwardExit: 'attachment', reverseExit: 'trigger',
      pointerControls: controlRects.length, keyboardRequests };
    await q.save(`model-${name}.json`, receipt);
    return receipt;
    });
  }
  await q.scenario('mixed-input-v4-700', () => mixedInputScenario(q));
}
