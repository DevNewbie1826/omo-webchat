/** QA_PLAYWRIGHT=<installed-driver> bun test/qa/ui-theme-polish.mjs --phase red|green --out ABSOLUTE_PATH
 *
 * Theme reference harness (brief C2). Boots the real built App through
 * setupDesign, toggles dark/light through the actual Settings theme radio
 * group, and samples the semantic surfaces the authenticated Codex desktop
 * reference measured (canvas, sidebar, composer, expanded tool shell, model
 * menu, highlighted menu row, primary text). Surface fills are read twice:
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
import { setupDesign, arm, complete } from './design-workbench-fixture.mjs';

/** Measured authenticated reference (authenticated-pixel-measurements.json
 *  plus the report's computed foreground values), CSS 0-255 samples. The
 *  expanded tool shell maps to the measured elevated-chrome role (sidebar). */
const REFERENCE = {
  dark: {
    canvas: [24, 24, 24], sidebar: [40, 40, 40], composer: [42, 42, 42],
    toolShell: [40, 40, 40], menu: [45, 45, 45], highlightedRow: [61, 61, 61],
    text: [223, 223, 223],
  },
  light: {
    canvas: [255, 255, 255], sidebar: [255, 255, 255], composer: [255, 255, 255],
    toolShell: [255, 255, 255], menu: [255, 255, 255], highlightedRow: [242, 243, 243],
    text: [26, 28, 31],
  },
};
const COLLAPSED_TOOL_BACKGROUND_ALPHA = 0; // transparent collapsed records

const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

const near = (a, b, tolerance = 1) =>
  a.length === b.length && a.every((channel, i) => Math.abs(channel - b[i]) <= tolerance);

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
      push(innerWidth - 6, innerHeight * fraction);
      push(innerWidth - 26, innerHeight * fraction);
    }
    return {
      selector, present: true, computed: style.backgroundColor,
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
    const frame = context.getImageData(0, 0, bitmap.width, bitmap.height);
    window.themePixels = {
      data: frame.data, width: frame.width, height: frame.height,
      scale: frame.width / innerWidth,
    };
  }, `data:image/png;base64,${shot.toString('base64')}`);
}

const parseComputedColor = value => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value ?? '');
  if (!match) return null;
  return { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha: match[4] === undefined ? 1 : Number(match[4]) };
};

/** Fill verdict: the resolved computed style must equal the reference exactly,
 *  and for on-screen surfaces a real screenshot pixel must agree with it. */
