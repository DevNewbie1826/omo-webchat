/** P1/P2/P7: built SPA, disposable controlled fixtures, event-driven RED/GREEN. */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startFixture, models } from './pane-workspace-ui.mjs';
import { designSeed, installSignals, wheel } from './design-workbench-fixture.mjs';
import { transition } from './ui-composer-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const inventory = ['dark', 'light'].flatMap(theme => ['en', 'ko'].flatMap(lang => [13, 24].flatMap(fontSize => [
  ...[{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 800 },
    { width: 1280, height: 800, paneWidth: 340 }, { width: 1440, height: 900, paneWidth: 600 }]
    .map(v => ({ kind: 'status', ...v, theme, lang, fontSize })),
  ...[{ width: 1440, height: 900 }, { width: 1440, height: 900, layout: 'v4' }, { width: 1440, height: 150 },
    { width: 390, height: 844 }, { width: 844, height: 390 }]
    .map(v => ({ kind: 'picker', ...v, theme, lang, fontSize })),
])));

function statusGeometry() {
  const status = document.querySelector('.th-chat-status'), row = document.querySelector('.th-chat-controls');
  const rect = el => el?.getBoundingClientRect().toJSON();
  return { row: rect(row), model: rect(document.querySelector('.th-model-picker-btn')),
    capsule: rect(document.querySelector('.th-chat-input-inner')), pageWidth: document.documentElement.scrollWidth,
    viewport: innerWidth, details: !!status.querySelector('details,summary'), text: status.textContent,
    metrics: [...status.querySelectorAll('.th-chat-status-num')].map(el => ({ text: el.textContent,
      visible: el.checkVisibility(), rect: rect(el), item: rect(el.parentElement),
      clipped: el.parentElement.scrollWidth > el.parentElement.clientWidth,
      font: getComputedStyle(el).fontSize })),
    slot: rect(status.querySelector('[data-chat-run-state]')), state: status.querySelector('[data-chat-run-state]')?.dataset.chatRunState,
    label: status.querySelector('[data-chat-run-state]')?.getAttribute('aria-label'),
    title: status.querySelector('[data-chat-run-state]')?.title,
    spinners: status.querySelectorAll('.th-chat-status-spinner').length,
    spinnerColor: status.querySelector('.th-chat-status-spinner') && getComputedStyle(status.querySelector('.th-chat-status-spinner')).color,
  };
}
function pickerGeometry() {
  const popup = document.querySelector('.th-model-picker-popover'), list = popup.querySelector('.th-model-picker-list');
  const rect = el => el?.getBoundingClientRect().toJSON();
  return { popup: rect(popup), popupScroll: popup.scrollTop, popupClient: popup.clientHeight, popupHeight: popup.scrollHeight,
    list: rect(list), listScroll: list.scrollTop, listClient: list.clientHeight, listHeight: list.scrollHeight,
    sheet: popup.classList.contains('th-model-picker-popover--sheet'), panel: popup.classList.contains('th-model-picker-popover--panel'),
    dense: popup.classList.contains('th-model-picker-popover--dense'),
    chrome: ['.th-model-picker-current', '.th-thinking-in-picker', '.th-model-picker-search'].map(s => rect(popup.querySelector(s))),
    options: [...list.children].map(el => ({ rect: rect(el), text: el.textContent, selected: el.getAttribute('aria-selected') })),
    thinking: popup.querySelector('select') ? [...popup.querySelector('select').options].map(o => o.value)
      : [...popup.querySelectorAll('.th-thinking-level')].map(el => el.textContent),
    close: rect(popup.querySelector('.th-model-picker-current .th-btn-icon')),
    ancestorScroll: [...document.querySelectorAll('.th-chat-main,.th-chat-scrollport,.th-chat-pane')].map(el => [el.scrollTop, el.scrollLeft]),
  };
}
export async function run({ phase, out }) {
  if (!['red', 'green'].includes(phase) || !out || !out.startsWith('/')) throw new Error('Use --phase red|green --out ABSOLUTE_E');
  await mkdir(out, { recursive: true });
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
  const sourceFiles = [...new Set([...git('ls-files').split('\n'), 'test/qa/ui-followup-controls.mjs'])]
    .filter(p => /^(frontend\/src\/.*\.(tsx?|css)|test\/qa\/.*\.mjs|DESIGN.md)$/.test(p));
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p, hash(await readFile(p))])));
  const assets = Object.fromEntries(await Promise.all((await readdir('frontend/dist/assets')).map(async p => [p, hash(await readFile(`frontend/dist/assets/${p}`))])));
  const receipt = { phase, command: process.argv.join(' '), head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    dirty: git('status', '--short'), diffSha256: hash(git('diff', 'HEAD')), cwd: process.cwd(), driver: process.env.QA_PLAYWRIGHT,
    indexHtmlSha256: hash(await readFile('frontend/dist/index.html')), sources, assets, inventory, results: [], captures: [], cleanup: [] };
  await save('inputs.json', receipt);
  const { chromium } = await import(process.env.QA_PLAYWRIGHT);
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const [index, scenario] of inventory.entries()) {
      const name = `${String(index).padStart(2, '0')}-${scenario.kind}-${scenario.theme}-${scenario.lang}-f${scenario.fontSize}-${scenario.width}x${scenario.height}${scenario.paneWidth ? `-pane${scenario.paneWidth}` : scenario.layout ? `-${scenario.layout}` : ''}`;
      const result = { name, scenario, checks: [], errors: [], observations: {} };
      receipt.results.push(result);
      const check = (name, pass, data) => result.checks.push({ name, pass: !!pass, ...(data === undefined ? {} : { data }) });
      const fixture = startFixture({ ...designSeed(scenario.paneWidth ? 'two' : scenario.layout ?? 'single'), shelves: false,
        running: [], controlled: true, port: 0, runs: { 'stored-a': { entries: [],
          stats: { contextUsage: { tokens: 42, contextWindow: 100, percent: 42 }, tokens: { input: 30, cacheRead: 70, output: 5 } } } } });
      let context;
      const shot = async (page, state) => {
        const file = `${name}-${state}.png`, bytes = await page.screenshot({ path: resolve(out, file) });
        receipt.captures.push({ file, sha256: hash(bytes), scenario: name, state });
      };
      try {
        result.url = fixture.url; // Record port0 URL before navigation.
        await save('progress.json', receipt);
        context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
          colorScheme: scenario.theme, hasTouch: scenario.width === 390 });
        const page = await context.newPage(); page.setDefaultTimeout(8000);
        page.on('pageerror', e => result.errors.push(String(e)));
        await installSignals(page, scenario);
        const attached = fixture.wait('frame', f => f.type === 'chat.stats');
        await page.goto(fixture.url); await attached;
        await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-model-picker-label')?.textContent === 'Model A'
          && [...document.querySelectorAll('.th-chat-status-num')].some(n => n.textContent === '70%')));
        if (scenario.paneWidth) {
          const divider = await page.locator('.th-divider').boundingBox(), split = await page.locator('.th-split').boundingBox();
          const width = scenario.paneWidth;
          const persisted = fixture.wait('layout', l => l.kind === 'split' && Math.abs(l.ratio - width / (split.width - divider.width)) < .002);
          await transition(page, `() => Math.abs(document.querySelector('[data-pane-id="a"]').getBoundingClientRect().width - ${width}) < 1`, async () => {
            await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2); await page.mouse.down();
            await page.mouse.move(split.x + width + divider.width / 2, divider.y + divider.height / 2); await page.mouse.up();
          }); await persisted;
        }
        if (scenario.kind === 'status') {
          const before = await page.evaluate(statusGeometry); result.observations.idle = before;
          check('metrics-visible-at-rest', !before.details && before.metrics.length === 2 && before.metrics.every(m => m.visible && !m.clipped));
          check('model-right-and-no-page-overflow', Math.abs(before.model.right - before.capsule.right) <= 2 && before.pageWidth <= before.viewport);
          check('whole-items-contained', before.metrics.every(m => m.item.left >= before.row.left && m.item.right <= before.model.left && m.item.bottom <= before.row.bottom));
          await shot(page, 'idle');
          const draft = page.locator('.th-chat-input textarea'); await draft.fill('preserved unsent draft');
          await transition(page, () => !!document.querySelector('.th-chat-status-item--live'), async () => fixture.deliver('stored-a', { type: 'run.started' }));
          const running = await page.evaluate(statusGeometry); result.observations.running = running;
          check('one-accessible-wordless-running-slot', running.state === 'responding' && running.spinners === 1 && !!running.label && running.label === running.title && !running.text.includes(running.label));
          await shot(page, 'running');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          check('reduced-motion-static-ring', await page.locator('.th-chat-status-spinner').evaluate(el => getComputedStyle(el).animationName === 'none' || parseFloat(getComputedStyle(el).animationDuration) <= .001));
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          const reattached = fixture.wait('subscription', e => e.action === 'attach' && e.sessionId === 'stored-a');
          const disconnected = page.evaluate(() => window.qaSignal(() => !!document.querySelector('[data-chat-run-state="reconnecting"]')
            || [...document.querySelectorAll('.th-chat-status-item--warn')].some(el => /Reconnecting|재연결/.test(el.textContent))).then(() => ({
              state: document.querySelector('[data-chat-run-state]')?.dataset.chatRunState,
              spinners: document.querySelectorAll('.th-chat-status-spinner').length,
              label: document.querySelector('[data-chat-run-state]')?.getAttribute('aria-label'),
              color: document.querySelector('.th-chat-status-spinner') && getComputedStyle(document.querySelector('.th-chat-status-spinner')).color,
            })));
          fixture.disconnect('stored-a');
          const offline = await disconnected; await reattached;
          result.observations.disconnected = offline;
          check('transport-reconnect-priority', offline.state === 'reconnecting' && offline.spinners === 1 && !!offline.label && offline.color !== running.spinnerColor);
          await page.evaluate(() => window.qaSignal(() => !document.querySelector('[data-chat-run-state="reconnecting"]') && !!document.querySelector('.th-chat-status-item--live')));
          check('draft-survives-transport', await draft.inputValue() === 'preserved unsent draft');
          const after = await page.evaluate(statusGeometry);
          check('stable-slot-metrics-model', before.slot && running.slot && Math.abs(before.model.left - running.model.left) <= 1 && Math.abs(before.metrics[0].rect.left - running.metrics[0].rect.left) <= 1 && Math.abs(after.model.left - running.model.left) <= 1);
          await transition(page, () => [...document.querySelectorAll('.th-chat-status-num')].every(el => el.textContent === '0%'), async () => fixture.deliver('stored-a', { type: 'stats', contextUsage: { tokens: 0, contextWindow: 100, percent: 0 }, tokens: { input: 30, cacheRead: 0, output: 0 } }));
          check('zero-metrics-visible', (await page.evaluate(statusGeometry)).metrics.every(m => m.text === '0%' && m.visible));
        } else {
          const trigger = page.locator('.th-model-picker-btn');
          await trigger.evaluate(el => el.focus({ preventScroll: true }));
          await transition(page, () => !!document.querySelector('.th-model-picker-popover'), () => page.keyboard.press('Enter'));
          const initial = await page.evaluate(pickerGeometry); result.observations.initial = initial;
          check('53-models-seven-thinking-levels', initial.options.length === 53 && initial.thinking.length === 7);
          check('viewport-contained', initial.popup.top >= 0 && initial.popup.bottom <= scenario.height + 1 && initial.popup.left >= 0 && initial.popup.right <= scenario.width);
          await shot(page, 'open');
          if (!initial.sheet) {
            check('fixed-chrome-and-whole-option', initial.popupHeight <= initial.popupClient + 1 && initial.chrome.every(r => r.top >= initial.popup.top && r.bottom <= initial.list.top + 1)
              && initial.options.some(o => o.rect.top >= initial.list.top && o.rect.bottom <= initial.list.bottom));
            if (scenario.layout || scenario.height === 150) check('short-pane-desktop-panel', initial.panel);
            const owner = initial.popupHeight > initial.popupClient + 1 ? page.locator('.th-model-picker-popover') : page.locator('.th-model-picker-list');
            await wheel(page, owner, 500, true);
            const scrolled = await page.evaluate(pickerGeometry); result.observations.scrolled = scrolled;
            check('list-only-wheel-fixed-chrome', scrolled.listScroll > initial.listScroll && scrolled.popupScroll === 0
              && scrolled.chrome.every((r, i) => Math.abs(r.top - initial.chrome[i].top) <= 1)
              && JSON.stringify(scrolled.ancestorScroll) === JSON.stringify(initial.ancestorScroll));
            const search = page.locator('.th-model-picker-search');
            await search.focus();
            // First active key is the current model; wheel over list gutter does not change it.
            await transition(page, () => document.querySelector('.th-model-picker-search').getAttribute('aria-activedescendant') === document.querySelector('[role="option"]:last-child').id,
              () => page.keyboard.press('ArrowUp'));
            const navigated = await page.evaluate(pickerGeometry); result.observations.navigated = navigated;
            const last = navigated.options.at(-1).rect;
            check('keyboard-list-owned-last-reveal', last.top >= navigated.list.top && last.bottom <= navigated.list.bottom + 1 && navigated.popupScroll === 0
              && navigated.chrome.every((r, i) => Math.abs(r.top - initial.chrome[i].top) <= 1));
            await shot(page, 'last');
            await search.fill('provider-b');
            const selected = fixture.wait('frame', f => f.type === 'chat.set' && !!f.model);
            await transition(page, () => !document.querySelector('.th-model-picker-popover'), () => page.keyboard.press('Enter'));
            const frame = await selected;
            check('query-exact-selection', frame.model.provider === 'provider-b' && frame.model.modelId === 'model-b');
            check('selection-focus-restored', await trigger.evaluate(el => document.activeElement === el));
            await transition(page, () => !!document.querySelector('.th-model-picker-popover'), () => page.keyboard.press('Enter'));
            const thinking = fixture.wait('frame', f => f.type === 'chat.set' && f.thinkingLevel === 'max');
            if (await page.locator('.th-thinking-in-picker select').count()) await page.locator('.th-thinking-in-picker select').selectOption('max');
            else await page.locator('.th-thinking-level').filter({ hasText: /^max$/ }).click();
            await thinking;
            await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-model-picker-thinking')?.textContent === 'max'));
            check('thinking-confirmed', true);
            await page.keyboard.press('Escape');
            check('escape-focus-restored', await trigger.evaluate(el => document.activeElement === el) && await page.locator('.th-model-picker-popover').count() === 0);
          } else {
            check('mobile-close-44px', initial.close.width >= 44 && initial.close.height >= 44);
            await page.locator('.th-model-picker-current .th-btn-icon').click();
            check('mobile-close-focus', await trigger.evaluate(el => document.activeElement === el) && await page.locator('.th-model-picker-popover').count() === 0);
          }
        }
        check('no-page-errors', result.errors.length === 0, result.errors);
        check('no-unexpected-requests', fixture.unexpected.length === 0, fixture.unexpected);
      } catch (error) {
        result.errors.push(String(error)); check('scenario-completed', false, String(error));
      } finally {
        if (context) await context.close();
        receipt.cleanup.push({ name, contextClosed: !!context, url: fixture.url, ...await fixture.stop() });
        await save(`${name}-traffic.json`, fixture.traffic);
      }
      await save('results.json', receipt);
    }
  } finally {
    if (browser) await browser.close();
    receipt.browserClosed = !browser?.isConnected();
    receipt.pass = receipt.results.length === inventory.length && receipt.results.every(r => r.checks.every(c => c.pass) && !r.errors.length);
    receipt.failed = receipt.results.flatMap(r => r.checks.filter(c => !c.pass).map(c => ({ scenario: r.name, ...c })));
    await save('results.json', receipt);
  }
  console.log(JSON.stringify({ phase, pass: receipt.pass, scenarios: receipt.results.length, failures: receipt.failed, out }, null, 2));
  return receipt;
}
if (import.meta.main) {
  const value = key => process.argv[process.argv.indexOf(key) + 1];
  const receipt = await run({ phase: value('--phase'), out: value('--out') });
  process.exitCode = receipt.pass ? 0 : 1;
}
