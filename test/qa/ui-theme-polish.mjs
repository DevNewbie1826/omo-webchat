/** QA_PLAYWRIGHT=<installed-driver> bun test/qa/ui-theme-polish.mjs --phase red|green --out ABSOLUTE_PATH
 *
 * Theme reference harness (brief C2). Boots the real built App through
 * an idle controlled fixture, toggles dark/light through the actual Settings theme radio
 * group, and samples the semantic surfaces the authenticated Codex desktop
 * reference measured (canvas, sidebar, composer, tool shell, model
 * menu, highlighted menu row, primary action and text). Surface fills are read:
 * as resolved computed style tokens and as real screenshot pixels decoded by
 * the browser itself. No DOM/style substitution and no synthetic pages.
 *
 * --phase red   succeeds only while the current build still MISSES the
 *               reference surfaces (baseline mismatch proof).
 * --phase green succeeds only when every sampled surface matches the recorded
 *               reference within rounding in both themes.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { designSeed, installSignals, seedLive, arm, complete } from './design-workbench-fixture.mjs';
import { startFixture } from './pane-workspace-ui.mjs';
import { captureFrame, closeResources, exposeTranscript, judgeFill, missingSurfaces, near, parseComputedColor, settleFrame } from './ui-theme-evidence.mjs';

/** Measured authenticated reference (authenticated-pixel-measurements.json
 *  plus the report's computed foreground values), CSS 0-255 samples. The tool
 *  shell maps to the scoped tool material (P4): dark reuses the measured
 *  elevated-chrome fill; light is an app-specific requested distinction (a
 *  lightly gray step off the white Canvas), not a measured native value. */
const REFERENCE = {
  dark: {
    canvas: [24, 24, 24], sidebar: [40, 40, 40], composer: [42, 42, 42],
    toolShell: [40, 40, 40], menu: [45, 45, 45], highlightedRow: [61, 61, 61],
    text: [223, 223, 223], send: [223, 223, 223],
  },
  light: {
    canvas: [255, 255, 255], sidebar: [255, 255, 255], composer: [255, 255, 255],
    toolShell: [245, 246, 247], menu: [255, 255, 255], highlightedRow: [242, 243, 243],
    text: [26, 28, 31], send: [26, 28, 31],
  },
};

const SCENARIOS = [
  { width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 },
  { width: 1280, height: 800, paneWidth: 600 }, { width: 1280, height: 800, paneWidth: 340 },
];

/** Runs in the page: picks candidate points whose elementFromPoint chain up to
 *  the target paints only transparent intermediates, then samples those points
 *  from the browser-decoded viewport screenshot stored in window.themePixels. */
function pageHelpers() {
  const transparentThrough = (target, x, y) => {
    let node = document.elementFromPoint(x, y);
    if (!node) return false;
    while (node && node !== target) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !bg.startsWith('rgba(0, 0, 0, 0')) return false;
      node = node.parentElement;
    }
    return node === target;
  };
  window.themeSample = selector => {
    const el = document.querySelector(selector);
    if (!el) return { selector, present: false };
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const points = [];
    const push = (x, y) => {
      if (points.length >= 4 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
      if (!transparentThrough(el, x, y)) return;
      const pixels = window.themePixels;
      const sx = Math.min(pixels.width - 1, Math.round(x * pixels.scale));
      const sy = Math.min(pixels.height - 1, Math.round(y * pixels.scale));
      const i = (sy * pixels.width + sx) * 4;
      points.push({ x, y, rgb: [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]] });
    };
    for (let d = 5; d <= 29; d += 6) {
      push(rect.x + d, rect.y + d);
      push(rect.x + rect.width - d, rect.y + d);
      push(rect.x + d, rect.y + rect.height - d);
      push(rect.x + rect.width - d, rect.y + rect.height - d);
      push(rect.x + rect.width / 2, rect.y + d);
      push(rect.x + rect.width / 2, rect.y + rect.height - d);
    }
    // Full-bleed surfaces (body canvas) are covered at every corner by opaque
    // chrome; the transcript's reading-column margins are the honest fill.
    for (const fraction of [0.3, 0.45, 0.6, 0.75]) {
      push(rect.right - 6, rect.top + rect.height * fraction);
      push(rect.right - 26, rect.top + rect.height * fraction);
    }
    // Tall tool bodies may be clipped, but an exposed transparent header
    // still paints the shell. Sample inside the visible intersection, not
    // exclusively corners of the full offscreen body.
    for (const y of [Math.max(0, rect.top) + 8, Math.max(0, rect.top) + 20, Math.max(0, rect.top) + 36]) {
      for (const x of [rect.left + 8, rect.right - 8, rect.left + rect.width / 2]) push(x, y);
    }
    const cx = Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2;
    const cy = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      selector, present: true, computed: style.backgroundColor, boxShadow: style.boxShadow,
      color: style.color, borderColor: style.borderColor, borderStyle: style.borderStyle, borderWidth: style.borderWidth,
      opacity: style.opacity, cursor: style.cursor, outlineColor: style.outlineColor, outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth, disabled: el.disabled, type: el.type,
      glyphColor: el.querySelector('svg') ? getComputedStyle(el.querySelector('svg')).color : null,
      exposed: !!hit && (el === hit || el.contains(hit)),
      tokens: Object.fromEntries(['send', 'send-hover', 'send-fg', 'error', 'error-fg', 'success', 'warning', 'disabled-bg', 'disabled-fg']
        .map(name => [name, style.getPropertyValue(`--th-${name}`).trim()])),
      visible: rect.width > 0 && rect.height > 0,
      onScreen: rect.right > 0 && rect.bottom > 0 && rect.x < innerWidth && rect.y < innerHeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      samples: points,
    };
  };
}

