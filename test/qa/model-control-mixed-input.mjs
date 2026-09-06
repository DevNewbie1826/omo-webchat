import assert from 'node:assert/strict';
import { models } from './pane-workspace-ui.mjs';

/** Native keyboard reasoning -> wheel -> raw model hover/click in the actual App. */
export async function mixedInputScenario(q) {
  const { fixture } = q;
  const page = await q.reset({ layout: 'v4' }, { width: 1440, height: 700 });
  const scenario = 'mixed-input-v4-700';
  const shot = state => q.shot(`model-${scenario}-${state}.png`, { scenario, state });
  await page.evaluate(() => window.qaSignal(() =>
    document.querySelector('[data-pane-id="a"] .th-model-picker-label')?.textContent === 'Model A'
    && document.querySelectorAll('[data-pane-id="a"] .th-model-picker-btn').length === 1));
  const baseline = fixture.frames.length;
  await page.evaluate(() => {
    window.qaMixedState = window.qaSignal(() =>
      document.querySelector('[data-pane-id="a"] .th-model-picker-thinking')?.textContent === 'high');
  });
  fixture.deliver('stored-a', { type: 'state', model: models[0], thinkingLevel: 'high',
    isStreaming: false, isCompacting: false });
  await page.evaluate(() => window.qaMixedState);
  await page.mouse.move(0, 0);
  const trigger = page.locator('[data-pane-id="a"] .th-model-picker-btn');
  await trigger.focus();
  await page.evaluate(() => {
    window.qaMixedOpen = window.qaSignal(() =>
      !!document.querySelector('[data-pane-id="a"] .th-model-picker-popover'));
  });
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.qaMixedOpen);
  for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), level);
  }
  await page.evaluate(() => { window.qaMixedFocus = document.activeElement; });

  const measure = () => page.evaluate(() => {
    const pane = document.querySelector('[data-pane-id="a"]');
    const composer = pane.querySelector('.th-chat-input');
    const popup = pane.querySelector('.th-model-picker-popover');
    const target = popup?.querySelector('[role="option"]:last-child');
    const rect = target?.getBoundingClientRect();
    const bounds = popup?.getBoundingClientRect();
    const column = pane.querySelector('.th-chat-main').getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const ancestors = [];
    for (let e = composer.parentElement; e; e = e.parentElement) {
      ancestors.push({ className: e.className, rect: e.getBoundingClientRect().toJSON(),
        scrollTop: e.scrollTop, scrollLeft: e.scrollLeft });
    }
    return {
      composer: composer.getBoundingClientRect().toJSON(),
      capsule: pane.querySelector('.th-chat-input-inner').getBoundingClientRect().toJSON(),
      textarea: composer.querySelector('textarea').getBoundingClientRect().toJSON(),
      trigger: pane.querySelector('.th-model-picker-btn').getBoundingClientRect().toJSON(),
      popup: bounds?.toJSON() ?? null,
      scrollTop: popup?.scrollTop ?? null,
      sameFocus: document.activeElement === window.qaMixedFocus,
      focusedLevel: document.activeElement?.textContent,
      ancestors,
      target: target ? {
        rect: rect.toJSON(), active: target.dataset.active === 'true',
        hit: target === hit || target.contains(hit),
        complete: rect.top >= Math.max(bounds.top + popup.clientTop, column.top)
          && rect.bottom <= Math.min(bounds.top + popup.clientTop + popup.clientHeight, column.bottom),
      } : null,
    };
  });

  // Given native keyboard focus still on high, use the popup gutter for wheel input.
  const focused = await measure();
  assert(focused.sameFocus && focused.focusedLevel === 'high');
  await shot('keyboard-high');
  await page.mouse.move(focused.popup.x + 2, focused.popup.y + focused.popup.height / 2);
  await page.evaluate(() => {
    const popup = document.querySelector('[data-pane-id="a"] .th-model-picker-popover');
    window.qaMixedScroll = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        popup.removeEventListener('scrollend', done);
        reject(new Error('Mixed-input wheel completion deadline'));
      }, 8000);
      function done() {
        clearTimeout(timer);
        popup.removeEventListener('scrollend', done);
        resolve(true);
      }
      popup.addEventListener('scrollend', done);
    });
  });
  await page.mouse.wheel(0, 10000);
  await page.evaluate(() => window.qaMixedScroll);
  const bottom = await measure();
  assert(bottom.sameFocus && bottom.focusedLevel === 'high');
  assert(bottom.target.complete && bottom.target.hit, 'Final model is fully pointer-reachable before hover');
  assert.equal(bottom.target.active, false, 'Hover must change the active model key');
  const point = { x: bottom.target.rect.x + bottom.target.rect.width / 2,
    y: bottom.target.rect.y + bottom.target.rect.height / 2 };
  await shot('before-hover');

  // When raw pointer movement activates the model, await its committed active state.
  // The picker reconciles reveal geometry in the same commit's layout effect.
  await page.evaluate(() => {
    window.qaMixedHover = window.qaSignal(() =>
      document.querySelector('[data-pane-id="a"] [role="option"]:last-child')?.dataset.active === 'true');
  });
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => window.qaMixedHover);
  await shot('after-hover');
  const hovered = await measure();
  const targetAtPoint = await page.evaluate(point => {
    const target = document.elementFromPoint(point.x, point.y)?.closest('button');
    return target && { role: target.getAttribute('role'), className: target.className, text: target.textContent };
  }, point);

  // Subscribe to any control outcome so a wrong reasoning request is retained on RED.
  await page.evaluate(() => {
    window.qaMixedResult = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('qa:wire', done);
        reject(new Error('Mixed-input control completion deadline'));
      }, 8000);
      function done(event) {
        const frame = event.detail;
        if (frame.sessionId !== 'stored-a' || !frame.requestId
          || !['control.result', 'error'].includes(frame.type)) return;
        clearTimeout(timer);
        window.removeEventListener('qa:wire', done);
        resolve(frame);
      }
      window.addEventListener('qa:wire', done);
    });
  });
  const requested = fixture.wait('frame', frame => frame.type === 'chat.set' && frame.sessionId === 'stored-a');
  await page.mouse.click(point.x, point.y);
  const [request, result] = await Promise.all([
    requested, page.evaluate(() => window.qaMixedResult),
  ]);
  await shot('after-click');
  const after = await measure();
  const sets = fixture.frames.slice(baseline).filter(frame => frame.type === 'chat.set');
  const intended = { provider: 'long-provider', modelId: 'long-49' };
  const receipt = { focused, bottom, hovered, after, point, targetAtPoint, intended, request, result, sets };
  await q.save('model-mixed-input-v4-700.json', receipt);

  // Then the saved model center selects exactly that model, never reasoning.
  assert.deepEqual(sets, [{
    type: 'chat.set', sessionId: 'stored-a', requestId: result.requestId, model: intended,
  }]);
  assert.equal(sets.filter(frame => Object.hasOwn(frame, 'thinkingLevel')).length, 0);
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.command, 'set_model');
  assert.equal(result.success, true);
  assert(hovered.sameFocus && hovered.focusedLevel === 'high', 'Hover retains the original reasoning focus');
  assert(hovered.target.complete && hovered.target.hit, 'Hover cannot displace the intended model');
  assert.equal(hovered.scrollTop, bottom.scrollTop);
  assert.deepEqual(hovered.popup, bottom.popup);
  for (const state of [bottom, hovered, after]) {
    assert.deepEqual(state.composer, focused.composer);
    assert.deepEqual(state.capsule, focused.capsule);
    assert.deepEqual(state.textarea, focused.textarea);
    assert.deepEqual(state.ancestors, focused.ancestors);
    assert.deepEqual([state.trigger.top, state.trigger.right, state.trigger.bottom],
      [focused.trigger.top, focused.trigger.right, focused.trigger.bottom]);
  }
  assert.equal(after.popup, null);
  assert(await trigger.evaluate(e => document.activeElement === e));
  return receipt;
}
