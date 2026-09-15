import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '/Users/mirage/.bun/install/cache/playwright-core@1.63.0@@@1/index.mjs';
import { startComposerFixture, transition } from './ui-composer-fixture.mjs';
import { installSignals } from './design-workbench-fixture.mjs';

const out = new URL('../../.omo/evidence/question-protocol/r3-keys/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [], receipts = [];
const two = { kind: 'split', id: 'root', dir: 'h', ratio: .5,
  first: { kind: 'leaf', id: 'a', sessionId: 'stored-a' }, second: { kind: 'leaf', id: 'b', sessionId: 'newer' } };
try {
  for (const profile of [
    { name: 'phone', viewport: { width: 390, height: 844 }, layout: 'single' },
    { name: 'small-phone', viewport: { width: 360, height: 740 }, layout: 'single' },
    { name: 'laptop', viewport: { width: 1440, height: 900 }, layout: two },
    { name: 'dense', viewport: { width: 1440, height: 780 }, layout: { ...two, dir: 'v' } },
  ]) {
    const fixture = startComposerFixture({ layout: profile.layout, shelves: false, longLabels: false, running: [], runs: {} });
    const context = await browser.newContext({ viewport: profile.viewport, hasTouch: profile.name.includes('phone'), isMobile: profile.name.includes('phone') });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = [], responses = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await installSignals(page);
      const attached = fixture.wait('frame', frame => frame.type === 'chat.stats' && frame.sessionId === 'stored-a');
      await page.goto(fixture.url); await attached;
      await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-chat-pane .th-chat-input textarea')));
      const pane = page.locator('.th-chat-pane').first();
      const dock = pane.locator('.th-approval-dock');
      const height = await pane.locator('.th-chat-main').evaluate(el => el.getBoundingClientRect().height);
      if (profile.name === 'dense') assert.ok(height >= 300 && height <= 360, `dense column: ${height}`);
      if (profile.name === 'laptop') assert.equal(await page.locator('.th-chat-pane').count(), 2);
      const deliver = async (frame, selector) => {
        await transition(page, `() => !!document.querySelector('${selector}')`, async () => fixture.deliver('stored-a', frame));
        if (await dock.getByRole('button', { name: 'Expand', exact: true }).count()) await dock.getByRole('button', { name: 'Expand', exact: true }).click();
      };
      const send = async (button, expected) => {
        const pending = fixture.wait('frame', frame => frame.type === 'approval.respond');
        await transition(page, '() => !document.querySelector(".th-chat-pane .th-approval-dock, .th-chat-pane .th-question-bar")', () => button.click());
        const frame = await pending;
        const { type, sessionId, requestId, ...payload } = frame;
        assert.equal(typeof requestId, 'string');
        assert.equal(type, 'approval.respond'); assert.equal(sessionId, 'stored-a');
        assert.deepEqual(payload, expected); responses.push(frame);
      };
      for (const nonBlocking of [true, false]) {
        const surface = nonBlocking ? 'inline' : 'panel';
        // Given effective keys that collide, when delivered, then only a cancellable fallback renders.
        await deliver({ type: 'approval', id: `collision-${surface}`, method: 'question', title: 'Collision request', nonBlocking,
          questions: [{ question: 'First', options: [{ label: 'first answer' }] }, { id: 'q1', question: 'Second', options: [{ label: 'second answer' }] }] }, '.th-approval-dock');
        assert.equal(await dock.getByRole('heading', { name: 'Collision request', exact: true }).count(), 1);
        assert.equal(await dock.locator('.th-approval-fallback-note').count(), 1);
        assert.equal(await pane.locator('.th-question-bar, .th-approval-question-tabs').count(), 0);
        await page.screenshot({ path: new URL(`${profile.name}-${surface}-fallback.png`, out).pathname });
        await send(dock.getByRole('button', { name: 'Cancel', exact: true }), { id: `collision-${surface}`, cancelled: true });

        // Given omitted, explicit, and later omitted ids, when answered, then all keys survive.
        await deliver({ type: 'approval', id: `mixed-${surface}`, method: 'question', nonBlocking,
          questions: [{ header: 'First', options: [{ label: 'first answer' }] }, { id: 'q0', header: 'Second', options: [{ label: 'second answer' }] },
            { header: 'Third', options: [{ label: 'third answer' }] }] }, nonBlocking ? '.th-question-bar' : '.th-approval-dock');
        await pane.getByRole('button', { name: 'first answer', exact: true }).click();
        if (!nonBlocking) await dock.getByRole('tab', { name: 'Second', exact: true }).click();
        await pane.getByRole('button', { name: 'second answer', exact: true }).click();
        if (!nonBlocking) await dock.getByRole('tab', { name: 'Third', exact: true }).click();
        await page.screenshot({ path: new URL(`${profile.name}-${surface}-mixed.png`, out).pathname });
        const expected = { id: `mixed-${surface}`, answers: { q1: { selected: ['first answer'] }, q0: { selected: ['second answer'] }, q3: { selected: ['third answer'] } } };
        if (nonBlocking) await send(pane.getByRole('button', { name: 'third answer', exact: true }), expected);
        else {
          await pane.getByRole('button', { name: 'third answer', exact: true }).click();
          await send(dock.getByRole('button', { name: 'Submit', exact: true }), expected);
        }
      }
      // Given long multi-select choices, when selected, then Send is visible, hit-testable, and sends.
      await deliver({ type: 'approval', id: 'overflow', method: 'question', nonBlocking: true, questions: [
        { question: 'Choose deployment targets', multiSelect: true, options: [
          { label: 'Production deployment' }, { label: 'Staging environment' }, { label: 'Development preview' }] },
      ] }, '.th-question-bar');
      await pane.getByRole('button', { name: 'Production deployment', exact: true }).click();
      const geometry = await pane.locator('.th-question-bar-send').evaluate(button => {
        const rect = button.getBoundingClientRect(), bar = button.closest('.th-question-bar').getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { rect: rect.toJSON(), bar: bar.toJSON(), viewport: { width: innerWidth, height: innerHeight }, hit: hit === button || button.contains(hit) };
      });
      assert.ok(geometry.rect.width > 0 && geometry.rect.height > 0);
      assert.ok(geometry.rect.left >= geometry.bar.left && geometry.rect.right <= geometry.bar.right + 0.5);
      assert.ok(geometry.rect.top >= 0 && geometry.rect.bottom <= geometry.viewport.height);
      assert.ok(geometry.rect.right <= geometry.viewport.width && geometry.hit, JSON.stringify(geometry));
      await page.screenshot({ path: new URL(`${profile.name}-overflow.png`, out).pathname });
      await send(pane.locator('.th-question-bar-send'), { id: 'overflow', answers: { q1: { selected: ['Production deployment'] } } });
      assert.deepEqual(errors, []);
      results.push({ profile: profile.name, viewport: profile.viewport, columnHeight: height, geometry, errors, responses });
    } finally {
      await context.close(); receipts.push({ profile: profile.name, contextClosed: true, ...await fixture.stop() });
    }
  }
} finally {
  await browser.close();
  await writeFile(new URL('browser-results.json', out), JSON.stringify(results, null, 2));
  await writeFile(new URL('teardown.json', out), JSON.stringify({ browserClosed: true, fixtures: receipts }, null, 2));
}
console.log(JSON.stringify({ profilesPassed: results.map(result => result.profile), receipts }, null, 2));
