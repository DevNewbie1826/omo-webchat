import assert from 'node:assert/strict';
import { arm, complete, wheel, output, fileContent } from './design-workbench-fixture.mjs';
import { measure, preservedGeometry, modelRows, contentAnchor, assertAnchor } from './design-workbench-measure.mjs';

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
  const before = await measure(page), anchor = await contentAnchor(page);
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
  const bottomAnchor = await contentAnchor(page, anchor);
  assertAnchor(anchor, bottomAnchor);
  assert.equal(bottom.scroll.outer, before.scroll.outer, 'model list never scrolls the auxiliary shell');
  assert.deepEqual(bottom.composer, before.composer, 'model menu preserves composer geometry');
  await shot('model-last-row');
  const selected = fixture.wait('frame', frame => frame.type === 'chat.set' && !!frame.model);
  await arm(page, () => !document.querySelector('.th-model-picker-popover'));
  await page.mouse.click(last.rect.x + last.rect.width / 2, last.rect.y + last.rect.height / 2);
  assert.deepEqual((await selected).model, { provider: 'long-provider', modelId: 'long-49' }); await complete(page);
  assert(await trigger.evaluate(element => element === document.activeElement));
  assert.equal(await textarea.inputValue(), 'local draft');
  actions.push({ action: 'model-wheel-pointer-selection-draft', pass: true, rows, last, anchor, bottomAnchor, beforeScroll: before.scroll, openScroll: open.scroll, bottomScroll: bottom.scroll });

  for (const [selector, panel] of [['.th-goal-bar', '.th-goal-panel'], ['.th-activity-shelf .th-activity-bar', '.th-activity-panel'], ['.th-queue-header', '.th-queue-body']]) {
    const button = page.locator(selector);
    const reachable = await revealAuxiliaryControl(page, button);
    await page.mouse.click(reachable.x, reachable.y);
    // Short columns intentionally refuse shelves which cannot fit; record that established behavior.
    const expanded = await button.getAttribute('aria-expanded');
    if (expanded === 'true') {
      assert.equal(await page.locator(panel).count(), 1);
      await shot(selector.includes('goal') ? 'goal' : selector.includes('activity') ? 'activity' : 'queue');
      const collapse = await revealAuxiliaryControl(page, button);
      await page.mouse.click(collapse.x, collapse.y);
    } else assert.equal(await page.locator(panel).count(), 0, 'a collapsed shelf must not hide an expanded panel');
    actions.push({ action: selector, expanded, reachable, pass: true });
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
    actions.push({ action: 'divider-axis-Escape-active-pane', value, maximum, updated,
      clamped: maximum <= Number(value), pass: true });
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
  const reachable = await revealAuxiliaryControl(page, recovery);
  assert(reachable.hit, 'recovery action is not hidden');
  assert(await textarea.isDisabled(), 'external-write recovery retains input guard');
  await shot('recovery'); preservedGeometry(await measure(page));
  actions.push({ action: 'external-write-recovery-visible', pass: true });
  return actions;
}

/** Scroll only the named auxiliary owner; never scroll hidden ancestors or force clicks. */
export async function revealAuxiliaryControl(page, control) {
  const delta = await control.evaluate(element => {
    const auxiliary = element.closest('.th-chat-main-content');
    const bounds = auxiliary.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const target = auxiliary.scrollTop + rect.top - bounds.top - (auxiliary.clientHeight - rect.height) / 2;
    return Math.max(0, Math.min(auxiliary.scrollHeight - auxiliary.clientHeight, target)) - auxiliary.scrollTop;
  });
  if (Math.abs(delta) >= 1) await wheel(page, page.locator('.th-chat-main-content'), delta, true);
  const reachable = await control.evaluate(element => {
    const auxiliary = element.closest('.th-chat-main-content');
    const bounds = auxiliary.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: element === hit || element.contains(hit), hitTarget: hit?.className,
      control: element.className, rect: rect.toJSON(), auxiliary: bounds.toJSON(),
      auxiliaryScrollTop: auxiliary.scrollTop,
      complete: rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 };
  });
  assert(reachable.complete && reachable.hit, `Auxiliary control is not pointer reachable: ${JSON.stringify(reachable)}`);
  return reachable;
}