function judgeFill(sample, referenceRgb) {
  const computed = parseComputedColor(sample.computed);
  const computedMatches = computed !== null && computed.alpha === 1 && near(computed.rgb, referenceRgb, 0);
  const needsPixel = sample.visible === true && sample.onScreen === true;
  const pixelMatches = (sample.samples ?? []).some(point => near(point.rgb, referenceRgb));
  return {
    selector: sample.selector, present: sample.present === true, visible: sample.visible === true,
    onScreen: sample.onScreen === true,
    computedMatches, pixelMatches, needsPixel,
    computed: sample.computed, pixelEvidence: (sample.samples ?? []).map(point => point.rgb),
    referenceRgb, matches: computedMatches && (!needsPixel || pixelMatches),
  };
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
  const screenshots = [], actions = [], cleanup = [], results = [];
  const SURFACES = {
    // The chat pane paints the canvas token itself; body's fill is never
    // visible inside the pane.
    canvas: '.th-chat-pane',
    sidebar: '.th-sidebar',
    composer: '.th-chat-input-inner',
    menu: '.th-model-picker-popover',
    highlightedRow: '.th-model-picker-list > button[data-active="true"]',
  };
  let browser;
  try {
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browserVersion = browser.version();

    for (const viewport of VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      const q = await setupDesign(browser, { theme: 'dark', viewport });
      await q.page.evaluate(pageHelpers);
      try {
        let drawerOpen = false;
        for (const theme of ['dark', 'light']) {
          if (theme === 'light') {
            actions.push({ scenario: label, action: 'open Settings, click the actual Light radio, close Settings' });
            // On narrow viewports the sidebar (which owns Settings) starts as
            // a collapsed off-canvas drawer: open it with the chat header's
            // actual menu button, and close it with the drawer's own control.
            const menuButton = q.page.locator('.th-mobile-menu');
            if (await menuButton.isVisible()) {
              actions.push({ scenario: label, action: 'open the collapsed mobile sidebar drawer' });
              // Wait on the discrete collapsed class, not animated geometry:
              // the drawer's transform transition fires no further mutations
              // for an observer to re-check once it starts.
              await arm(q.page, () => !document.querySelector('.th-sidebar--collapsed'));
              await menuButton.click();
              await complete(q.page);
              drawerOpen = true;
            }
            await arm(q.page, () => !!document.querySelector('.th-settings-panel'));
            await q.page.click('.th-settings-menu .th-btn-icon');
            await complete(q.page);
            await arm(q.page, () => document.documentElement.getAttribute('data-theme') === 'light');
            await q.page.getByRole('radio', { name: 'Light', exact: true }).click();
            await complete(q.page);
            await q.page.click('.th-settings-menu .th-btn-icon');
            await complete(q.page);
            if (drawerOpen) {
              await arm(q.page, () => !!document.querySelector('.th-sidebar--collapsed'));
              await q.page.click('.th-sidebar button[title="Collapse sidebar"]');
              await complete(q.page);
              drawerOpen = false;
              // The collapsed class flips before the transform transition
              // ends; drain the sidebar's finite animations so off-canvas
              // geometry is terminal before anything samples or shoots it.
              await q.page.evaluate(() => {
                const sidebar = document.querySelector('.th-sidebar');
                const finite = [...(sidebar?.getAnimations({ subtree: true }) ?? [])]
                  .filter(animation => Number.isFinite(animation.effect?.getComputedTiming?.().endTime));
                return Promise.race([
                  Promise.allSettled(finite.map(animation => animation.finished)),
                  new Promise((_, fail) => { setTimeout(() => fail(new Error('Drawer transition deadline')), 8000); }),
                ]);
              });
            }
          }

          const shoot = async name => {
            const path = resolve(out, `c2-${phase}-${label}-${theme}-${name}.png`);
            await q.page.screenshot({ path, animations: 'allow' });
            screenshots.push(path);
            await loadPixels(q.page, await q.page.screenshot({ animations: 'allow' }));
          };

          await shoot('main');
          const main = await q.page.evaluate(selectors => {
            const out = {};
            for (const [name, selector] of Object.entries(selectors)) out[name] = window.themeSample(selector);
            const msg = document.querySelector('.th-chat-msg');
            out.text = msg
              ? { selector: '.th-chat-msg', present: true, computed: getComputedStyle(msg).color }
              : { selector: '.th-chat-msg', present: false };
            return out;
          }, SURFACES);

          actions.push({ scenario: label, action: `expand first tool record (${theme})` });
          await arm(q.page, () => !!document.querySelector('.th-tool:has(> .th-tool-body)'));
          await q.page.locator('.th-tool-head').first().click();
          await complete(q.page);
          // The click leaves the pointer over the header, whose :hover fill
          // would mask the shell; park it on the empty transcript margin and
          // make sure the shell is on screen before sampling.
          await q.page.mouse.move(viewport.width / 2, 6);
          await q.page.locator('.th-tool:has(> .th-tool-body)').first().scrollIntoViewIfNeeded();
          await shoot('tool-expanded');
          const toolShell = await q.page.evaluate(() => window.themeSample('.th-tool:has(> .th-tool-body)'));
          const collapsed = await q.page.evaluate(() => {
            const el = [...document.querySelectorAll('.th-tool')].find(el => !el.querySelector('.th-tool-body'));
            return el ? { present: true, computed: getComputedStyle(el).backgroundColor } : { present: false };
          });

          actions.push({ scenario: label, action: `open model menu, hover first option (${theme})` });
          await arm(q.page, () => {
            const popover = document.querySelector('.th-model-picker-popover');
            return !!popover && popover.getBoundingClientRect().height > 0;
          });
          await q.page.click('.th-model-picker-btn');
          await complete(q.page);
          await q.page.hover('.th-model-picker-list > button');
          await q.page.waitForFunction(() => !!document.querySelector('.th-model-picker-list > button[data-active="true"]'));
          await shoot('model-menu');
          const menu = await q.page.evaluate(selectors => ({
            menu: window.themeSample(selectors.menu),
            highlightedRow: window.themeSample(selectors.highlightedRow),
          }), SURFACES);
          await q.page.keyboard.press('Escape');

          const surfaces = {
            canvas: judgeFill(main.canvas, REFERENCE[theme].canvas),
            // Desktop shows the sidebar in its elevated-chrome role; at or
            // below the 768px drawer breakpoint sidebar.css pins the mobile
            // drawer to the overlay role (styleContracts), so the measured
            // menu fill is the expected drawer fill.
            sidebar: judgeFill(main.sidebar, viewport.width <= 768 ? REFERENCE[theme].menu : REFERENCE[theme].sidebar),
            composer: judgeFill(main.composer, REFERENCE[theme].composer),
            toolShell: judgeFill(toolShell, REFERENCE[theme].toolShell),
            menu: judgeFill(menu.menu, REFERENCE[theme].menu),
            highlightedRow: judgeFill(menu.highlightedRow, REFERENCE[theme].highlightedRow),
            collapsedTool: {
              present: collapsed.present === true,
              computed: collapsed.computed ?? null,
              matches: !collapsed.present || (parseComputedColor(collapsed.computed)?.alpha ?? 1) === COLLAPSED_TOOL_BACKGROUND_ALPHA,
            },
            text: {
              present: main.text.present === true,
              computed: main.text.computed,
              computedMatches: near(parseComputedColor(main.text.computed)?.rgb ?? [], REFERENCE[theme].text, 0),
              referenceRgb: REFERENCE[theme].text,
              matches: near(parseComputedColor(main.text.computed)?.rgb ?? [], REFERENCE[theme].text, 0),
            },
          };
          results.push({
            scenario: label, theme,
            surfaces,
            screenshots: screenshots.filter(path => path.includes(`-${label}-${theme}-`)),
          });
        }
        assert.deepEqual(q.errors, [], `${label}: no browser exceptions`);
        assert.deepEqual(q.fixture.unexpected, [], `${label}: no unexpected HTTP/WS traffic`);
      } finally {
        cleanup.push({ scenario: label, ...await q.close() });
      }
    }

    const mismatches = results.flatMap(result =>
      Object.entries(result.surfaces)
        .filter(([name, verdict]) => {
          if (name === 'collapsedTool') return verdict.present && !verdict.matches;
          if (name === 'text') return verdict.present && !verdict.matches;
          return verdict.present && !verdict.matches;
        })
        .map(([name]) => `${result.scenario}/${result.theme}/${name}`));

    await save('theme-samples.json', { ...receipt, mismatches, results, actions, screenshots });
    if (phase === 'red') {
      assert(mismatches.length > 0,
        'red phase requires the current build to MISS the reference; the tree already matches');
      console.log(`RED confirmed: ${mismatches.length} reference mismatches:\n  ${mismatches.join('\n  ')}`);
    } else {
      assert.deepEqual(mismatches, [], `green phase requires full reference match; mismatched: ${mismatches.join(', ')}`);
      console.log('GREEN confirmed: every sampled surface matches the authenticated reference in both themes.');
    }
    await writeFile(resolve(out, 'cleanup.json'), JSON.stringify({
      cleanups: cleanup, browserClosed: true,
      portsFreed: cleanup.map(entry => ({ port: entry.port, contextClosed: entry.contextClosed, url: entry.url })),
    }, null, 2) + '\n');
    return { phase, mismatches, results };
  } catch (error) {
    await save('theme-samples-FAIL.json', { ...receipt, results, actions, error: String(error), stack: error.stack });
    await writeFile(resolve(out, 'cleanup.json'), JSON.stringify({ cleanups: cleanup, browserClosed: true, error: String(error) }, null, 2) + '\n')
      .catch(() => { /* samples file above already flushed the failure record */ });
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } } });
  await run({ phase: values.phase, out: values.out })
    .then(() => process.exit(0))
    .catch(error => { console.error(error); process.exit(1); });
}
