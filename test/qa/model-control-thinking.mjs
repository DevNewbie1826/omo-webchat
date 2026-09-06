import assert from 'node:assert/strict';

/** Actual-App reasoning edges, using the same isolated wire fixture as model selection. */
export async function thinkingScenarios(q) {
  const { page, frames } = q;
  for (const narrow of [false, true]) {
    for (const scenario of ['loading', 'empty', 'failed', 'unloaded', 'ultra', 'rejected']) {
      const scenarioId = 'thinking-' + scenario + '-' + (narrow ? 'mobile' : 'desktop');
      const shot = (state, name = `${scenarioId}-${state}.png`) =>
        q.shot(name, { scenario: scenarioId, state });
      // Given a reported session state independent of catalog availability.
      const reported = scenario === 'unloaded' ? '' : scenario === 'ultra' ? 'ultra' : 'high';
      await q.reset(narrow ? 390 : 1440, narrow ? 844 : 900, {
        reported, catalog: scenario === 'loading' ? null : [],
        catalogFailure: scenario === 'failed', rejectThinking: scenario === 'rejected',
      });
      const trigger = page.locator('.th-model-picker-btn');
      const baseline = frames.length;
      assert.equal(await page.locator('.th-thinking-select').count(), 0);
      assert.equal(await trigger.count(), 1);
      assert((await trigger.textContent()).includes('provider-a/model-a'));
      const badge = trigger.locator('.th-model-picker-thinking');
      if (reported) {
        assert.equal(await badge.textContent(), reported);
        assert((await trigger.getAttribute('aria-label')).includes(reported));
      } else assert.equal(await badge.count(), 0, 'unloaded state does not fabricate off');
      await shot('initial-closed');
      await trigger.click();
      const popup = page.locator('.th-model-picker-popover');
      assert.deepEqual(await popup.evaluate(e => [...e.children].map(child => child.className)), [
        'th-model-picker-current', 'th-thinking-in-picker', 'th-model-picker-search', 'th-model-picker-list',
      ]);
      assert(await popup.evaluate(e => document.activeElement === e), 'common non-text initial focus');
      const pressed = popup.locator('.th-thinking-level[aria-pressed="true"]');
      if (reported) assert.equal(await pressed.textContent(), reported);
      else assert.equal(await pressed.count(), 0);
      assert.equal(await popup.locator('[role="option"]').count(), 0);
      assert.deepEqual(frames.slice(baseline).filter(f => f.type === 'chat.set'), []);
      await shot('initial-open');

      // When max is chosen by pointer, await the exact authoritative result.
      await page.evaluate(() => { window.qaControlPending = window.qaControl('set_thinking_level'); });
      await popup.locator('.th-thinking-level').filter({ hasText: /^max$/ }).click();
      const result = await page.evaluate(() => window.qaControlPending);
      const expected = scenario === 'rejected' ? reported : 'max';
      await page.evaluate(expected => window.qaSignal(() =>
        document.querySelector('.th-model-picker-thinking')?.textContent === expected), expected);
      // Then only one exact request was sent and badge/chip reflect confirmation or rollback.
      const sets = frames.slice(baseline).filter(f => f.type === 'chat.set');
      assert.equal(sets.length, 1);
      assert.deepEqual(sets[0], { type: 'chat.set', sessionId: 'stored-a',
        requestId: result.requestId, thinkingLevel: 'max' });
      assert.equal(await pressed.textContent(), expected);
      assert.equal(await badge.textContent(), expected);
      const outcome = scenario === 'rejected' ? 'rollback-high' : 'confirmed-max';
      await shot(outcome, `${scenarioId}.png`);
      await page.keyboard.press('Escape');
      assert.equal(await popup.count(), 0);
      assert(await trigger.evaluate(e => document.activeElement === e));
      await shot(`closed-${outcome}`);

      if (scenario === 'loading') {
        // Catalog hydration must not remount the open picker or change the selected level.
        await trigger.click();
        const max = popup.locator('.th-thinking-level').filter({ hasText: /^max$/ });
        await max.focus();
        await shot('before-catalog-hydration');
        await page.evaluate(() => { window.qaHydrated = window.qaSignal(() =>
          document.querySelector('.th-model-picker-label')?.textContent === 'Model A'); });
        q.deliver({ type: 'models', models: [{ provider: 'provider-a', modelId: 'model-a', name: 'Model A' }] });
        await page.evaluate(() => window.qaHydrated);
        assert(await max.evaluate(e => document.activeElement === e));
        assert.equal(await badge.textContent(), 'max');
        assert.equal(frames.slice(baseline).filter(f => f.type === 'chat.set').length, 1);
        await shot('catalog-hydrated');
        await page.keyboard.press('Escape');
      }
      q.results.push({ scenario: 'thinking-' + scenario + '-' + (narrow ? 'mobile' : 'desktop'),
        pass: true, reported, expected, result, sets });
    }
  }
}