export async function auxiliarySurfaces(q, shot) {
  const { page, fixture } = q;
  await exerciseQueue(q, shot);
  const listed = fixture.wait('request', request => request.path.startsWith('/api/fs/list'));
  await arm(page, () => !!document.querySelector('.th-files-name--link'));
  await page.locator('.th-files-toggle').click();
  assert.deepEqual(await listed, { method: 'GET', path: '/api/fs/list?path=%2Ffixture', body: undefined }); await complete(page);
  await shot('files');
  const read = fixture.wait('request', request => request.path.startsWith('/api/fs/read'));
  await arm(page, () => !!document.querySelector('.th-editor-area'));
  await page.locator('.th-files-name--link').click();
  assert.deepEqual(await read, { method: 'GET', path: '/api/fs/read?path=%2Ffixture%2Fsession.ts', body: undefined }); await complete(page);
  assert.equal(await page.locator('.th-editor-area').inputValue(), fileContent);
  await shot('editor-open');
  const edited = fileContent + '// edited through the actual editor\n';
  await page.locator('.th-editor-area').fill(edited);
  assert.equal(await page.locator('.th-editor-dirty').count(), 1);
  await shot('editor-dirty');
  const written = fixture.wait('request', request => request.path.startsWith('/api/fs/write'));
  await arm(page, () => !document.querySelector('.th-editor-dirty') && document.querySelector('.th-editor-save')?.disabled);
  await page.locator('.th-editor-save').click();
  assert.deepEqual(await written, { method: 'POST', path: '/api/fs/write?path=%2Ffixture%2Fsession.ts', body: { content: edited } }); await complete(page);
  assert.equal(fixture.fileContent('/fixture/session.ts'), edited);
  await shot('editor-saved');
  await arm(page, () => !document.querySelector('.th-editor') && document.activeElement?.matches('.th-files-name--link'));
  await page.locator('.th-editor-head .th-btn-icon').click(); await complete(page);
  const reread = fixture.wait('request', request => request.path.startsWith('/api/fs/read'));
  await arm(page, () => !!document.querySelector('.th-editor-area'));
  await page.locator('.th-files-name--link').click(); await reread; await complete(page);
  assert.equal(await page.locator('.th-editor-area').inputValue(), edited, 'saved editor content survives reopening');
  await shot('editor-reopened');
  // FileBrowser owns Escape in capture phase, including an open clean editor.
  await arm(page, () => !document.querySelector('.th-files'));
  await page.locator('.th-editor-area').press('Escape'); await complete(page);
  await arm(page, () => !!document.querySelector('.th-settings-panel'));
  await page.locator('.th-settings-menu > button').click(); await complete(page);
  await shot('settings');
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('radio', { name: 'System', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('th-theme')), 'system');
  for (const theme of [initialTheme === 'dark' ? 'light' : 'dark', initialTheme]) {
    await arm(page, theme === 'dark' ? () => document.documentElement.dataset.theme === 'dark' : () => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: theme }); await complete(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('th-theme')), 'system');
    assert((await measure(page)).roles.filter(role => role.actual).every(role => role.actual === role.expected));
    await shot(`system-${theme}`);
  }
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

export async function exerciseQueue({ page, fixture }, shot) {
  const header = page.locator('.th-queue-header');
  const reachable = await revealAuxiliaryControl(page, header);
  await arm(page, () => !!document.querySelector('.th-queue-body'));
  await page.mouse.click(reachable.x, reachable.y); await complete(page);
  const original = fixture.runState('stored-a').queue;
  const moved = fixture.wait('frame', frame => frame.type === 'chat.queue.move');
  await arm(page, () => document.querySelector('.th-queue-row .th-queue-text')?.textContent?.startsWith('1:'));
  await page.locator('.th-queue-btn--down').first().click();
  assert.deepEqual(await moved, { type: 'chat.queue.move', sessionId: 'stored-a', itemId: 'design-queue-0', toIndex: 1 }); await complete(page);
  const reordered = [original.items[1], original.items[0], ...original.items.slice(2)];
  assert.deepEqual(fixture.runState('stored-a').queue, { ...original, revision: 2, items: reordered });
  assert.deepEqual(await page.locator('.th-queue-row--waiting .th-queue-text').allTextContents(), reordered.map(item => item.text));
  await shot('queue-moved');
  const removed = fixture.wait('frame', frame => frame.type === 'chat.queue.remove');
  await arm(page, () => document.querySelectorAll('.th-queue-row--waiting').length === 8);
  await page.locator('.th-queue-btn--remove').nth(1).click();
  assert.deepEqual(await removed, { type: 'chat.queue.remove', sessionId: 'stored-a', itemId: 'design-queue-0' }); await complete(page);
  const remaining = reordered.filter(item => item.id !== 'design-queue-0');
  assert.deepEqual(fixture.runState('stored-a').queue, { ...original, revision: 3, items: remaining });
  assert.deepEqual(await page.locator('.th-queue-row--waiting .th-queue-text').allTextContents(), remaining.map(item => item.text));
  await shot('queue-removed');
  await wheel(page, page.locator('.th-queue-body'), 10000, true);
  const cleared = fixture.wait('frame', frame => frame.type === 'chat.queue.clear');
  await arm(page, () => !document.querySelector('.th-queue'));
  await page.locator('.th-queue-clear').click();
  assert.deepEqual(await cleared, { type: 'chat.queue.clear', sessionId: 'stored-a', scope: 'all' }); await complete(page);
  assert.deepEqual(fixture.runState('stored-a').queue, { revision: 4, items: [], engine: { pendingMessageCount: 0, ordered: [] } });
  await shot('queue-cleared');
}