/** Decodes a viewport PNG inside the page for window.themeSample. */
async function loadPixels(page, shot) {
  await page.evaluate(async dataUrl => {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    window.themePixels = {
      data: frame.data, width: frame.width, height: frame.height,
      scale: frame.width / innerWidth,
    };
  }, `data:image/png;base64,${shot.toString('base64')}`);
}

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), '--phase must be red or green');
  assert(driver, 'QA_PLAYWRIGHT must identify an existing installed driver');
  out = resolve(out);
  await mkdir(out, { recursive: true });
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
  const receipt = {
    phase, out, driver, cwd: process.cwd(),
    sha: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    tree: Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}']).stdout.toString().trim(),
    dirty: Bun.spawnSync(['git', 'status', '--porcelain']).stdout.toString(),
    command: `QA_PLAYWRIGHT=${driver} bun test/qa/ui-theme-polish.mjs --phase ${phase} --out ${out}`,
  };
  const screenshots = [], actions = [], results = [], resources = [], sessions = [], failures = [];
  const SURFACES = {
    canvas: '.th-chat-pane', sidebar: '.th-sidebar', composer: '.th-chat-input-inner',
    send: '.th-chat-send-btn', menu: '.th-model-picker-popover',
    highlightedRow: '.th-model-picker-list > button[data-active="true"]',
  };
  let browser, mismatches;
  try {
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browserVersion = browser.version();
    for (const { paneWidth, ...viewport } of SCENARIOS) {
      const label = `${viewport.width}x${viewport.height}${paneWidth ? `-pane${paneWidth}` : ''}`;
      // Actual split layout, not CSS/DOM substitution. 264px sidebar + 4px divider.
      const layout = paneWidth ? { kind: 'split', id: 'root', dir: 'h', ratio: paneWidth / (1280 - 264 - 4),
        first: { kind: 'leaf', id: 'a', sessionId: 'stored-a' }, second: { kind: 'leaf', id: 'b', sessionId: null } } : 'single';
      const seed = designSeed(layout);
      seed.running = [];
      seed.runs['stored-a'].queue = { revision: 1, items: [], engine: { pendingMessageCount: 0, ordered: [] } };
      const fixture = startFixture({ ...seed, controlled: true, port: 0 });
      const fixtureResource = { name: `${label}/fixture`, close: () => fixture.stop() };
      resources.push(fixtureResource);
      const context = await browser.newContext({ viewport, colorScheme: 'light' });
      resources.splice(resources.indexOf(fixtureResource), 0, { name: `${label}/context`, close: async () => {
        await context.close(); return { contextClosed: true, url: fixture.url };
      } });
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      const errors = []; page.on('pageerror', error => errors.push(String(error)));
      const q = { page, fixture, errors }; sessions.push({ label, ...q });
      await installSignals(page, { theme: 'light' });
      console.log(`WORKING: ${label} actual SPA ${fixture.url}`);
      actions.push({ scenario: label, action: 'idle controlled fixture navigation', url: fixture.url });
      const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
      await page.goto(fixture.url); await attached;
      await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-activity-bar')
        && document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
        && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
      await page.evaluate(pageHelpers);
      const pane = await page.locator('.th-chat-pane').boundingBox();
      if (paneWidth) assert(Math.abs(pane.width - paneWidth) <= 2, `${label}: actual pane width ${pane.width}`);
      actions.push({ scenario: label, action: 'actual pane geometry', pane });

      for (const theme of ['dark', 'light']) {
        const log = (action, detail = {}) => actions.push({ scenario: label, theme, action, ...detail });
        const shoot = async (name, selectors) => {
          const frame = await captureFrame({ page, path: resolve(out, `c2-${phase}-${label}-${theme}-${name}.png`),
            settle: () => page.evaluate(settleFrame), decode: loadPixels, actions: actions.filter(row => row.scenario === label),
            measure: () => page.evaluate(selectors => Object.fromEntries(Object.entries(selectors)
              .map(([name, selector]) => [name, window.themeSample(selector)])), selectors) });
          screenshots.push(frame);
          return frame.geometry;
        };
        const scroll = async selector => {
          await page.mouse.move(viewport.width / 2, 6);
          await page.evaluate(settleFrame);
          log('scroll actual transcript to expose target', await page.evaluate(exposeTranscript, selector));
        };
        const change = async (predicate, action) => { await arm(page, predicate); await action(); await complete(page); };
        const painted = sample => ({ ...sample, matches: sample.present === true && sample.visible && sample.onScreen && sample.exposed });
        const mobile = viewport.width <= 768;
        if (mobile) {
          log('open mobile sidebar through header menu');
          await change(() => !document.querySelector('.th-sidebar--collapsed'), () => page.locator('.th-mobile-menu').click());
        }
        log('open actual Settings');
        await change(() => !!document.querySelector('.th-settings-panel'), () => page.click('.th-settings-menu .th-btn-icon'));
        // Both themes are selected through the actual control, including Dark.
        await arm(page, theme === 'dark'
          ? () => document.documentElement.getAttribute('data-theme') === 'dark'
          : () => document.documentElement.getAttribute('data-theme') === 'light');
        await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
        await complete(page);
        const selected = await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).getAttribute('aria-checked');
        assert.equal(selected, 'true'); log('select actual Settings theme radio', { selectedTheme: theme, checked: selected });
        await change(() => !document.querySelector('.th-settings-panel'), () => page.click('.th-settings-menu .th-btn-icon'));
        log('capture exposed sidebar before closing drawer');
        const sidebar = (await shoot('sidebar', { sidebar: SURFACES.sidebar })).sidebar;
        if (mobile) {
          await change(() => !!document.querySelector('.th-sidebar--collapsed'), () => page.click('.th-sidebar button[title="Collapse sidebar"]'));
          await page.mouse.move(viewport.width - 6, 6);
        }

        log('fill UNSENT draft in idle controlled fixture');
        await page.locator('.th-chat-input textarea').fill('Unsent theme QA draft');
        assert.equal(fixture.runState('stored-a').running, false);
        assert.equal(await page.locator('.th-chat-status details').count(), 0);
        await page.mouse.move(viewport.width / 2, 6);
        const main = await shoot('main-idle-send', { canvas: SURFACES.canvas, composer: SURFACES.composer, send: SURFACES.send,
          status: '.th-chat-status-num', goal: '.th-goal-bar', activity: '.th-activity-bar' });
        assert.equal(main.send.type, 'submit'); assert.equal(main.send.disabled, false);
        assert.equal(main.status.present, true); assert.equal(main.status.exposed, true);
        assert.equal(painted(main.status).matches, true, 'inline metrics expose status paint at rest');
        log('inline status visible without disclosure; idle composer and draft preserved', { status: main.status });
        assert.equal(await page.locator('.th-chat-input textarea').inputValue(), 'Unsent theme QA draft');
        assert.equal(fixture.frames.filter(frame => frame.type === 'chat.send').length, 0, 'draft must remain unsent');
        log('hover enabled default send');
        await page.locator(SURFACES.send).hover();
        const hover = (await shoot('send-hover', { send: SURFACES.send })).send;
        log('keyboard focus default send');
        await page.locator('.th-chat-input textarea').focus(); await page.keyboard.press('Tab');
        await page.mouse.move(viewport.width / 2, 6);
        const focus = (await shoot('send-focus', { send: SURFACES.send })).send;
        log('deliver external-write conflict for disabled send');
        await change(() => document.querySelector('.th-chat-send-btn')?.disabled === true,
          () => fixture.deliver('stored-a', { type: 'error', code: 'external-write-detected',
            message: 'Fixture conflict', knownLeaf: 'fixture-known', observedLeaf: 'fixture-observed' }));
        const disabled = (await shoot('send-disabled', { send: SURFACES.send })).send;
        await change(() => document.querySelector('.th-chat-send-btn')?.disabled === false,
          () => page.locator('.th-external-write-banner-actions').click());
        log('recover through actual conflict reload control');

        const tool = '[data-tool-call-id="design-read"]';
        await scroll(`${tool} > .th-tool-head`);
        await page.mouse.move(viewport.width / 2, 6);
        const collapsedFrame = await shoot('tool-collapsed', { tool, success: `${tool} .th-tool-status--ok` });
        const collapsed = collapsedFrame.tool;
        log('expand actual tool record');
        await change(() => !!document.querySelector('[data-tool-call-id="design-read"] > .th-tool-body'),
          () => page.locator(`${tool} > .th-tool-head`).click());
        await scroll(`${tool} > .th-tool-head`);
        await page.mouse.move(viewport.width / 2, 6);
        const toolShell = (await shoot('tool-expanded', { tool })).tool;
        await change(() => !document.querySelector('[data-tool-call-id="design-read"] > .th-tool-body'),
          () => page.locator(`${tool} > .th-tool-head`).click());
        // A real visible prose row, not the first offscreen message's style.
        const textSelector = '.th-chat-msg:has([data-tool-call-id="design-read"]) .th-chat-markdown';
        await scroll(`${tool} > .th-tool-head`);
        // Scroll to the preceding assistant prose using its first paragraph.
        await scroll(`${textSelector} p`);
        await page.mouse.move(viewport.width / 2, 6);
        const text = (await shoot('transcript-text', { text: `${textSelector} p` })).text;

        await scroll('[data-tool-call-id="design-failed"] > .th-tool-head');
        await page.mouse.move(viewport.width / 2, 6);
        const errorState = (await shoot('tool-error', { error: '[data-tool-call-id="design-failed"] .th-tool-status--error' })).error;
        log('deliver running state and live tool through controlled fixture');
        await change(() => !!document.querySelector('.th-chat-send-btn.th-btn--danger'),
          () => fixture.deliver('stored-a', { type: 'run.started' }));
        await seedLive(page, fixture);
        await change(() => !!document.querySelector('.th-queue-header'),
          () => fixture.deliver('stored-a', { type: 'queue', ...designSeed().runs['stored-a'].queue }));
        await scroll('[data-tool-call-id="design-running"] > .th-tool-head');
        await page.mouse.move(viewport.width / 2, 6);
        const running = await shoot('running-stop', { stop: SURFACES.send, running: '[data-tool-call-id="design-running"] .th-tool-status--running', queue: '.th-queue-header' });
        log('click actual Stop and observe idle');
        await change(() => document.querySelector('.th-chat-send-btn')?.type === 'submit', () => page.locator(SURFACES.send).click());
        await change(() => !document.querySelector('.th-queue-header'),
          () => fixture.deliver('stored-a', { type: 'queue', revision: 2, items: [], engine: { pendingMessageCount: 0, ordered: [] } }));
        assert.equal(fixture.frames.filter(frame => frame.type === 'chat.send').length, 0, 'semantic captures must not submit the draft');

        log('open model menu and hover first option');
        await change(() => !!document.querySelector('.th-model-picker-popover'), () => page.click('.th-model-picker-btn'));
        await change(() => !!document.querySelector('.th-model-picker-list > button[data-active="true"]'),
          () => page.locator('.th-model-picker-list > button').first().hover());
        const menu = await shoot('model-menu', { menu: SURFACES.menu, highlightedRow: SURFACES.highlightedRow });
        await change(() => !document.querySelector('.th-model-picker-popover'), () => page.keyboard.press('Escape'));
        const color = sample => parseComputedColor(sample.color)?.rgb ?? [];
        const surfaces = {
          canvas: judgeFill(main.canvas, REFERENCE[theme].canvas),
          sidebar: judgeFill(sidebar, mobile ? REFERENCE[theme].menu : REFERENCE[theme].sidebar),
          composer: judgeFill(main.composer, REFERENCE[theme].composer),
          send: judgeFill(main.send, REFERENCE[theme].send),
          toolShell: judgeFill(toolShell, REFERENCE[theme].toolShell),
          menu: judgeFill(menu.menu, REFERENCE[theme].menu),
          highlightedRow: judgeFill(menu.highlightedRow, REFERENCE[theme].highlightedRow),
          collapsedTool: (collapsedJudge => ({ ...collapsedJudge,
            matches: collapsedJudge.matches && collapsed.borderStyle === 'solid'
              && collapsed.borderWidth === '1px' }))(judgeFill(collapsed, REFERENCE[theme].toolShell)),
          text: { ...painted(text), referenceRgb: REFERENCE[theme].text,
            matches: painted(text).matches && near(color(text), REFERENCE[theme].text, 0) },
          menuShadow: { present: menu.menu.present, computed: menu.menu.boxShadow, matches: menu.menu.boxShadow === 'none' },
          toolBorder: { present: toolShell.present, computed: toolShell.borderColor,
            matches: toolShell.borderStyle === 'solid' && toolShell.borderWidth === '1px' },
          sendHover: { ...painted(hover), matches: painted(hover).matches && hover.computed !== main.send.computed && hover.samples.length > 0 },
          sendFocus: { ...painted(focus), matches: painted(focus).matches && focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0 },
          sendDisabled: { ...painted(disabled), matches: painted(disabled).matches && disabled.disabled === true
            && disabled.cursor === 'not-allowed' },
          stop: { ...painted(running.stop), matches: painted(running.stop).matches && running.stop.type === 'button'
            && running.stop.disabled === false && running.stop.computed !== main.send.computed && running.stop.samples.length > 0 },
          success: painted(collapsedFrame.success), error: painted(errorState), running: painted(running.running), queue: painted(running.queue),
          status: painted(main.status), goal: painted(main.goal), activity: painted(main.activity),
        };
        results.push({ scenario: label, theme, pane, surfaces,
          screenshots: screenshots.filter(frame => frame.path.includes(`-${label}-${theme}-`)).map(frame => ({ path: frame.path, sha256: frame.sha256 })) });
      }
    }
    mismatches = missingSurfaces(results);
    await save('theme-samples.json', { ...receipt, mismatches, results, actions, screenshots });
    if (phase === 'red') {
      assert(mismatches.length > 0, 'red phase requires the current build to MISS the reference; the tree already matches');
      console.log(`RED confirmed: ${mismatches.length} reference mismatches:\n  ${mismatches.join('\n  ')}`);
    } else {
      assert.deepEqual(mismatches, [], `green phase requires full reference match; mismatched: ${mismatches.join(', ')}`);
    }
  } catch (error) {
    failures.push(error);
    try { await save('theme-samples-FAIL.json', { ...receipt, results, actions, screenshots, error: String(error), stack: error.stack }); }
    catch (writeError) { failures.push(writeError); }
  } finally {
    for (const { label, errors, fixture } of sessions) {
      try {
        assert.deepEqual(errors, [], `${label}: no browser exceptions`);
        assert.deepEqual(fixture.unexpected, [], `${label}: no unexpected HTTP/WS traffic`);
      } catch (error) { failures.push(error); }
    }
    if (browser) resources.push({ name: 'browser', close: async () => { await browser.close(); return { browserClosed: true }; } });
    try { await closeResources(resources, value => save('cleanup.json', value)); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Theme QA failed');
  console.log(`${phase.toUpperCase()} complete; all owned resource closures awaited.`);
  return { phase, mismatches, results };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } } });
  await run({ phase: values.phase, out: values.out })
    .then(() => process.exit(0))
    .catch(error => { console.error(error); process.exit(1); });
}
