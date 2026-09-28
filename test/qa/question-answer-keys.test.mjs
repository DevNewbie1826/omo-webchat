/** Answer-key identity for structured questions, migrated from the old
 * standalone test/qa/question-answer-keys.mjs (which is RED today: it
 * required QA_PLAYWRIGHT + /Applications/Google Chrome.app and waited on
 * `.th-question-bar`, a surface nothing renders since the parity rework).
 *
 * Same assertions, modern harness: real Chromium through test/qa/qa-driver.mjs
 * against the pane-workspace-ui fixture (actual HTTP/WS + built SPA), with
 * band/window selectors. The colliding-keys case keeps the original
 * expectation — a strictly-unparseable request still lands as the minimal
 * CANCELLABLE fallback window (chatWsParse.ts "never dropped";
 * chatWsParseApproval rejects ambiguous keys so no structured answer can be
 * keyed wrongly — plan IS-1/IS-4) — only its selectors moved from the old
 * dock/QuestionBar to the window.
 *
 * Run: bun test --isolate test/qa/question-answer-keys.test.mjs (never
 * --parallel).
 */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { qaDriverSkipOption, resolveQaDriver } from './qa-driver.mjs';

const qaDriver = await resolveQaDriver();
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSION = 'stored-a';

test('question answer keys survive omitted, explicit and colliding ids across surfaces',
  { timeout: 120_000, ...qaDriverSkipOption(qaDriver) },
  async () => {
    const { chromium } = await import(qaDriver.entry);
    const { startFixture } = await import('./pane-workspace-ui.mjs');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      for (const profile of [
        { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
        { name: 'laptop', viewport: { width: 1280, height: 800 }, touch: false },
      ]) {
        const fixture = startFixture({ port: 0, layout: 'single', controlled: true });
        const context = await browser.newContext({
          viewport: profile.viewport, hasTouch: profile.touch, isMobile: profile.touch,
          locale: 'ko-KR', colorScheme: 'dark',
        });
        await context.addInitScript(() => {
          localStorage.setItem('th-theme', 'dark');
          localStorage.setItem('th-lang', 'ko');
        });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        try {
          const created = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === SESSION);
          await page.goto(fixture.url);
          await created;
          await page.waitForFunction(`() => !!document.querySelector('.th-chat-pane .th-chat-input textarea')`, undefined, { timeout: 20_000 });
          const pane = page.locator('.th-chat-pane');
          const deliver = async (frame, predicate) => {
            fixture.deliver(SESSION, frame);
            await page.waitForFunction(predicate, undefined, { timeout: 20_000 });
          };
          const send = async (action, expected, mark) => {
            const pending = fixture.wait('frame', frame => frame.type === 'approval.respond');
            await action();
            const frame = await pending;
            const { type, sessionId, requestId, ...payload } = frame;
            assert.equal(type, 'approval.respond');
            assert.equal(sessionId, SESSION);
            assert.equal(typeof requestId, 'string');
            assert.deepEqual(payload, expected, `${profile.name} ${mark}`);
          };

          // Given effective keys that collide (q1 from the omitted id and the
          // explicit q1), when delivered, then only a cancellable fallback
          // renders — the strict parser rejects the ambiguous shape and the
          // safety net lands the minimal fallback (unchanged contract).
          await deliver({
            type: 'approval', id: 'collision', method: 'question', title: '충돌 요청', nonBlocking: true,
            questions: [
              { question: '첫째', options: [{ label: 'first answer' }] },
              { id: 'q1', question: '둘째', options: [{ label: 'second answer' }] },
            ],
          }, `() => !!document.querySelector('.th-question-window')`);
          assert.equal(await page.locator('.th-question-window-title').count(), 1);
          assert.ok((await page.locator('.th-question-window-title').textContent()).includes('충돌 요청'));
          assert.equal(await page.locator('.th-question-window .th-approval-fallback-note').count(), 1,
            `${profile.name}: the unsupported-request note renders`);
          assert.equal(await page.locator('.th-question-window .th-approval-options').count(), 0,
            `${profile.name}: no structured options for ambiguous keys`);
          assert.equal(await page.locator('.th-approval-question-tabs').count(), 0);
          await page.screenshot({ path: new URL(`../../.omo/evidence/question-omo-parity/qa/keys-${profile.name}-collision.png`, import.meta.url).pathname });
          await send(
            () => page.locator('.th-question-window .th-approval-form').getByRole('button', { name: '취소', exact: true }).click(),
            { id: 'collision', cancelled: true }, 'collision cancel');
          await page.waitForFunction(`() => !document.querySelector('.th-question-window')`, undefined, { timeout: 20_000 });

          // Given omitted, explicit, and later omitted ids, when answered, then all keys survive.
          for (const nonBlocking of [true, false]) {
            const surface = nonBlocking ? 'band' : 'window';
            const frame = {
              type: 'approval', id: `mixed-${surface}`, method: 'question', title: `혼합 ${surface}`, nonBlocking,
              questions: [
                { header: 'First', options: [{ label: 'first answer' }] },
                { id: 'q0', header: 'Second', options: [{ label: 'second answer' }] },
                { header: 'Third', options: [{ label: 'third answer' }] },
              ],
            };
            await deliver(frame, nonBlocking
              ? `() => !!document.querySelector('.th-question-band')`
              : `() => !!document.querySelector('.th-question-window')`);
            if (nonBlocking) {
              await page.locator('.th-question-band-open').click();
              await page.waitForFunction(`() => !!document.querySelector('.th-question-window')`, undefined, { timeout: 20_000 });
            }
            const window = page.locator('.th-question-window');
            await window.getByRole('button', { name: 'first answer', exact: true }).click();
            await window.locator('[role="tab"]').nth(1).click();
            await window.getByRole('button', { name: 'second answer', exact: true }).click();
            await window.locator('[role="tab"]').nth(2).click();
            await page.screenshot({ path: new URL(`../../.omo/evidence/question-omo-parity/qa/keys-${profile.name}-${surface}-mixed.png`, import.meta.url).pathname });
            await window.getByRole('button', { name: 'third answer', exact: true }).click();
            await send(() => page.locator('.th-question-window .th-btn--primary').click(), {
              id: `mixed-${surface}`,
              answers: { q1: { selected: ['first answer'] }, q0: { selected: ['second answer'] }, q3: { selected: ['third answer'] } },
            }, `mixed ${surface}`);
            // IS-6: the question only leaves on approval.resolved — resolve
            // it so the next surface starts from a clean pane.
            await deliver({ type: 'approval.resolved', id: `mixed-${surface}`, outcome: 'answered' },
              `() => !document.querySelector('.th-question-window') && !document.querySelector('.th-question-band')`);
          }

          // Given long multi-select choices, when selected, then Send is visible, hit-testable, and sends.
          await deliver({
            type: 'approval', id: 'overflow', method: 'question', title: '배포 대상', nonBlocking: false,
            questions: [{
              question: '배포 대상을 고르세요', multiSelect: true,
              options: [{ label: 'Production deployment' }, { label: 'Staging environment' }, { label: 'Development preview' }],
            }],
          }, `() => !!document.querySelector('.th-question-window')`);
          await page.locator('.th-question-window').getByRole('button', { name: 'Production deployment', exact: true }).click();
          const geometry = await page.locator('.th-question-window .th-btn--primary').evaluate(button => {
            const rect = button.getBoundingClientRect();
            const bar = button.closest('.th-question-window').getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { rect: rect.toJSON(), bar: bar.toJSON(), viewport: { width: innerWidth, height: innerHeight }, hit: hit === button || button.contains(hit) };
          });
          assert.ok(geometry.rect.width > 0 && geometry.rect.height > 0);
          assert.ok(geometry.rect.left >= geometry.bar.left && geometry.rect.right <= geometry.bar.right + 0.5);
          assert.ok(geometry.rect.top >= 0 && geometry.rect.bottom <= geometry.viewport.height);
          assert.ok(geometry.rect.right <= geometry.viewport.width && geometry.hit, JSON.stringify(geometry));
          await page.screenshot({ path: new URL(`../../.omo/evidence/question-omo-parity/qa/keys-${profile.name}-overflow.png`, import.meta.url).pathname });
          await send(() => page.locator('.th-question-window .th-btn--primary').click(), {
            id: 'overflow', answers: { q1: { selected: ['Production deployment'] } },
          }, 'overflow');
          await deliver({ type: 'approval.resolved', id: 'overflow', outcome: 'answered' },
            `() => !document.querySelector('.th-question-window') && !document.querySelector('.th-question-band')`);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
          const cleanup = await fixture.stop();
          assert.equal(cleanup.pendingWebSockets, 0);
        }
      }
    } finally {
      await browser.close();
    }
  });
