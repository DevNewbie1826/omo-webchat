import assert from 'node:assert/strict';
import { arm, complete, wheel, output } from './design-workbench-fixture.mjs';
import { measure, preservedGeometry, modelRows } from './design-workbench-measure.mjs';

export async function exerciseControls(q, shot) {
  const { page, fixture } = q, actions = [];
  const tool = page.locator('[data-tool-call-id="design-read"] .th-tool-head');
  assert.equal(await tool.getAttribute('aria-expanded'), 'false', 'successful tool defaults collapsed');
  assert.equal(await page.locator('[data-tool-call-id="design-running"] .th-tool-head').getAttribute('aria-expanded'), 'false', 'running tool defaults collapsed');
  await arm(page, () => !!document.querySelector('[data-tool-call-id="design-read"] .th-tool-output'));
  await tool.click(); await complete(page);
  const expanded = await page.locator('[data-tool-call-id="design-read"] .th-tool-output').evaluate(element => ({
    text: element.textContent, height: element.clientHeight, scrollHeight: element.scrollHeight, overflow: getComputedStyle(element).overflowY,
  }));
  assert.equal(expanded.text, output); assert(expanded.scrollHeight > expanded.height && expanded.height <= 360);
  assert.equal(expanded.overflow, 'auto'); await shot('tool-expanded');
  await arm(page, () => document.querySelector('[data-tool-call-id="design-read"] .th-tool-head')?.getAttribute('aria-expanded') === 'false');
  await tool.click(); await complete(page);
  await arm(page, () => document.querySelector('[data-tool-call-id="design-running"] .th-tool-status--error'));
  fixture.deliver('stored-a', { type: 'tool', toolCallId: 'design-running', toolName: 'bash', phase: 'end', isError: true, result: { content: [{ text: 'Provider failed after progress' }] } });
  await complete(page);
  assert.equal(await page.locator('[data-tool-call-id="design-running"] .th-tool-head').getAttribute('aria-expanded'), 'true', 'untouched live failure auto-opens');
  await page.locator('[data-tool-call-id="design-running"] .th-tool-head').click();
  await arm(page, () => document.querySelector('[data-tool-call-id="design-running"] .th-tool-preview')?.textContent === 'Retained closed failure');
  fixture.deliver('stored-a', { type: 'tool', toolCallId: 'design-running', toolName: 'bash', phase: 'end', isError: true, result: { content: [{ text: 'Retained closed failure' }] } });
  await complete(page);
  assert.equal(await page.locator('[data-tool-call-id="design-running"] .th-tool-head').getAttribute('aria-expanded'), 'false', 'explicit disclosure choice persists through update');
  actions.push({ action: 'tool-defaults-output-update-choice', pass: true, expanded });

  const textarea = page.locator('.th-chat-input textarea');
  await textarea.fill('local draft');
  assert.equal(await textarea.inputValue(), 'local draft');
  // Exact-target scrollend proves native transcript scrolling. Newly measured
  // virtual rows may adjust absolute scrollTop, so pin ancestor ownership, not direction.
  const transcript = page.locator('.th-chat-body');
  const outer = page.locator('.th-chat-main-content');
  const outerStart = await outer.evaluate(element => element.scrollTop);
  await wheel(page, transcript, -200, true);
  assert.equal(await outer.evaluate(element => element.scrollTop), outerStart, 'transcript wheel never scrolls the auxiliary shell');
  const before = await measure(page);
  const trigger = page.locator('.th-model-picker-btn');
  await arm(page, () => !!document.querySelector('.th-model-picker-popover'));
  await trigger.click(); await complete(page);
  const rows = await modelRows(page);
  assert.equal(rows.length, 53); assert(rows.some(row => row.complete && row.hit), 'complete model row reachable on open');
  const open = await measure(page);
  assert(open.roles.filter(role => role.actual).every(role => role.actual === role.expected), 'model overlay follows semantic token');
  await shot('model-open');
  const menuScroll = page.locator(await page.locator('.th-model-picker-popover--sheet').count() ? '.th-model-picker-list' : '.th-model-picker-popover');
  await wheel(page, menuScroll, 10000);
  const bottomRows = await modelRows(page), last = bottomRows.at(-1);
  assert(last.complete && last.hit, 'complete last model row pointer reachable');
  const bottom = await measure(page);
  assert.deepEqual(bottom.scroll, before.scroll, 'model list scroll is independent');
  assert.deepEqual(bottom.composer, before.composer, 'model menu preserves composer geometry');
  await shot('model-last-row');
  const selected = fixture.wait('frame', frame => frame.type === 'chat.set' && !!frame.model);
  await arm(page, () => !document.querySelector('.th-model-picker-popover'));
  await page.mouse.click(last.rect.x + last.rect.width / 2, last.rect.y + last.rect.height / 2);
  assert.deepEqual((await selected).model, { provider: 'long-provider', modelId: 'long-49' }); await complete(page);
  assert(await trigger.evaluate(element => element === document.activeElement));
  assert.equal(await textarea.inputValue(), 'local draft');
  actions.push({ action: 'model-wheel-pointer-selection-draft', pass: true, rows, last, beforeScroll: before.scroll, openScroll: open.scroll, bottomScroll: bottom.scroll });

  for (const [selector, panel] of [['.th-goal-bar', '.th-goal-panel'], ['.th-activity-shelf .th-activity-bar', '.th-activity-panel'], ['.th-queue-header', '.th-queue-body']]) {
    const button = page.locator(selector);
    await button.click();
    // Short columns intentionally refuse shelves which cannot fit; record that established behavior.
    const expanded = await button.getAttribute('aria-expanded');
    if (expanded === 'true') {
      assert.equal(await page.locator(panel).count(), 1);
      await shot(selector.includes('goal') ? 'goal' : selector.includes('activity') ? 'activity' : 'queue');
      await button.click();
    } else assert.equal(await page.locator(panel).count(), 0, 'a collapsed shelf must not hide an expanded panel');
    actions.push({ action: selector, expanded, pass: true });
  }
  if (await page.locator('.th-divider').count()) {
    const divider = page.locator('.th-divider').first();
    const orientation = await divider.getAttribute('aria-orientation');
    await divider.focus();
    const value = await divider.getAttribute('aria-valuenow');
    const maximum = Number(await divider.getAttribute('aria-valuemax'));
    await arm(page, () => !!document.querySelector('.th-pane-size'));
    await divider.press(orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'); await complete(page);
    const updated = await divider.getAttribute('aria-valuenow');
    if (maximum > Number(value)) assert(Number(updated) > Number(value) && Number(updated) <= maximum, 'axis arrow resizes within available bounds');
    else assert.equal(updated, value, 'constrained divider preserves its minimum pane sizes');
    await shot('divider');
    await arm(page, () => !document.querySelector('.th-pane-size'));
    await divider.press('Escape'); await complete(page);
    assert.equal(await divider.getAttribute('aria-valuenow'), updated, 'Escape retains resized geometry');
    // Focus another pane through its existing picker, without assigning or moving a session.
    const other = page.locator('.th-picker-pane select').first();
    const geometry = (await measure(page)).panes.map(pane => pane.rect);
    await other.focus();
    const changed = await measure(page); assert.equal(changed.panes.filter(pane => pane.active).length, 1);
    assert.deepEqual(changed.panes.map(pane => pane.rect), geometry, 'active outline is geometry-neutral');
    await textarea.focus();
    actions.push({ action: 'divider-axis-Escape-active-pane', value, updated, pass: true });
  }
  await textarea.fill('');
  const stopSlot = await page.locator('.th-chat-send-btn').boundingBox();
  const stopped = fixture.wait('frame', frame => frame.type === 'chat.abort');
  await arm(page, () => !document.querySelector('.th-chat-status-item--live'));
  await page.locator('.th-chat-send-btn').click(); await stopped; await complete(page);
  const sendSlot = await page.locator('.th-chat-send-btn').boundingBox();
  assert.deepEqual(sendSlot, stopSlot, 'Send/Stop uses the same slot');
  if (before.coarse) assert(sendSlot.width >= 44 && sendSlot.height >= 44, 'coarse Send/Stop target');
  actions.push({ action: 'stop-slot', pass: true, stopSlot, sendSlot });

  // Recovery is induced by a real parsed wire error, never synthetic markup.
  await arm(page, () => !!document.querySelector('.th-external-write-banner'));
  fixture.deliver('stored-a', { type: 'error', code: 'external-write-detected', message: 'Fixture external writer changed the session' });
  await complete(page);
  const recovery = page.locator('.th-external-write-banner-actions');
  await recovery.scrollIntoViewIfNeeded();
  const reachable = await recovery.evaluate(element => { const rect = element.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element === hit || element.contains(hit); });
  assert(reachable, 'recovery action is not hidden');
  assert(await textarea.isDisabled(), 'external-write recovery retains input guard');
  await shot('recovery'); preservedGeometry(await measure(page));
  actions.push({ action: 'external-write-recovery-visible', pass: true });
  return actions;
}

export async function auxiliarySurfaces(q, shot) {
  const { page, fixture } = q;
  const listed = fixture.wait('request', request => request.path.startsWith('/api/fs/list'));
  await page.locator('.th-files-toggle').click(); await listed;
  await shot('files');
  await arm(page, () => !document.querySelector('.th-files'));
  await page.locator('.th-files-head button').click(); await complete(page);
  await arm(page, () => !!document.querySelector('.th-settings-panel'));
  await page.locator('.th-settings-menu > button').click(); await complete(page);
  await shot('settings');
  await arm(page, () => document.querySelector('.th-settings-size-value')?.textContent === '15px');
  await page.locator('.th-settings-size-btn').last().click(); await complete(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('th-font-size')), '15');
  await shot('font-15-settings');
  await page.keyboard.press('Escape');
  await arm(page, () => !!document.querySelector('[role="dialog"]'));
  await page.locator('.th-disconnect-btn').click(); await complete(page);
  await shot('disconnect-dialog');
  await page.keyboard.press('Escape');
  assert.equal(fixture.frames.filter(frame => frame.type === 'chat.disconnect').length, 0, 'cancelled dialog never disconnects');
}
