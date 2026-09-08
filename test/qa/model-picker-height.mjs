/** Real built-App Chrome height regression. Build frontend first, then:
 * QA_PLAYWRIGHT=/installed/playwright-core/index.mjs bun test/qa/model-picker-height.mjs EVIDENCE
 * QA_ASSETS optionally selects a preserved build; default is frontend/dist.
 * Failures remain failures (exit 1), including during pre-change capture.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startFixture, models, layouts } from './pane-workspace-ui.mjs';
import { installSignals, wheel } from './design-workbench-fixture.mjs';
import { transition } from './ui-composer-fixture.mjs';
import { installControlSignals, confirmControl } from './model-control-confirmation.mjs';

const selectors = { trigger: '[data-pane-id="a"] .th-model-picker-btn',
  mobileTrigger: '.th-chat-pane .th-model-picker-btn',
  popup: '.th-model-picker-popover', list: '.th-model-picker-list',
  options: '.th-model-picker-list [role="option"]' };
const cases = [
  { name: 'desktop-1440x900', width: 1440, height: 900, heightGoal: true },
  { name: 'desktop-1280x800', width: 1280, height: 800, heightGoal: true },
  { name: 'short-1280x600', width: 1280, height: 600 },
  { name: 'vertical-v3-1280x700', width: 1280, height: 700, layout: layouts.v3, panel: true },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
];
const entries = Array.from({ length: 40 }, (_, i) => ({ id: `height-${i}`, parentId: i ? `height-${i - 1}` : null,
  type: 'message', message: { role: i % 2 ? 'assistant' : 'user', content: `Transcript turn ${i}. ${'Readable conversation history. '.repeat(24)}` } }));

function geometry() {
  const pane = document.querySelector('[data-pane-id="a"], .th-chat-pane');
  const popup = document.querySelector('.th-model-picker-popover');
  const list = popup?.querySelector('.th-model-picker-list');
  const rect = element => element?.getBoundingClientRect().toJSON() ?? null;
  const bounds = rect(list);
  const rows = list ? [...list.querySelectorAll('[role="option"]')].map(element => {
    const box = rect(element), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { rect: box, complete: box.top >= bounds.top && box.bottom <= bounds.top + list.clientHeight,
      hit: hit === element || element.contains(hit) };
  }) : [];
  return { popup: rect(popup), panel: popup?.classList.contains('th-model-picker-popover--panel') ?? false,
    sheet: popup?.classList.contains('th-model-picker-popover--sheet') ?? false,
    list: bounds, listClientHeight: list?.clientHeight, listScroll: list?.scrollTop, popupScroll: popup?.scrollTop,
    chrome: popup && [...popup.children].filter(element => element !== list).map(rect), rows,
    fullyVisibleRows: rows.filter(row => row.complete && row.hit).length,
    column: rect(pane.querySelector('.th-chat-main')), composer: rect(pane.querySelector('.th-chat-input')),
    trigger: rect(pane.querySelector('.th-model-picker-btn')),
    ancestors: [...pane.querySelectorAll('.th-chat-main,.th-chat-scrollport,.th-chat-body')].map(element => ({
      className: element.className, top: element.scrollTop, left: element.scrollLeft,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight })),
    documentWidth: document.documentElement.scrollWidth, viewport: { width: innerWidth, height: innerHeight } };
}

export async function run(evidence) {
  await mkdir(evidence, { recursive: true });
  const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + '\n');
  const results = [], cleanup = [], screenshots = [];
  await save('invocation.json', { cwd: process.cwd(), argv: process.argv, selectors, cases,
    driver: process.env.QA_PLAYWRIGHT, assets: process.env.QA_ASSETS ?? resolve(import.meta.dir, '../../frontend/dist'),
    modelCount: models.length, transcriptEntries: entries.length });
  let server, browser;
  try {
    const { chromium } = await import(process.env.QA_PLAYWRIGHT);
    server = await chromium.launchServer({ channel: 'chrome', headless: true });
    browser = await chromium.connect(server.wsEndpoint());
    await save('runtime.json', { browser: browser.version(), pid: server.process().pid, bun: Bun.version });
    for (const scenario of cases) {
      const checks = [], errors = [], receipt = { scenario: scenario.name, checks, errors };
      const check = (name, action) => {
        try { action(); checks.push({ name, pass: true }); }
        catch (error) { checks.push({ name, pass: false, error: String(error), stack: error.stack }); }
      };
      const fixture = startFixture({ port: 0, controlled: true, assetsDir: process.env.QA_ASSETS,
        layout: scenario.layout ?? layouts.single, runs: { 'stored-a': { entries } } });
      let context;
      try {
        // Given a hydrated long transcript and 53 real model options.
        context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
          isMobile: scenario.mobile ?? false, hasTouch: scenario.mobile ?? false, colorScheme: 'dark' });
        const page = await context.newPage(); page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(String(error)));
        await installSignals(page); await installControlSignals(page);
        const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
        await page.goto(fixture.url); await attached;
        await page.evaluate(() => window.qaSignal(() => {
          const pane = document.querySelector('[data-pane-id="a"], .th-chat-pane');
          const scroll = pane?.querySelector('.th-chat-body');
          return pane?.querySelector('.th-model-picker-thinking')?.textContent === 'low'
            && scroll && scroll.scrollHeight > scroll.clientHeight;
        }));
        await page.evaluate(() => document.fonts.ready);
        const shot = async state => {
          const name = `${scenario.name}-${state}.png`;
          await page.screenshot({ path: resolve(evidence, name) }); screenshots.push(name);
        };
        receipt.before = await page.evaluate(geometry); await shot('closed');
        // When the actual composer model trigger is clicked.
        await transition(page, () => !!document.querySelector('.th-model-picker-list [role="option"]'),
          () => page.locator(scenario.mobile ? selectors.mobileTrigger : selectors.trigger).click());
        receipt.opened = await page.evaluate(geometry); await shot('open');
        const opened = receipt.opened;
        check('53 options rendered', () => assert.equal(opened.rows.length, 53));
        check('placement and containment', () => {
          assert.equal(opened.sheet, scenario.mobile ?? false); assert.equal(opened.panel, scenario.panel ?? false);
          assert(opened.popup.top >= 0 && opened.popup.bottom <= scenario.height);
          assert(opened.popup.left >= 0 && opened.popup.right <= scenario.width);
          assert.equal(opened.documentWidth, scenario.width); assert(opened.fullyVisibleRows >= 1);
          if (!opened.sheet) assert.equal(opened.popup.width, 260);
          if (!opened.sheet && !opened.panel) {
            assert(opened.popup.top >= opened.column.top); assert(opened.popup.bottom <= opened.trigger.top);
          }
        });
        if (scenario.heightGoal) {
          check('desktop list.clientHeight >= 250', () => assert(opened.listClientHeight >= 250,
            `list.clientHeight=${opened.listClientHeight}, expected >=250`));
          check('desktop >=5 fully visible option rows', () => assert(opened.fullyVisibleRows >= 5,
            `fullyVisibleRows=${opened.fullyVisibleRows}, expected >=5`));
        }
        // Then scrolling remains list-owned and a real last-row click is confirmed by the App.
        await wheel(page, page.locator(selectors.list), 10000, true);
        receipt.scrolled = await page.evaluate(geometry); await shot('scrolled');
        const bottom = receipt.scrolled;
        check('last row reachable without moving popup chrome or composer', () => {
          assert(bottom.rows.at(-1).complete && bottom.rows.at(-1).hit);
          assert(bottom.listScroll > opened.listScroll); assert.equal(bottom.popupScroll, 0);
          assert.deepEqual(bottom.chrome, opened.chrome); assert.deepEqual(bottom.composer, receipt.before.composer);
          assert.deepEqual(bottom.ancestors, opened.ancestors);
        });
        receipt.selection = await confirmControl(page, fixture, { model: { provider: 'long-provider', modelId: 'long-49' } },
          () => transition(page, () => !document.querySelector('.th-model-picker-popover'),
            () => page.locator(selectors.options).last().click()));
        check('selection persisted in session', () => assert.deepEqual(fixture.runState('stored-a').model,
          { provider: 'long-provider', modelId: 'long-49' }));
        await shot('selected');
        check('no browser errors or unexpected traffic', () => { assert.deepEqual(errors, []); assert.deepEqual(fixture.unexpected, []); });
      } catch (error) { checks.push({ name: 'scenario execution', pass: false, error: String(error), stack: error.stack }); }
      finally {
        try { if (context) await context.close(); }
        finally { cleanup.push({ scenario: scenario.name, contextClosed: !!context, url: fixture.url, ...await fixture.stop() }); }
        await save(`${scenario.name}-traffic.json`, { frames: fixture.frames, unexpected: fixture.unexpected });
        receipt.pass = checks.every(check => check.pass); results.push(receipt);
        await save(`${scenario.name}-geometry.json`, receipt);
      }
    }
  } catch (error) { results.push({ scenario: 'runner', pass: false, error: String(error), stack: error.stack }); }
  finally {
    try { if (browser) await browser.close(); }
    finally {
      if (server) { await server.close(); cleanup.push({ chromeClosed: !browser?.isConnected(), pid: server.process().pid,
        exitCode: server.process().exitCode, signalCode: server.process().signalCode }); }
      await save('cleanup.json', cleanup); await save('results.json', results); await save('screenshots.json', screenshots);
    }
  }
  console.log(JSON.stringify(results.map(({ scenario, pass, checks }) => ({ scenario, pass, checks })), null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
}
if (import.meta.main) await run(resolve(process.argv[2]));
