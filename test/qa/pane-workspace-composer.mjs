import assert from "node:assert/strict";
import { shortMenuScenarios } from "./pane-workspace-short-menus.mjs";
export async function composerAndPersistenceScenarios(q) {
  const { fixture, reset, arm, done, shot, scenario } = q;
  for (const narrow of [false, true]) {
    await scenario(`model-thinking-send-stop-attachment-${narrow ? "mobile" : "desktop"}`, async () => {
      const page = await reset({ layout: 'single' }, { width: narrow ? 390 : 1440, height: narrow ? 844 : 900 });
      await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-model-picker-btn')));
      const trigger = page.locator('.th-model-picker-btn');
      const baseline = fixture.frames.length;
      await trigger.focus(); await arm(() => !!document.querySelector('.th-model-picker-popover'));
      await page.keyboard.press('Enter'); await done();
      if (narrow) {
        for (let i = 0; i < 15; i++) {
          await page.keyboard.press('Tab');
          if (await page.locator('.th-model-picker-search').evaluate(e => e === document.activeElement)) break;
        }
      }
      assert(await page.locator('.th-model-picker-search').evaluate(e => e === document.activeElement));
      await page.keyboard.type('provider-b');
      await q.armWire("set_model");
      const selected = fixture.wait('frame', f => f.type === 'chat.set' && !!f.model);
      await page.keyboard.press('Enter'); assert.deepEqual((await selected).model, { provider: 'provider-b', modelId: 'model-b' }); await q.wireDone();
      const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      for (const level of levels) {
        await trigger.focus(); await arm(() => !!document.querySelector('.th-model-picker-popover'));
        await page.keyboard.press('Enter'); await done();
        const button = page.locator('.th-thinking-level').filter({ hasText: new RegExp(`^${level}$`) });
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press('Tab');
          if (await button.evaluate(e => e === document.activeElement)) break;
        }
        assert(await button.evaluate(e => e === document.activeElement), `Tab must reach thinking ${level}`);
        await q.armWire('set_thinking_level');
        const changed = fixture.wait('frame', f => f.type === 'chat.set' && f.thinkingLevel === level);
        await page.keyboard.press('Enter'); await changed; await q.wireDone();
        await page.keyboard.press('Escape');
        assert(await trigger.evaluate(e => e === document.activeElement));
      }
      const modelFrames = fixture.frames.slice(baseline).filter(f => f.type === 'chat.set' && f.model);
      const thinkingFrames = fixture.frames.slice(baseline).filter(f => f.type === 'chat.set' && f.thinkingLevel);
      assert.equal(modelFrames.length, 1); assert.deepEqual(thinkingFrames.map(f => f.thinkingLevel), levels);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64');
      await arm(() => !!document.querySelector('.th-chat-attach-chip'));
      await page.locator('input[type="file"]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png }); await done();
      await page.locator('.th-chat-input textarea').fill('Exact fixture send with attachment');
      const sent = fixture.wait('frame', f => f.type === 'chat.send');
      await arm(() => document.querySelector('.th-chat-send-btn')?.getAttribute('type') === 'button');
      await page.locator('.th-chat-send-btn').click(); const frame = await sent; await done();
      assert.equal(frame.run.message, 'Exact fixture send with attachment'); assert.equal(frame.run.images.length, 1);
      const stopped = fixture.wait('frame', f => f.type === 'chat.abort');
      await arm(() => !document.querySelector('.th-chat-status-item--live'));
      await page.locator('.th-chat-send-btn').click(); await stopped; await done();
      assert.equal(fixture.frames.slice(baseline).filter(f => f.type === 'chat.send').length, 1);
      assert.equal(fixture.frames.slice(baseline).filter(f => f.type === 'chat.abort').length, 1);
      await shot(`composer-${narrow ? "mobile" : "desktop"}-stopped.png`);
      return { modelFrames, thinkingFrames, sent: frame, stopCount: 1 };
    });
  }
  await scenario('layout-resize-persistence-close-and-reopen', async () => {
    const page = await reset();
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-divider')));
    const divider = page.locator('.th-divider');
    const saved = fixture.wait('layout', tree => tree.kind === 'split' && tree.ratio !== .5);
    await divider.focus(); await page.keyboard.press('End'); const layout = await saved;
    const value = await divider.getAttribute('aria-valuenow');
    await page.reload();
    await page.evaluate(value => window.qaSignal(() => document.querySelector('.th-divider')?.getAttribute('aria-valuenow') === value), value);
    assert.equal(await page.locator('.th-divider').getAttribute('aria-valuenow'), value);
    assert.deepEqual(fixture.layout, layout);
    const closed = fixture.wait('layout', tree => tree.kind === 'leaf');
    await page.locator('[data-pane-id="b"] .th-pane-close').click(); await closed;
    assert.equal(await page.locator('.th-pane--focused').count(), 1);
    const split = fixture.wait('layout', tree => tree.kind === 'split');
    await page.locator('.th-termhead-actions button').first().click(); await split;
    assert.equal(await page.locator('.th-pane-wrap').count(), 2);
    await shot('layout-persisted-reopened.png');
    return { persisted: layout, value };
  });
  for (const [width, height] of [[1440, 900], [390, 844], [390, 420]]) {
    await scenario(`regression-shelves-files-long-labels-${width}-${height}`, async () => {
      const page = await reset({ layout: 'single', shelves: true, longLabels: true }, { width, height });
      await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-activity-bar') && !!document.querySelector('.th-goal-bar')));
      await page.locator('.th-goal-bar').click(); await page.locator('.th-activity-shelf .th-activity-bar').click();
      const geometry = await page.evaluate(() => {
        const box = s => document.querySelector(s)?.getBoundingClientRect().toJSON();
        return { goal: box('.th-goal-panel'), activity: box('.th-activity-panel'), goalShelf: box('.th-goal-shelf'), activityShelf: box('.th-activity-shelf'),
          goalExpanded: document.querySelector('.th-goal-bar').getAttribute('aria-expanded'), activityExpanded: document.querySelector('.th-activity-shelf .th-activity-bar').getAttribute('aria-expanded'), transcript: box('.th-chat-scrollport'),
          composer: box('.th-chat-input'), trigger: box('.th-model-picker-btn'), scrollWidth: document.documentElement.scrollWidth,
          viewport: { width: innerWidth, height: innerHeight } };
      });
      await shot(`shelves-${width}-${height}.png`);
      assert(geometry.scrollWidth <= width); assert(geometry.composer.bottom <= height + 1);
      assert(geometry.composer.height > 50 && geometry.transcript.height >= 0);
      assert(geometry.trigger.top >= 0 && geometry.trigger.bottom < geometry.composer.bottom);
      assert(geometry.goalShelf.bottom <= geometry.activityShelf.top + 1);
      assert(geometry.activityShelf.bottom <= geometry.composer.top + 1);
      if (!geometry.goal) assert.equal(geometry.goalExpanded, 'false');
      if (!geometry.activity) assert.equal(geometry.activityExpanded, 'false');
      const listed = fixture.wait('request', r => r.path.startsWith('/api/fs/list'));
      await page.locator('.th-files-toggle').click(); await listed;
      await arm(() => !document.querySelector('.th-files'));
      await page.locator('.th-files-head button').click(); await done();
      return geometry;
    });
  }
  await shortMenuScenarios(q);
}
