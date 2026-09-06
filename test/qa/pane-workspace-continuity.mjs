import assert from 'node:assert/strict';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=';
export async function sessionContinuityScenarios(q) {
  const { fixture, reset, arm, done, shot, scenario } = q;
  await scenario('unsent-draft-image-move-and-replacement', async () => {
    const page = await reset();
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-model-picker-btn')));
    const baseline = fixture.frames.length, requestsBefore = fixture.requests.length;
    const expected = { text: 'Unsent draft must follow Stored A', image: 'data:image/png;base64,' + png };
    const draft = () => page.evaluate(() => ({ text: document.querySelector('.th-chat-input textarea').value,
      image: document.querySelector('.th-chat-attach-thumb')?.getAttribute('src') ?? null }));
    await page.locator('.th-chat-input textarea').fill(expected.text);
    await arm(() => !!document.querySelector('.th-chat-attach-thumb'));
    await page.locator('input[type="file"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await done();
    assert.deepEqual(await draft(), expected); await shot('draft-image-BEFORE-move.png');
    await page.locator('[data-pane-id="b"] select').focus();
    await arm(() => !!document.querySelector('[data-pane-id="b"] .th-model-picker-btn'));
    await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click(); await done();
    assert.equal(await page.locator('[data-pane-id="a"] .th-picker-pane').count(), 1);
    assert.equal(await page.locator('.th-chat-input').count(), 1);
    assert.deepEqual(await draft(), expected); await shot('draft-image-AFTER-move.png');
    await arm(() => document.querySelector('[data-pane-id="b"] .th-termhead-name')?.textContent === 'Newer');
    await page.locator('.th-tree-activation').filter({ hasText: /^Newer$/ }).click(); await done();
    assert.deepEqual(await draft(), { text: '', image: null });
    await page.locator('[data-pane-id="a"] select').focus();
    await arm(() => !!document.querySelector('[data-pane-id="a"] .th-model-picker-btn'));
    await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click(); await done();
    assert.deepEqual(await draft(), expected);
    assert.equal(fixture.frames.slice(baseline).filter(f => ['chat.send', 'chat.abort', 'chat.close', 'chat.disconnect'].includes(f.type)).length, 0);
    assert.equal(fixture.requests.slice(requestsBefore).filter(r => r.method === 'DELETE').length, 0);
    const sent = fixture.wait('frame', f => f.type === 'chat.send');
    await arm(() => !!document.querySelector('[data-pane-id="a"] .th-chat-status-item--live'));
    await page.locator('[data-pane-id="a"] .th-chat-send-btn').click(); const frame = await sent; await done();
    assert.equal(frame.sessionId, 'stored-a');
    assert.deepEqual(frame.run, { kind: 'prompt', message: expected.text, images: [{ data: png, mimeType: 'image/png' }] });
    assert.deepEqual(await draft(), { text: '', image: null });
    await arm(() => !document.querySelector('.th-chat-status-item--live'));
    fixture.deliver('stored-a', { type: 'run.done', reason: 'stop' }); await done();
    await shot('draft-image-reopened-submitted.png');
    return { expected, frame, uniquePlacement: true, destructiveFrames: [] };
  });
  await scenario('running-move-replacement-later-events-and-correct-stop', async () => {
    const page = await reset({ running: ['stored-a'] });
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-chat-status-item--live')));
    const baseline = fixture.frames.length, requestsBefore = fixture.requests.length;
    await page.locator('[data-pane-id="b"] select').focus();
    await arm(() => !!document.querySelector('[data-pane-id="b"] .th-chat-status-item--live'));
    await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click(); await done();
    assert.equal(await page.locator('[data-pane-id="a"] .th-picker-pane').count(), 1);
    assert.equal(await page.locator('[data-pane-id="b"] .th-chat-send-btn').getAttribute('type'), 'button');
    await shot('running-session-MOVED-Stop.png');
    await arm(() => document.querySelector('[data-pane-id="b"] .th-termhead-name')?.textContent === 'Newer'
      && !!document.querySelector('[data-pane-id="b"] .th-model-picker-btn'));
    await page.locator('.th-tree-activation').filter({ hasText: /^Newer$/ }).click(); await done();
    assert.equal(await page.locator('[data-pane-id="b"] .th-chat-send-btn').getAttribute('type'), 'submit');
    assert.equal(fixture.runState('stored-a').running, true);
    await shot('running-session-UNPLACED-idle-replacement.png');
    await page.locator('[data-pane-id="a"] select').focus();
    await arm(() => !!document.querySelector('[data-pane-id="a"] .th-chat-status-item--live'));
    await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click(); await done();
    assert.equal(await page.locator('[data-pane-id="a"] .th-chat-send-btn').getAttribute('type'), 'button');
    await arm(() => document.querySelector('[data-pane-id="a"] .th-chat-transcript')?.textContent.includes('The original run continues after reattachment')
      || document.querySelector('[data-pane-id="a"] .th-chat-scrollport')?.textContent.includes('The original run continues after reattachment'));
    fixture.deliver('stored-a', { type: 'messageDelta', delta: { kind: 'text_delta', delta: 'The original run continues after reattachment' } }); await done();
    await shot('running-session-REATTACHED-later-event-Stop.png');
    assert.equal(fixture.frames.slice(baseline).filter(f => ['chat.send', 'chat.abort', 'chat.close', 'chat.disconnect'].includes(f.type)).length, 0);
    assert.equal(fixture.requests.slice(requestsBefore).filter(r => r.method === 'DELETE').length, 0);
    const abort = fixture.wait('frame', f => f.type === 'chat.abort');
    await arm(() => !document.querySelector('[data-pane-id="a"] .th-chat-status-item--live'));
    await page.locator('[data-pane-id="a"] .th-chat-send-btn').click(); const stopped = await abort; await done();
    assert.equal(stopped.sessionId, 'stored-a'); assert.equal(fixture.runState('stored-a').running, false);
    assert.equal(await page.locator('[data-pane-id="a"] .th-chat-send-btn').getAttribute('type'), 'submit');
    assert.equal(fixture.frames.slice(baseline).filter(f => f.type === 'chat.abort').length, 1);
    await shot('running-session-correct-STOPPED.png');
    return { stopped, frames: fixture.frames.slice(baseline), runningAfterMove: true, laterEventRendered: true };
  });
  await scenario('deferred-new-chat-preserves-later-active-and-dom-focus', async () => {
    const page = await reset({ deferredCreate: true });
    const created = fixture.wait('create');
    await page.locator('[data-pane-id="b"] .th-picker-pane-create button').click(); const pending = await created;
    await page.locator('[data-pane-id="a"] .th-files-toggle').focus();
    const focus = () => page.evaluate(() => ({ active: document.querySelector('.th-pane--focused')?.closest('[data-pane-id]')?.dataset.paneId,
      dom: document.activeElement?.closest('[data-pane-id]')?.dataset.paneId }));
    assert.deepEqual(await focus(), { active: 'a', dom: 'a' });
    await arm(() => document.querySelector('[data-pane-id="b"] .th-termhead-name')?.textContent === 'Created chat');
    fixture.resolveCreate(pending.index); await done();
    assert.deepEqual(await focus(), { active: 'a', dom: 'a' });
    assert.equal(await page.locator('.th-pane--focused').count(), 1);
    await shot('deferred-new-chat-focus-preserved.png');
    await arm(() => document.querySelector('[data-pane-id="a"] .th-termhead-name')?.textContent === 'Newer');
    await page.locator('.th-tree-activation').filter({ hasText: /^Newer$/ }).click(); await done();
    assert.deepEqual(await page.locator('.th-termhead-name').allTextContents(), ['Newer', 'Created chat']);
    return { capturedDestination: 'b', activeAfterCompletion: 'a', domAfterCompletion: 'a', nextSelectionDestination: 'a' };
  });
}
