import assert from "node:assert/strict";
export async function sessionAndShellScenarios(q) {
  const { fixture, reset, arm, done, shot, scenario } = q;
  for (const lang of ["en", "ko"]) for (const narrow of [false, true]) {
    await scenario(`sidebar-long-labels-${lang}-${narrow ? "mobile" : "desktop"}`, async () => {
      const page = await reset({ layout: "single", longLabels: true, lang }, { width: narrow ? 390 : 1440, height: narrow ? 844 : 900 });
      await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-model-picker-btn')));
      async function toggle(selector, property) {
        await page.evaluate(property => {
          const sidebar = document.querySelector('.th-sidebar');
          window.qaTransition = new Promise((done, fail) => {
            const timeout = setTimeout(() => { sidebar.removeEventListener('transitionend', end); fail(new Error('Sidebar transition deadline')); }, 8000);
            function end(event) { if (event.target === sidebar && event.propertyName === property) {
              clearTimeout(timeout); sidebar.removeEventListener('transitionend', end); done(true);
            } }
            sidebar.addEventListener('transitionend', end);
          });
        }, property);
        await page.locator(selector).click(); await page.evaluate(() => window.qaTransition);
      }
      if (narrow) await toggle('.th-mobile-menu', 'transform');
      const expanded = await page.evaluate(() => {
        const sidebar = document.querySelector('.th-sidebar'), rect = sidebar.getBoundingClientRect();
        return { sidebar: rect.toJSON(), railWidth: document.querySelector('.th-sidebar-rail')?.getBoundingClientRect().width ?? 0,
          toolbar: [...document.querySelectorAll('.th-sidebar-nav button')].map(e => {
            const box = e.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return { box: box.toJSON(), hit: e === hit || e.contains(hit) };
          }), scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
      });
      assert.equal(expanded.railWidth, 0); assert.equal(expanded.sidebar.width, 264);
      assert(expanded.toolbar.every(button => button.hit && button.box.left >= 0 && button.box.right <= expanded.sidebar.right));
      assert(expanded.scrollWidth <= expanded.width);
      await shot(`sidebar-${lang}-${narrow ? "mobile" : "desktop"}-expanded.png`);
      await toggle('.th-sidebar-nav-actions button:last-child', narrow ? 'transform' : 'width');
      assert.equal(await page.locator('.th-sidebar--collapsed').count(), 1);
      await shot(`sidebar-${lang}-${narrow ? "mobile" : "desktop"}-collapsed.png`);
      await toggle(narrow ? '.th-mobile-menu' : '.th-sidebar-rail .th-sidebar-toggle', narrow ? 'transform' : 'width');
      assert.equal(await page.locator('.th-sidebar--collapsed').count(), 0);
      return expanded;
    });
  }
  await scenario('picker-loaded-discovered-paged-parity-and-retry', async () => {
    const page = await reset();
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-picker-pane-item')));
    const picker = page.locator('[data-pane-id="b"] .th-picker-pane-item');
    assert.deepEqual(await picker.allTextContents(), await page.locator('.th-tree-activation:not(.th-tree-label)').allTextContents());
    const requestsBefore = fixture.requests.length;
    const placed = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === 'union');
    await picker.filter({ hasText: 'Union stored row' }).click(); await placed;
    assert.equal(fixture.requests.slice(requestsBefore).filter(r => r.path.endsWith('/sessions/open')).length, 0);
    await page.locator('[data-pane-id="b"] .th-termhead-actions button').last().click();
    await arm(() => document.querySelectorAll('.th-pane-wrap').length === 2);
    await page.locator('.th-termhead-actions button').first().click(); await done();
    fixture.failNextPage();
    await arm(() => !!document.querySelector('.th-picker-page-retry'));
    await page.locator('.th-picker-load-more').click(); await done();
    await arm(() => [...document.querySelectorAll('.th-picker-pane-item')].some(e => e.textContent === 'Discovered C'));
    await page.locator('.th-picker-page-retry').click(); await done();
    assert.deepEqual(await page.locator('.th-picker-pane-item').allTextContents(), await page.locator('.th-tree-activation:not(.th-tree-label)').allTextContents());
    let opened = fixture.wait('open');
    await page.locator('.th-picker-pane-item').filter({ hasText: 'Discovered C' }).click();
    const first = await opened;
    assert.equal(await page.locator('.th-picker-pane-item[aria-busy="true"]').count(), 1);
    await arm(() => !!document.querySelector('.th-picker-retry-open'));
    fixture.resolveOpen(first.index, { error: 'fixture open failure' }, 500); await done();
    opened = fixture.wait('open'); await page.locator('.th-picker-retry-open').click(); const retry = await opened;
    const connected = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === 'opened-discovered-c');
    fixture.resolveOpen(retry.index); await connected;
    assert.deepEqual(await page.locator('.th-termhead-name').allTextContents(), ['Stored A', 'Opened discovered-c']);
    await shot('session-page-open.png');
    return { loadedUnionOpenedWithoutImport: true, pageRetry: true, openRetry: true };
  });
  await scenario('empty-new-chat-and-keyboard-destination', async () => {
    const page = await reset();
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-picker-pane-item')));
    const made = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId.startsWith('created-'));
    await page.locator('[data-pane-id="b"] .th-picker-pane-create button').click(); await made;
    assert.deepEqual(await page.locator('.th-termhead-name').allTextContents(), ['Stored A', 'Created chat']);
    const before = await page.locator('[data-pane-id="a"]').boundingBox();
    await page.locator('[data-pane-id="a"] .th-files-toggle').focus();
    assert.equal(await page.locator('.th-pane--focused').count(), 1);
    await page.locator('[data-pane-id="b"] .th-files-toggle').focus();
    assert.deepEqual(await page.locator('[data-pane-id="a"]').boundingBox(), before);
    const moved = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === 'stored-a');
    await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click(); await moved;
    assert.equal(await page.locator('[data-pane-id="a"] .th-picker-pane').count(), 1);
    assert.equal(await page.locator('[data-pane-id="b"] .th-termhead-name').textContent(), 'Stored A');
    assert.equal(await page.locator('.th-pane--focused').count(), 1);
    await shot('keyboard-destination.png');
  });
  await scenario('narrow-empty-discovered-and-new-chat', async () => {
    const page = await reset({ layout: 'empty', deferred: false }, { width: 390, height: 844 });
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-empty .th-picker-pane-item')));
    await shot('narrow-empty-picker.png');
    const connected = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === 'opened-discovered-b');
    await page.locator('.th-empty .th-picker-pane-item').filter({ hasText: 'Discovered B' }).click(); await connected;
    assert.equal(await page.locator('.th-termhead-name').textContent(), 'Opened discovered-b');
    const next = await reset({ layout: 'empty' }, { width: 390, height: 844 });
    const made = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId.startsWith('created-'));
    await next.locator('.th-picker-pane-create button').click(); await made;
    assert.equal(await next.locator('.th-termhead-name').textContent(), 'Created chat');
  });
}
