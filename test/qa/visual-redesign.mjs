#!/usr/bin/env bun
/** Visual-redesign real-browser QA harness (CLI).
 *
 * Measures the governing plan's QA scenarios against the ACTUAL built SPA
 * served by the existing fixtures (no synthetic DOM), in real Chrome via the
 * shared QA_PLAYWRIGHT driver. Usable unchanged by every redesign task and
 * on the unmodified baseline (baseline failures are expected findings).
 *
 * Usage:
 *   QA_PLAYWRIGHT=/tmp/qa-pw/node_modules/playwright/index.mjs \
 *     bun test/qa/visual-redesign.mjs --evidence ABS_DIR \
 *       [--scenarios S1,S4,S12] [--themes dark,light] \
 *       [--viewports 1280x900,768x1024,390x844] [--baseline] \
 *       [--baseline-file /path/to/baseline-counts.json]
 *
 * Output inside --evidence: results.json, summary.md, screenshots/*.png and
 * (with --baseline) baseline-counts.json. Exit code 1 when any non-null
 * probe result is false; stubbed scenarios (owned by T2/T3/T4 or non-browser
 * channels) report pass: null and never affect the exit code.
 *
 * ---------------------------------------------------------------------------
 * PER-TASK SCENARIO PLUGINS (T2/T3/T4 must NOT edit the shared harness files)
 * ---------------------------------------------------------------------------
 * At startup this CLI globs `test/qa/visual-redesign-scenarios-*.mjs` (sorted
 * by filename, later files win), imports each, and merges its exported
 * `scenarios` object over the built-in registry: keys are scenario ids
 * ("S7", ...; unknown/extra ids are allowed), values are async probe
 * functions. A plugin entry overrides the built-in stub for that id (and may
 * override a built-in implementation; the recorded origin shows which).
 *
 * Plugin module contract:
 *   export const scenarios = {
 *     S7: async ctx => ({ pass, measurements, failures, screenshots?, teardown? }),
 *   };
 *
 * The return shape matches the built-in probes: { pass: boolean|null,
 * measurements: object, failures: string[], screenshots?: string[] (paths
 * relative to the evidence dir, e.g. from ctx.save), teardown?: object (the
 * receipt from env.close()) }. `scenario`/`theme`/`viewport` are filled in by
 * the runner.
 *
 * ctx passed to every probe function (built-in drivers receive the same
 * object plus the browser as their first argument):
 *   scenario: id, theme: "dark"|"light", viewport: {width, height, label},
 *   evidenceDir, shotsDir, baseline: per-combo counts from --baseline-file or
 *     <evidence>/baseline-counts.json (null when absent),
 *   setupDesign(options?) -> {page, context, fixture, errors, close()} - the
 *     design-workbench fixture over the built SPA (tools, queue, shelves),
 *   setupLive(options?) -> same shape on the task-state fixture whose WS
 *     proxy can also push overview frames (live tree, DAG, approvals),
 *   probe(page, fn, arg) -> evaluate an in-page function with the shared
 *     colour/motion kit injected ahead of it (see visual-redesign-probes.mjs),
 *   motionSweep(page) -> supplementary animation inventory (never throws),
 *   save(page, suffix) -> screenshot path relative to the evidence dir,
 *   constants: { THEME_EXPECTATIONS, HIERARCHY_MIN_RATIO, CONTRAST_BODY_MIN,
 *                CONTRAST_FAINT_MIN, SEED_CWD, CHAT }.
 *
 * Binding sources: .omo/plans/visual-redesign.md (scenarios S1..S22) and
 * .omo/plans/visual-redesign-tokens.md (token contract v2).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { designSeed, fileContent, installSignals, seedLive, setupDesign } from './design-workbench-fixture.mjs';
import { startFixture } from './pane-workspace-ui.mjs';
import { startTaskFixture } from './task-state-fixture.mjs';
import { summaryFrame } from './dag-summary-fixture.mjs';
import {
  CONTRAST_BODY_MIN, CONTRAST_FAINT_MIN, HIERARCHY_MIN_RATIO,
  SCENARIOS, THEME_EXPECTATIONS, colorEquals, modalFocusRestoreDecision, modalFocusRestoreFacts, motionViolations,
  overlaySnapshot, pageKit, parseColor, probeChromeTheme,
  probeContrastSurface, probeHeader, probeHierarchy, probeMotion, probeReducedMotion, probeRunningGlyphs,
  probeRunningReducedMotion, probeSeparation, probeStateColors, probeTokens,
} from './visual-redesign-probes.mjs';

const SEED_CWD = '/fixture';
const CHAT = 'stored-a';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { scenarios: null, themes: ['dark', 'light'], viewports: ['1280x900', '768x1024', '390x844'], baseline: false, baselineFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1; return next;
    };
    if (arg === '--evidence') options.evidence = value();
    else if (arg === '--scenarios') options.scenarios = value().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--themes') options.themes = value().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--viewports') options.viewports = value().split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--baseline') options.baseline = true;
    else if (arg === '--baseline-file' || arg === '--baseline-from') options.baselineFile = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.evidence) throw new Error('--evidence ABS_DIR is required');
  if (!isAbsolute(options.evidence)) throw new Error('--evidence must be an absolute path');
  if (!process.env.QA_PLAYWRIGHT) throw new Error('QA_PLAYWRIGHT must point at the installed playwright driver (playwright/index.mjs)');
  const parseViewport = text => {
    const match = /^(\d+)x(\d+)$/.exec(text);
    if (!match) throw new Error(`bad viewport "${text}" (want 1280x900)`);
    return { width: Number(match[1]), height: Number(match[2]), label: text };
  };
  options.viewports = options.viewports.map(parseViewport);
  for (const theme of options.themes) {
    if (!(theme in THEME_EXPECTATIONS)) throw new Error(`unknown theme "${theme}" (dark|light)`);
  }
  // Scenario-id validation happens in main() against the merged registry
  // (built-ins + per-task plugins), not here: plugin files may register ids
  // like S99 that the built-in SCENARIOS map does not know.
  return options;
}

// ---------------------------------------------------------------------------
// In-page evaluation with the shared helper kit
// ---------------------------------------------------------------------------

const KIT = pageKit();

/** Evaluate an in-page probe with the shared kit injected ahead of it.
 * Hard timeout: a pathological page must surface as a recorded failure,
 * never an eternal hang (page.evaluate itself has no deadline). */
async function probe(page, fn, arg = {}, timeoutMs = 30000) {
  const source = `${KIT}\nreturn (${fn.toString()})(${JSON.stringify(arg)});`;
  let timer;
  try {
    return await Promise.race([
      page.evaluate(new Function(source)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`in-page probe exceeded ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function motionSweep(page) {
  // Supplementary evidence: never let the sweep discard the scenario result.
  try {
    const result = await probe(page, probeMotion);
    return {
      animationCount: result.measurements.animationCount, byKind: result.measurements.byKind,
      infiniteCount: result.measurements.infiniteCount, inventory: result.measurements.inventory.slice(0, 40),
      violating: result.measurements.violating,
    };
  } catch (error) {
    return { unavailable: String(error instanceof Error ? error.message.split('\n')[0] : error) };
  }
}

// ---------------------------------------------------------------------------
// Real-user interaction helpers (D3/D5/D7)
// ---------------------------------------------------------------------------

const errLine = error => (error instanceof Error ? error.message.split('\n')[0] : String(error));

/** D7 - screenshots must show settled overlays, never a mid-enter frame.
 * Waits for every animation on `selector` (subtree) to finish; bounded so
 * infinite animations (pulse/spin glyphs) resolve via the timeout instead
 * of hanging the cycle. */
async function settleAnimations(page, selector, timeoutMs = 2500) {
  await page.evaluate(({ selector, timeoutMs }) => {
    const element = document.querySelector(selector);
    if (!element) return Promise.resolve();
    const animations = element.getAnimations({ subtree: true });
    return Promise.race([
      Promise.allSettled(animations.map(animation => animation.finished)),
      new Promise(done => setTimeout(done, timeoutMs)),
    ]);
  }, { selector, timeoutMs }).catch(() => {});
}

/** D3 - clear the composer the way a real user does: focus the textarea,
 * select all (platform modifier), Backspace. Programmatic fill() would not
 * exercise the keyboard path that owns the palette's re-open state. */
async function clearComposer(page) {
  await page.focus('.th-chat-input textarea');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
}

/** True when the viewport collapses the sidebar into the mobile drawer
 * (<= 768px): the pane-header hamburger is display:none above that width. */
async function isNarrow(page) {
  return page.locator('.th-termhead .th-mobile-menu').first().isVisible().catch(() => false);
}

/** D5 - open the mobile drawer through its real entry point: the hamburger
 * in the pane header (the empty state also carries .th-empty-menu). No-op
 * when the sidebar is a desktop column. Drawer state is read from the
 * inert/aria-hidden attributes React sets immediately - NOT from CSS
 * visibility, which lags the 320ms closing transition and made an
 * open-right-after-close race (S19 mobile harness error, round 1). */
async function openMobileDrawer(page) {
  if (!(await isNarrow(page))) return;
  const drawerHidden = () => page.evaluate(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true';
  }).catch(() => true);
  if (!(await drawerHidden())) return;
  const menu = page.locator('.th-mobile-menu').first();
  if (!(await menu.isVisible().catch(() => false))) {
    throw new Error('mobile drawer entry (.th-mobile-menu) is not visible at this viewport');
  }
  await menu.click();
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !!sidebar && !sidebar.hasAttribute('inert') && sidebar.getAttribute('aria-hidden') !== 'true';
  }, undefined, { timeout: 4000 });
}

async function closeMobileDrawer(page) {
  const backdrop = page.locator('.th-backdrop');
  if (!(await backdrop.isVisible().catch(() => false))) return;
  // Click a point the open drawer does not cover: the backdrop spans the
  // full viewport, so its CENTER sits underneath the drawer (z-above) and a
  // plain click() never becomes actionable - the drawer then stays open and
  // occludes later interactions and captures (O1, S16 narrow cells).
  const width = page.viewportSize()?.width ?? 390;
  await backdrop.click({ timeout: 2000, position: { x: Math.max(1, width - 24), y: 60 } }).catch(() => {});
  // Wait out the closing transition so a following openMobileDrawer cannot
  // race a still-visible drawer.
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true';
  }, undefined, { timeout: 4000 }).catch(() => {});
}

/** D5 - click `selector` through its real entry point. On narrow viewports
 * sidebar-dwelling controls (settings trigger, session tree, wizard button)
 * are only reachable inside the mobile drawer, so open that first. */
async function clickThroughRealEntry(page, selector, options = {}) {
  const target = page.locator(selector).first();
  if (!(await target.isVisible().catch(() => false))) await openMobileDrawer(page);
  await target.click(options);
}

// ---------------------------------------------------------------------------
// Fixture setups
// ---------------------------------------------------------------------------

/** setupDesign, but on the task-state fixture whose WS proxy can also push
 * overview frames (live tree) while keeping every other seed identical. */
async function setupLive(browser, options = {}) {
  const fixture = startTaskFixture({ ...designSeed(options.layout ?? 'single'), port: 0 });
  let context;
  try {
    context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      colorScheme: options.theme ?? 'dark',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await installSignals(page, options);
    const attached = fixture.base.wait('frame', frame => frame.type === 'chat.stats');
    await page.goto(fixture.url);
    await attached;
    await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-queue-header')
      && document.querySelector('.th-activity-shelf [data-activity-tab]')
      && document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
      && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
    await seedLive(page, fixture);
    return {
      page, context, fixture, errors,
      async close() {
        await context.close();
        return { contextClosed: true, url: fixture.url, ...await fixture.stop() };
      },
    };
  } catch (error) {
    if (context) await context.close();
    const cleanup = await fixture.stop();
    throw new Error(`Live setup failed; cleanup=${JSON.stringify(cleanup)}`, { cause: error });
  }
}

/** setupDesign, but with the omo provider reported unavailable so the New
 * Chat dialog actually opens: with an available provider, requestNewChat
 * creates the chat directly and no modal ever mounts (S12 needs the dialog). */
async function setupOverlays(browser, options = {}) {
  const fixture = startFixture({ ...designSeed(options.layout ?? 'single'), ...options.seed, port: 0 });
  let context;
  try {
    context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      colorScheme: options.theme ?? 'dark',
    });
    await context.route('**/api/providers', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'omo', label: 'omo', available: false }]),
    }));
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await installSignals(page, options);
    const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
    await page.goto(fixture.url);
    await attached;
    await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-queue-header')
      && document.querySelector('.th-activity-shelf [data-activity-tab]')
      && document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
      && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
    await seedLive(page, fixture);
    return {
      page, context, fixture, errors,
      async close() {
        await context.close();
        return { contextClosed: true, url: fixture.url, ...await fixture.stop() };
      },
    };
  } catch (error) {
    if (context) await context.close();
    const cleanup = await fixture.stop();
    throw new Error(`Overlay setup failed; cleanup=${JSON.stringify(cleanup)}`, { cause: error });
  }
}

/** Push the running-DAG activity frame on both sockets the app opens:
 * the chat socket (activity shelf) and the all_live push socket (tree). */
async function deliverRunningDag(env, notes) {
  const frame = summaryFrame('complete2');
  const dag = frame.snapshots.find(snapshot => snapshot.name === 'omo.dag.updated').data;
  env.fixture.base.setDagRuns(CHAT, dag.runs);
  await env.fixture.deliver(CHAT, frame);
  const peers = env.fixture.overview(frame);
  notes.push(`overview frame reached ${peers.length} all_live subscriber(s)`);
  try {
    await env.page.waitForSelector('[data-activity-tab="dag"]', { timeout: 4000 });
    await env.page.click('[data-activity-tab="dag"]');
    await env.page.waitForSelector('.th-activity-gnode--running', { timeout: 4000 });
    notes.push('DAG graph reached');
  } catch (error) {
    notes.push(`DAG graph not reached: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  }
}

async function deliverApproval(env, notes) {
  await env.fixture.deliver(CHAT, {
    type: 'approval', id: 'qa-approval-1', method: 'shell.exec',
    title: 'QA approval', message: 'Approve the QA harness action?',
  });
  try {
    await env.page.waitForSelector('.th-approval-form, .th-question-window, [class*="approval"]', { timeout: 4000 });
  } catch {
    notes.push('approval surface did not render (fallback frame rejected)');
  }
}

// ---------------------------------------------------------------------------
// Scenario drivers. Each returns { pass, measurements, failures, screenshots }.
// ---------------------------------------------------------------------------

async function driveTokens(browser, ctx) {
  const env = await setupDesign(browser, ctx);
  const result = await probe(env.page, probeTokens, {
    expectTheme: ctx.theme, expectBg: THEME_EXPECTATIONS[ctx.theme].bg, expectAccent: THEME_EXPECTATIONS[ctx.theme].accent,
  });
  const shot = await screenshot(env.page, ctx, '');
  return { ...result, measurements: withPageErrors(env, result.measurements), screenshots: [shot], teardown: await env.close() };
}

async function driveHierarchy(browser, ctx) {
  const env = await setupDesign(browser, ctx);
  const result = await probe(env.page, probeHierarchy, { minRatio: HIERARCHY_MIN_RATIO });
  const shot = await screenshot(env.page, ctx, '');
  return { ...result, measurements: withPageErrors(env, result.measurements), screenshots: [shot], teardown: await env.close() };
}

async function driveSeparation(browser, ctx) {
  const env = await setupDesign(browser, ctx);
  const result = await probe(env.page, probeSeparation, { baselineBordered: ctx.baseline?.borderedCount });
  const shot = await screenshot(env.page, ctx, '');
  return { ...result, measurements: withPageErrors(env, result.measurements), screenshots: [shot], teardown: await env.close() };
}

async function driveStateColors(browser, ctx) {
  const env = await setupLive(browser, ctx);
  const notes = [];
  await deliverRunningDag(env, notes);
  await deliverApproval(env, notes);
  try {
    if (await env.page.locator('.th-modal-overlay').isVisible()) {
      await env.page.keyboard.press('Escape');
      await env.page.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 4000 });
    }
    await env.page.click('.th-model-picker-btn');
    await env.page.waitForSelector('.th-model-picker-popover', { timeout: 4000 });
    notes.push('model picker reached');
  } catch (error) {
    notes.push(`model picker not reached: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  }
  const result = await probe(env.page, probeStateColors);
  result.measurements.surfaceNotes = notes;
  result.measurements.motion = await motionSweep(env.page);
  const shot = await screenshot(env.page, ctx, '');
  return { ...result, measurements: withPageErrors(env, result.measurements), screenshots: [shot], teardown: await env.close() };
}

async function driveHeader(browser, ctx) {
  const env = await setupDesign(browser, ctx);
  const result = await probe(env.page, probeHeader, { cwd: SEED_CWD });
  const shot = await screenshot(env.page, ctx, '');
  return { ...result, measurements: withPageErrors(env, result.measurements), screenshots: [shot], teardown: await env.close() };
}

async function driveRunning(browser, ctx) {
  const env = await setupLive(browser, ctx);
  const notes = [];
  await deliverRunningDag(env, notes);
  const colours = await probe(env.page, probeRunningGlyphs);
  const shotColour = await screenshot(env.page, ctx, '');
  await env.page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await probe(env.page, probeRunningReducedMotion);
  const shotReduced = await screenshot(env.page, ctx, '-reduced');
  const failures = [...colours.failures.map(f => `colours: ${f}`), ...reduced.failures.map(f => `reduced-motion: ${f}`)];
  return {
    scenario: 'S8', pass: failures.length === 0,
    measurements: withPageErrors(env, { colours: colours.measurements, reducedMotion: reduced.measurements, surfaceNotes: notes }),
    failures, screenshots: [shotColour, shotReduced], teardown: await env.close(),
  };
}

/** One overlay interaction cycle against the refined S12 contract.
 *
 * surface spec:
 *   name, root                 - census selector for the overlay itself
 *   kind 'modal'               - focus moves INTO the dialog immediately on
 *                              open (no animation wait). Escape closes and
 *                              focus returns to `trigger` when that trigger is
 *                              still visible and focusable; a hidden or detached
 *                              trigger must land on the focused pane composer
 *                              or the main region, never on body. Panel needs glass.
 *   kind 'popover'             - focus STAYS on `controller` with
 *                              aria-expanded="true"; Escape closes leaving
 *                              focus on the controller. `palette` adds the
 *                              aria-activedescendant check while an option
 *                              is active; `tabIntoPanel` adds the single-Tab
 *                              -into-panel check (settings menu).
 *   glassGated                 - backdrop-filter != none is a failure when
 *                              true; palette glass is T2/S9 scope and is
 *                              recorded but not gated here.
 *   open/close/recover         - real-entry interactions; `reset` (palette)
 *                              runs between close and re-open so the rapid
 *                              cycle mimics a real user clearing the
 *                              composer (D3). */
export async function overlayCycle(page, ctx, surface) {
  const failures = [];
  // entryMethod documents how this cycle entered the surface: native pointer
  // input by default (R3) - after the synthetic dispatchEvent('click')
  // removal no other entry method exists anywhere in the harness.
  const record = { surface: surface.name, kind: surface.kind, entryMethod: surface.entryMethod ?? 'native' };
  const snapshot = () => probe(page, overlaySnapshot, { root: surface.root, controller: surface.controller });
  try {
    await surface.open(page);
  } catch (error) {
    // A surface that never appears through its real entry point is a
    // product finding (including "no mobile entry exists"), never a harness
    // defect: report it plainly and skip the rest of this cycle.
    failures.push(`${surface.name}: overlay did not open through its real entry point (${errLine(error)})`);
    await surface.recover(page).catch(() => {});
    return { record, failures, screenshots: [] };
  }
  // Focus semantics are judged on the immediate post-open state, with no
  // wait for enter animations (refined S12: "immediately after open").
  const immediate = await snapshot();
  record.afterOpen = immediate;
  if (immediate.count !== 1) failures.push(`${surface.name}: expected exactly 1 open overlay, found ${immediate.count}`);
  if (surface.kind === 'modal') {
    record.focusInsideImmediately = immediate.activeInside;
    if (!immediate.activeInside) failures.push(`${surface.name}: document.activeElement (${immediate.activeElement}) not inside dialog immediately after open`);
  } else {
    const controller = immediate.controller ?? {};
    if (!controller.found) failures.push(`${surface.name}: controller ${surface.controller} not found after open`);
    else {
      if (!controller.hasFocus) failures.push(`${surface.name}: focus is not on the controller after open (${immediate.activeElement})`);
      if (controller.ariaExpanded !== 'true') failures.push(`${surface.name}: controller aria-expanded is ${controller.ariaExpanded ?? 'missing'}, expected "true"`);
    }
  }
  if (surface.glassGated && immediate.backdropFilterIsNone) {
    failures.push(`${surface.name}: floating surface backdrop-filter is ${immediate.backdropFilter ?? 'none'}`);
  }
  if (surface.palette) {
    // An option is active only after the user moves the selection: press
    // ArrowDown, then the controller must carry aria-activedescendant that
    // resolves inside the palette (WAI-ARIA APG combobox pattern). File
    // palette options arrive after a debounced fetch (slash options render
    // synchronously), so wait for a real option first - the check must not
    // race an empty list.
    if (surface.paletteReady) await page.waitForSelector(surface.paletteReady, { timeout: 4000 });
    await page.keyboard.press('ArrowDown');
    const withActive = await snapshot();
    record.afterArrowDown = withActive;
    const controller = withActive.controller ?? {};
    if (!controller.ariaActiveDescendant || !controller.activeDescendantInRoot) {
      failures.push(`${surface.name}: controller aria-activedescendant ${controller.ariaActiveDescendant ? 'does not resolve inside the palette' : 'missing while an option is active'}`);
    }
  }
  const animated = (immediate.animations ?? []).filter(entry => entry.properties?.length > 0);
  record.animationCount = (immediate.animations ?? []).length;
  const animatedProperties = [...new Set(animated.flatMap(entry => entry.properties)
    .flatMap(property => String(property).split(','))
    .map(name => name.trim()).filter(Boolean))];
  record.animatingProperties = animatedProperties;
  const bad = motionViolations(animatedProperties);
  if (bad.length > 0) failures.push(`${surface.name}: overlay animates disallowed properties ${bad.join(', ')}`);
  // D7: capture only after enter animations settle.
  await settleAnimations(page, surface.root);
  const shot = await screenshot(page, ctx, `-${surface.name}`);
  try {
    await surface.close(page);
    await page.waitForSelector(surface.root, { state: 'detached', timeout: 3000 });
  } catch {
    failures.push(`${surface.name}: Escape did not close the overlay`);
    await surface.recover(page).catch(() => {});
  }
  const afterClose = await snapshot();
  record.afterClose = afterClose;
  if (surface.kind === 'modal') {
    const facts = await probe(page, modalFocusRestoreFacts, { trigger: surface.trigger ?? '' });
    const decision = modalFocusRestoreDecision(facts);
    record.focusRestoreBranch = decision.branch;
    record.focusReturnedToTrigger = decision.branch === 'trigger' && decision.pass;
    record.focusRestore = {
      branch: decision.branch, pass: decision.pass,
      triggerRestorable: facts.triggerRestorable, activeElement: facts.activeElement,
    };
    if (!decision.pass) {
      const expected = decision.branch === 'trigger'
        ? 'the trigger'
        : 'the focused pane composer or the main region, not body';
      failures.push(`${surface.name}: Escape focus branch ${decision.branch} did not land on ${expected} (${facts.activeElement})`);
    }
  } else {
    const controller = afterClose.controller ?? {};
    if (controller.found) {
      if (!controller.hasFocus) failures.push(`${surface.name}: focus did not stay on the controller after Escape (${afterClose.activeElement})`);
      if (controller.ariaExpanded === 'true') failures.push(`${surface.name}: controller aria-expanded still "true" after Escape close`);
    }
  }
  try {
    // Rapid open-close-open. The palette reset between cycles clears the
    // composer with select-all + Backspace first, exactly like a user who
    // dismisses the palette and starts a fresh '/' (D3).
    if (surface.reset) await surface.reset(page);
    await surface.open(page);
    await surface.close(page);
    if (surface.reset) await surface.reset(page);
    await surface.open(page);
  } catch (error) {
    failures.push(`${surface.name}: rapid open-close-open could not re-open the overlay${surface.reset ? ' even after clearing the composer first' : ''} (${errLine(error)})`);
    await surface.recover(page).catch(() => {});
    return { record, failures, screenshots: [shot] };
  }
  try {
    await page.waitForSelector(surface.root, { state: 'visible', timeout: 3000 });
  } catch { /* counted below */ }
  // File palette options arrive after a debounced fetch: settle them before
  // the census so "interactive" cannot race an empty, still-loading list.
  if (surface.paletteReady) await page.waitForSelector(surface.paletteReady, { timeout: 3000 }).catch(() => {});
  const rapid = await snapshot();
  record.afterRapidCycle = rapid;
  if (rapid.count !== 1) failures.push(`${surface.name}: rapid open-close-open left ${rapid.count} overlays, expected exactly 1`);
  else if (rapid.interactiveCount < 1) failures.push(`${surface.name}: the single overlay left after the rapid cycle exposes no interactive element`);
  if (surface.kind === 'modal') {
    if (!rapid.activeInside) failures.push(`${surface.name}: focus not inside dialog after rapid open-close-open (${rapid.activeElement})`);
  } else {
    const controller = rapid.controller ?? {};
    if (controller.found) {
      if (!controller.hasFocus) failures.push(`${surface.name}: focus not on the controller after rapid open-close-open (${rapid.activeElement})`);
      if (controller.ariaExpanded !== 'true') failures.push(`${surface.name}: controller aria-expanded is ${controller.ariaExpanded ?? 'missing'} after rapid re-open`);
    }
  }
  if (surface.tabIntoPanel) {
    await page.keyboard.press('Tab');
    const afterTab = await snapshot();
    record.afterTabFromTrigger = afterTab;
    if (!afterTab.activeInside) failures.push(`${surface.name}: a single Tab from the trigger did not move focus into the panel (${afterTab.activeElement})`);
  }
  await surface.close(page).catch(() => {});
  await surface.recover(page).catch(() => {});
  return { record, failures, screenshots: [shot] };
}

/** R3 (S12): the new-chat dialog opens through NATIVE POINTER ENTRY ONLY.
 * The tree row reveals its actions on :hover/:focus-within, so hover the
 * row first and then click the button with a real pointer. A click that
 * cannot reach the button - covered by an overlay, pointer-events:none, or
 * a zero-size box - must propagate its failure so S12 records it: the
 * round-2 review's executed counterexample showed the old
 * dispatchEvent('click') fallback letting an unreachable trigger still
 * produce a passing overlay cycle. Exported so the unit tests can prove a
 * deliberately blocked native trigger fails the scenario. */
export async function openNewChatDialogNative(page) {
  if (!(await page.locator('.th-tree-node').first().isVisible().catch(() => false))) {
    await openMobileDrawer(page);
  }
  await page.locator('.th-tree-node').first().hover().catch(() => {});
  await page.locator('button[title="Add chat session"]').first().click({ timeout: 4000 });
  await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
}

/** The new-chat surface spec, shared with the R3 unit tests (frozen: the
 * driver only reads it). entryMethod records that every cycle enters through
 * native pointer input - a synthetic dispatch can no longer stand in. */
export const NEW_CHAT_DIALOG_SURFACE = Object.freeze({
  name: 'new-chat-dialog', kind: 'modal', root: '.th-modal',
  trigger: 'button[title="Add chat session"]', glassGated: true, entryMethod: 'native',
  open: openNewChatDialogNative,
  close: async page => { await page.keyboard.press('Escape'); },
  recover: async page => { await page.keyboard.press('Escape'); },
});

async function driveOverlays(browser, ctx) {
  const env = await setupOverlays(browser, ctx);
  const surfaces = [
    {
      name: 'settings-menu', kind: 'popover', root: '.th-settings-panel',
      controller: '.th-settings-menu > button', glassGated: true, tabIntoPanel: true,
      entryMethod: 'native',
      // Desktop: the trigger sits in the sidebar footer. Mobile: the sidebar
      // is the drawer, so clickThroughRealEntry opens it via the hamburger.
      open: async page => {
        await clickThroughRealEntry(page, '.th-settings-menu > button');
        await page.waitForSelector('.th-settings-panel', { timeout: 3000 });
      },
      close: async page => { await page.keyboard.press('Escape'); },
      recover: async page => {
        await page.click('.th-settings-menu > button.th-btn-icon--on').catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
      },
    },
    NEW_CHAT_DIALOG_SURFACE,
    {
      name: 'slash-palette', kind: 'popover', root: '.th-chat-slash',
      controller: '.th-chat-input textarea', palette: true, glassGated: false,
      entryMethod: 'keyboard',
      // Palette glass is gated by T2/S9, recorded but not failed here.
      open: async page => {
        // O1: at 390 a mobile drawer left open by an earlier surface occludes
        // the left part of the palette capture; dismiss it first so the
        // screenshot records the palette on a clean surface.
        await closeMobileDrawer(page);
        await page.focus('.th-chat-input textarea');
        await page.keyboard.press('/');
        await page.waitForSelector('.th-chat-slash', { timeout: 3000 });
      },
      close: async page => { await page.keyboard.press('Escape'); },
      reset: clearComposer,
      recover: async page => {
        await clearComposer(page).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
      },
    },
    {
      name: 'file-palette', kind: 'popover', root: '.th-chat-files',
      controller: '.th-chat-input textarea', palette: true,
      paletteReady: '.th-chat-files [role="option"]', glassGated: false, entryMethod: 'keyboard',
      // Same T2/S9 glass carve-out as the slash palette.
      open: async page => {
        await closeMobileDrawer(page);
        await page.focus('.th-chat-input textarea');
        await page.keyboard.type('@');
        await page.waitForSelector('.th-chat-files', { timeout: 3000 });
      },
      close: async page => { await page.keyboard.press('Escape'); },
      reset: clearComposer,
      recover: async page => {
        await clearComposer(page).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
      },
    },
    {
      name: 'confirm-dialog', kind: 'modal', root: '.th-modal',
      trigger: 'button[title="Delete workspace"]', glassGated: true, entryMethod: 'native',
      // Real entry: reveal the workspace row actions with a real pointer
      // hover, then click its delete action. While the modal is open the
      // product keeps the recorded action revealed
      // (.th-tree-actions[data-th-restore-focus]) so the trigger branch is
      // the expected focus restoration after Escape.
      open: async page => {
        if (!(await page.locator('.th-tree-workspace .th-tree-node').first().isVisible().catch(() => false))) {
          await openMobileDrawer(page);
        }
        await page.locator('.th-tree-workspace .th-tree-node').first().hover();
        await page.locator('button[title="Delete workspace"]').first().click({ timeout: 4000 });
        await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
      },
      close: async page => { await page.keyboard.press('Escape'); },
      recover: async page => { await page.keyboard.press('Escape'); },
    },
    {
      name: 'wizard-modal', kind: 'modal', root: '.th-modal',
      trigger: '.th-btn-add', glassGated: true, entryMethod: 'native',
      open: async page => {
        await clickThroughRealEntry(page, '.th-btn-add');
        await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
      },
      close: async page => { await page.keyboard.press('Escape'); },
      recover: async page => { await page.keyboard.press('Escape'); },
    },
    {
      name: 'question-window', kind: 'modal', root: '.th-modal', glassGated: true, entryMethod: 'native',
      // System-initiated modal: the provider delivers a question frame, the
      // notice band carries it, and the band's Open button is the real user
      // entry. Escape folds the window back to the band and hands focus to
      // the pane composer (the documented G25 fallback), so no trigger
      // selector is asserted - the fallback branch is this surface's
      // contract, mirroring S23's narrow-width expectation.
      open: async page => {
        // A newly delivered question auto-opens its window (useRequestWindow
        // arrival "open"), so the first entry is the frame itself; after a
        // collapse the band's Open button is the real re-entry. The band
        // sits UNDER the open modal, so it is only clickable when no window
        // is showing.
        if (!(await page.locator('.th-modal-overlay').first().isVisible().catch(() => false))) {
          if (await page.locator('.th-question-band').first().isVisible().catch(() => false)) {
            await page.locator('.th-question-band-open').first().click();
          } else {
            await env.fixture.deliver(CHAT, {
              type: 'approval', id: 'qa-s12-question', method: 'question',
              title: 'QA question', message: 'Proceed with the visual redesign check?',
              questions: [{ id: 'q1', question: 'Proceed with the visual redesign check?' }],
            });
          }
        }
        await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
      },
      close: async page => { await page.keyboard.press('Escape'); },
      recover: async page => { await page.keyboard.press('Escape'); },
    },
  ];
  const measurements = { narrowViewport: await isNarrow(env.page), surfaces: [] };
  const failures = [];
  const screenshots = [];
  for (const surface of surfaces) {
    try {
      const cycle = await overlayCycle(env.page, ctx, surface);
      measurements.surfaces.push(cycle.record);
      failures.push(...cycle.failures);
      screenshots.push(...cycle.screenshots);
    } catch (error) {
      failures.push(`${surface.name}: harness error ${errLine(error)}`);
      await surface.recover(env.page).catch(() => {});
    } finally {
      await closeMobileDrawer(env.page);
    }
  }
  measurements.motion = await motionSweep(env.page);
  return {
    scenario: 'S12', pass: failures.length === 0, measurements: withPageErrors(env, measurements),
    failures, screenshots, teardown: await env.close(),
  };
}

/** R4 (S15/S16): a required interaction that cannot be performed (timeout,
 * unreachable real entry point) is a FAILURE, never a swallowed note, and an
 * interaction that succeeds must still yield an in-state motion inspection.
 * Pure so the unit tests can prove a broken interaction fails the scenario
 * (review counterexample: "modal: click: Timeout 8000ms exceeded" used to
 * land in interactionNotes while the cell still passed). */
export function requiredInteractionVerdict(records) {
  const failures = [];
  for (const record of records ?? []) {
    if (record.error) failures.push(`required interaction "${record.label}" failed: ${record.error}`);
    else if (record.inspected !== true) failures.push(`required interaction "${record.label}" produced no in-state motion inspection`);
  }
  return failures;
}

/** S15 - motion hygiene. Every required interaction keeps its triggered
 * state OPEN while the animation inventory is taken (R4: inspect during the
 * state, not only after closing it), and every open/close/interaction is
 * driven through the surface's real entry point (hover-revealed tree
 * actions, mobile drawer for sidebar-dwelling triggers). */
async function driveMotion(browser, ctx) {
  const env = await setupOverlays(browser, ctx);
  const page = env.page;
  const failures = [];
  const interactions = [];
  const interact = async (label, { open, close } = {}) => {
    const record = { label };
    interactions.push(record);
    try {
      await open(page);
      record.inspected = true;
      const during = await probe(page, probeMotion);
      record.animationCount = during.measurements.animationCount;
      record.violating = (during.measurements.violating ?? []).length;
      for (const failure of during.failures) failures.push(`${label} (while open): ${failure}`);
    } catch (error) {
      record.error = errLine(error);
      failures.push(...requiredInteractionVerdict([record]));
      return;
    }
    if (!close) {
      // Narrow cells: still close any drawer a sidebar-dwelling entry opened.
      await closeMobileDrawer(page);
      return;
    }
    try {
      await close(page);
    } catch (error) {
      failures.push(`required interaction "${label}" close failed: ${errLine(error)}`);
    }
    // Narrow cells: interactions that live in the drawer leave it open; a
    // still-open drawer occludes every later target (S16 390 finding).
    await closeMobileDrawer(page);
  };
  await interact('settings', {
    open: async p => {
      await clickThroughRealEntry(p, '.th-settings-menu > button');
      await p.waitForSelector('.th-settings-panel', { timeout: 3000 });
    },
    close: async p => {
      await p.keyboard.press('Escape');
      await p.waitForSelector('.th-settings-panel', { state: 'detached', timeout: 3000 });
    },
  });
  await interact('modal', {
    open: async p => {
      if (!(await p.locator('.th-tree-node').first().isVisible().catch(() => false))) await openMobileDrawer(p);
      await p.locator('.th-tree-node').first().hover().catch(() => {});
      await p.locator('button[title="Add chat session"]').first().click({ timeout: 4000 });
      await p.waitForSelector('.th-modal-overlay', { timeout: 3000 });
    },
    close: async p => {
      await p.keyboard.press('Escape');
      await p.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 3000 });
    },
  });
  await interact('palette', {
    open: async p => {
      await closeMobileDrawer(p);
      await p.focus('.th-chat-input textarea');
      await p.keyboard.press('/');
      await p.waitForSelector('.th-chat-slash', { timeout: 3000 });
    },
    close: async p => { await p.keyboard.press('Escape'); },
  });
  await interact('file-palette', {
    open: async p => {
      // The slash interaction's Escape leaves '/' in the composer; the file
      // trigger needs a clean '@' token, so clear it the way a user does.
      await closeMobileDrawer(p);
      await clearComposer(p).catch(() => {});
      await p.focus('.th-chat-input textarea');
      await p.keyboard.type('@');
      await p.waitForSelector('.th-chat-files', { timeout: 3000 });
    },
    close: async p => { await p.keyboard.press('Escape'); },
  });
  await interact('shelf', {
    open: async p => {
      await p.click('[data-activity-tab="todo"]');
      await p.waitForSelector('[data-activity-tab="todo"][aria-selected="true"]', { timeout: 3000 });
    },
  });
  failures.push(...requiredInteractionVerdict(interactions));
  const result = await probe(page, probeMotion);
  result.measurements.interactions = interactions;
  const shot = await screenshot(page, ctx, '');
  await closeMobileDrawer(page);
  // Merge, never overwrite: probeMotion's own failures-only spread used to
  // drop the interaction failures accumulated above (the round-2 false pass
  // where a timed-out file-palette interaction left the cell green).
  return {
    ...result,
    pass: result.pass && failures.length === 0,
    failures: [...result.failures, ...failures],
    measurements: withPageErrors(env, result.measurements),
    screenshots: [shot], teardown: await env.close(),
  };
}

/** S16 - reduced-motion collapse, exercised (R4): the static page is
 * probed, then every overlay entrance and disclosure is opened WITH the
 * preference already active and probed while the triggered state is open -
 * a finite entrance animation that only exists for the few hundred ms a
 * modal is entering must fail here, not after everything has closed. */
async function driveReducedMotion(browser, ctx) {
  const env = await setupOverlays(browser, ctx);
  const page = env.page;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const failures = [];
  const measurements = { narrowViewport: await isNarrow(page) };
  const initial = await probe(page, probeReducedMotion);
  measurements.initial = initial.measurements;
  failures.push(...initial.failures.map(f => `static page: ${f}`));
  const states = [];
  const inspect = async (surface, open, close) => {
    try {
      await open(page);
      const result = await probe(page, probeReducedMotion);
      states.push({ surface, pass: result.pass, ...result.measurements });
      failures.push(...result.failures.map(f => `${surface} (open under reduced motion): ${f}`));
      if (close) await close(page).catch(() => {});
      // Narrow cells: the drawer opened for a sidebar-dwelling entry must not
      // cover the next disclosure target (S16 390 finding) - also for
      // state-change interactions that have no close step of their own.
      await closeMobileDrawer(page);
    } catch (error) {
      states.push({ surface, error: errLine(error) });
      failures.push(`required interaction "${surface}" failed under reduced motion: ${errLine(error)}`);
    }
  };
  await inspect('settings', async p => {
    await clickThroughRealEntry(p, '.th-settings-menu > button');
    await p.waitForSelector('.th-settings-panel', { timeout: 3000 });
  }, async p => {
    await p.keyboard.press('Escape');
    await p.waitForSelector('.th-settings-panel', { state: 'detached', timeout: 3000 });
  });
  await inspect('modal', async p => {
    if (!(await p.locator('.th-tree-node').first().isVisible().catch(() => false))) await openMobileDrawer(p);
    await p.locator('.th-tree-node').first().hover().catch(() => {});
    await p.locator('button[title="Add chat session"]').first().click({ timeout: 4000 });
    await p.waitForSelector('.th-modal-overlay', { timeout: 3000 });
  }, async p => {
    await p.keyboard.press('Escape');
    await p.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 3000 });
  });
  await inspect('slash-palette', async p => {
    await closeMobileDrawer(p);
    await p.focus('.th-chat-input textarea');
    await p.keyboard.press('/');
    await p.waitForSelector('.th-chat-slash', { timeout: 3000 });
  }, async p => { await p.keyboard.press('Escape'); });
  await inspect('file-palette', async p => {
    await clearComposer(p).catch(() => {});
    await p.focus('.th-chat-input textarea');
    await p.keyboard.type('@');
    await p.waitForSelector('.th-chat-files', { timeout: 3000 });
  }, async p => {
    await p.keyboard.press('Escape');
    await clearComposer(p).catch(() => {});
  });
  await inspect('goal-disclosure', async p => {
    await p.locator('button.th-goal-bar').first().click();
    await p.waitForSelector('button.th-goal-bar[aria-expanded="true"]', { timeout: 3000 });
  });
  await inspect('shelf-tab', async p => {
    await p.click('[data-activity-tab="todo"]');
    await p.waitForSelector('[data-activity-tab="todo"][aria-selected="true"]', { timeout: 3000 });
  });
  measurements.openStates = states;
  const shot = await screenshot(page, ctx, '');
  await closeMobileDrawer(page);
  return {
    scenario: 'S16', pass: failures.length === 0,
    measurements: withPageErrors(env, measurements), failures, screenshots: [shot], teardown: await env.close(),
  };
}

/** G26 (extended S19): realistic happy-path payloads so the wizard and the
 * system stats modal render normal content instead of the fixture's 404
 * error bodies. The wizard browses from the empty path first, so both '' and
 * the canonical '/fixture' resolve to the same seeded listing. */
const G26_WIZARD_DIRS = Object.freeze({
  '': Object.freeze({ path: '/fixture', parent: null, dirs: Object.freeze(['docs', 'packages', 'src']) }),
  '/fixture': Object.freeze({ parent: null, dirs: Object.freeze(['docs', 'packages', 'src']) }),
});
const G26_SYSTEM_STATS = Object.freeze({
  cpuPercent: 12.4, memTotalBytes: 17179869184, memUsedBytes: 9663631360, memPercent: 56.3,
  numGoroutine: 42, goHeapAllocBytes: 63297456, uptimeSeconds: 86340,
  os: 'darwin', arch: 'arm64', numCpu: 8,
});

/** setupDesign on a fixture seeded with the G26 payloads (wizard directory
 * listing + system stats). S19 captures these surfaces in a normal state. */
async function setupSurfaces(browser, options = {}) {
  const fixture = startFixture({
    ...designSeed(options.layout ?? 'single'),
    dirs: G26_WIZARD_DIRS, systemStats: G26_SYSTEM_STATS, ...options.seed, port: 0,
  });
  let context;
  try {
    context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
      colorScheme: options.theme ?? 'dark',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await installSignals(page, options);
    const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
    await page.goto(fixture.url);
    await attached;
    await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-queue-header')
      && document.querySelector('.th-activity-shelf [data-activity-tab]')
      && document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
      && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
    await seedLive(page, fixture);
    return {
      page, context, fixture, errors,
      async close() {
        await context.close();
        return { contextClosed: true, url: fixture.url, ...await fixture.stop() };
      },
    };
  } catch (error) {
    if (context) await context.close();
    const cleanup = await fixture.stop();
    throw new Error(`Surfaces setup failed; cleanup=${JSON.stringify(cleanup)}`, { cause: error });
  }
}

/** G27: computed facts of the wizard's primary footer action - disabled
 * attribute plus the resolved token values it must match in each state.
 * Transitions first: .th-btn animates background over --th-dur-fast, so a
 * fact read in the same frame a state flips returns the START colour (the
 * round-1 blocked measurement read pure accent at t=0). */
async function wizardPrimaryFacts(page, selector) {
  await page.evaluate(sel => {
    const button = document.querySelector(sel);
    return Promise.allSettled((button ? button.getAnimations() : []).map(animation => animation.finished));
  }, selector);
  return page.evaluate(sel => {
    const button = document.querySelector(sel);
    const style = button ? getComputedStyle(button) : null;
    const root = getComputedStyle(document.documentElement);
    return {
      disabled: button ? button.disabled : null,
      background: style ? style.backgroundColor : null,
      accentSolid: root.getPropertyValue('--th-accent-solid').trim(),
      disabledBg: root.getPropertyValue('--th-disabled-bg').trim(),
    };
  }, selector);
}

/** R2 (S19): readiness for the file-editor capture - measure the LOADED
 * editor, never its loading placeholder. `.th-editor` mounts while fsRead
 * is still pending and its body then holds only the header plus the
 * Loading… status (the round-2 review directly observed five of six
 * captures in exactly that state). Readiness is the real textarea carrying
 * the seeded /fixture/session.ts content with no loading/error status
 * left, so a read that never settles - or lands on the error alert -
 * fails the surface here instead of being captured as if it were the
 * editor. */
async function waitForLoadedEditor(page) {
  await page.waitForFunction(needle => {
    const editor = document.querySelector('.th-editor');
    if (!editor || editor.querySelector('.th-editor-status')) return false;
    const area = editor.querySelector('textarea.th-editor-area');
    return !!area && area.value === needle;
  }, fileContent, { timeout: 8000 });
}

async function driveSurfaces(browser, ctx) {
  const env = await setupSurfaces(browser, ctx);
  const page = env.page;
  const measurements = { narrowViewport: await isNarrow(page), surfaces: [] };
  const failures = [];
  const screenshots = [];
  // D7: every surface screenshot waits for enter animations to settle; D5:
  // every sidebar-dwelling entry is clicked through the mobile drawer on
  // narrow viewports, and the drawer is closed again so each scan sees the
  // same chrome as its desktop counterpart.
  const scan = async (surface, settleRoot, prepare) => {
    try {
      await prepare();
      const result = await probe(page, probeContrastSurface, { surface, bodyMin: CONTRAST_BODY_MIN, faintMin: CONTRAST_FAINT_MIN });
      measurements.surfaces.push({ surface, pass: result.pass, measurements: result.measurements });
      failures.push(...result.failures.map(f => `${surface}: ${f}`));
      await settleAnimations(page, settleRoot);
      screenshots.push(await screenshot(page, ctx, `-${surface}`));
    } catch (error) {
      failures.push(`${surface}: harness error ${errLine(error)}`);
    }
  };
  await scan('file-browser', '.th-files-resize', async () => {
    await clickThroughRealEntry(page, '.th-files-toggle');
    await page.waitForSelector('.th-files-head', { timeout: 4000 });
  });
  // S19: the file EDITOR itself, through its real entry - click the file
  // row's open-editor link in the still-open browser panel. R2: the contrast
  // walk and the screenshot run only after the real textarea carries the
  // seeded file content with the Loading… placeholder gone and the enter
  // animations settled, so both record the LOADED editor at every width.
  await scan('file-editor', '.th-editor', async () => {
    if (!(await page.locator('.th-files-head').isVisible().catch(() => false))) {
      await clickThroughRealEntry(page, '.th-files-toggle');
      await page.waitForSelector('.th-files-head', { timeout: 4000 });
    }
    await page.locator('.th-files-name--link').first().click();
    await page.waitForSelector('.th-editor', { timeout: 4000 });
    await waitForLoadedEditor(page);
    await settleAnimations(page, '.th-editor');
    measurements.fileEditorLoaded = await page.evaluate(() => {
      const editor = document.querySelector('.th-editor');
      const area = editor?.querySelector('textarea.th-editor-area') ?? null;
      return {
        loaded: !!area && !editor?.querySelector('.th-editor-status'),
        hasLoadingStatus: !!editor?.querySelector('.th-editor-status'),
        file: area?.getAttribute('aria-label') ?? null,
        contentLength: area?.value.length ?? 0,
        contentPreview: area?.value.slice(0, 48) ?? null,
      };
    });
  });
  await page.click('button[title="Close editor"]').catch(() => {});
  await page.waitForSelector('.th-editor', { state: 'detached', timeout: 3000 }).catch(() => {});
  // Close through the panel's own affordance: at mobile the panel covers the
  // whole pane (container <=494px => width 100%), so the header toggle it
  // opened with is no longer clickable - the head's close button is the
  // real user's exit path.
  await page.click('.th-files-head > button.th-btn-icon').catch(() => {});
  await page.waitForSelector('.th-files', { state: 'detached', timeout: 3000 }).catch(() => {});
  await closeMobileDrawer(page);
  await scan('settings-menu', '.th-settings-panel', async () => {
    await clickThroughRealEntry(page, '.th-settings-menu > button');
    await page.waitForSelector('.th-settings-panel', { timeout: 4000 });
  });
  await page.keyboard.press('Escape').catch(() => {});
  await closeMobileDrawer(page);
  await scan('system-stats', '.th-modal', async () => {
    await clickThroughRealEntry(page, '.th-settings-menu > button');
    await page.waitForSelector('.th-settings-panel', { timeout: 4000 });
    await page.click('.th-settings-item:has-text("System status")');
    await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
    await page.waitForSelector('.th-stats-grid .th-stats-row', { timeout: 4000 });
  });
  // G26: the stats modal must carry the seeded happy-path payload, not a
  // 404 error body (the modal renders seven combined rows for the ten
  // payload fields - the floor is "real content", not a field count).
  const statsPayload = await page.evaluate(() => ({
    rows: document.querySelectorAll('.th-stats-grid .th-stats-row').length,
    errorAlert: !!document.querySelector('.th-stats .th-alert--error'),
    firstValue: document.querySelector('.th-stats-value')?.textContent?.trim() ?? null,
  })).catch(() => null);
  measurements.systemStatsPayload = statsPayload;
  if (!statsPayload || statsPayload.errorAlert || statsPayload.rows < 5 || !statsPayload.firstValue) {
    failures.push(`system-stats: G26 happy-path payload not rendered (${JSON.stringify(statsPayload)})`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await closeMobileDrawer(page);
  const wizardPrimary = '.th-wizard-foot .th-btn--primary';
  await scan('workspace-wizard', '.th-modal', async () => {
    await clickThroughRealEntry(page, '.th-btn-add');
    await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
    await page.waitForSelector('.th-picker-row', { timeout: 4000 });
  });
  // G26: the wizard must show the seeded directory listing, not an error.
  const wizardPayload = await page.evaluate(() => ({
    rows: document.querySelectorAll('.th-picker-row').length,
    errorAlert: !!document.querySelector('.th-wizard-body .th-alert--error'),
    path: document.querySelector('.th-picker-path-text')?.textContent ?? null,
  })).catch(() => null);
  measurements.wizardPayload = wizardPayload;
  if (!wizardPayload || wizardPayload.errorAlert || wizardPayload.rows < 1) {
    failures.push(`workspace-wizard: G26 directory listing not rendered (${JSON.stringify(wizardPayload)})`);
  }
  // G27: primary action is accent-solid when enabled, visibly disabled when
  // blocked (cleared name input on the step the wizard itself advances to).
  try {
    await page.waitForSelector(`${wizardPrimary}:not([disabled])`, { timeout: 4000 });
    const enabled = await wizardPrimaryFacts(page, wizardPrimary);
    measurements.wizardPrimary = { enabled };
    if (enabled.disabled) failures.push('workspace-wizard: primary action carries the disabled attribute while enabled (G27)');
    if (!colorEquals(parseColor(enabled.background), parseColor(enabled.accentSolid))) {
      failures.push(`workspace-wizard: enabled primary background ${enabled.background} != --th-accent-solid ${enabled.accentSolid} (G27)`);
    }
    await page.click(wizardPrimary);
    await page.waitForSelector('.th-wizard-body .th-input', { timeout: 4000 });
    await page.focus('.th-wizard-body .th-input');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.waitForSelector(`${wizardPrimary}[disabled]`, { timeout: 3000 });
    const blocked = await wizardPrimaryFacts(page, wizardPrimary);
    measurements.wizardPrimary.blocked = blocked;
    if (!blocked.disabled) failures.push('workspace-wizard: blocked primary lacks the disabled attribute (G27)');
    if (!colorEquals(parseColor(blocked.background), parseColor(blocked.disabledBg))) {
      failures.push(`workspace-wizard: blocked primary background ${blocked.background} != --th-disabled-bg ${blocked.disabledBg} (G27)`);
    }
    if (colorEquals(parseColor(blocked.background), parseColor(blocked.accentSolid))) {
      failures.push('workspace-wizard: blocked primary still uses the accent fill - not visibly disabled (G27)');
    }
    await settleAnimations(page, '.th-modal');
    screenshots.push(await screenshot(page, ctx, '-workspace-wizard-blocked'));
  } catch (error) {
    failures.push(`workspace-wizard: G27 primary-action check failed: ${errLine(error)}`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await closeMobileDrawer(page);
  // Login: a second page in the same context with the auth check rejected.
  await env.context.route('**/api/auth/check', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  const loginPage = await env.context.newPage();
  const savedPage = env.page;
  env.page = loginPage;
  const savedErrors = env.errors;
  try {
    await loginPage.goto(env.fixture.url);
    await loginPage.waitForSelector('.th-login', { timeout: 6000 });
    await settleAnimations(loginPage, '.th-login');
    const result = await probe(loginPage, probeContrastSurface, { surface: 'login', bodyMin: CONTRAST_BODY_MIN, faintMin: CONTRAST_FAINT_MIN });
    measurements.surfaces.push({ surface: 'login', pass: result.pass, measurements: result.measurements });
    failures.push(...result.failures.map(f => `login: ${f}`));
    screenshots.push(await screenshot(loginPage, ctx, '-login'));
  } catch (error) {
    failures.push(`login: harness error ${errLine(error)}`);
  } finally {
    await env.context.unroute('**/api/auth/check').catch(() => {});
    await loginPage.close().catch(() => {});
    env.page = savedPage;
    env.errors = savedErrors;
  }
  return {
    scenario: 'S19', pass: failures.length === 0, measurements: withPageErrors(env, measurements),
    failures, screenshots, teardown: await env.close(),
  };
}

/** Refined S20: meta theme-color equals the active --th-bg in both themes
 * AND updates when the theme is switched through the real settings control;
 * the static PWA manifest equals the :root dark-default --th-bg in both
 * themes (a single static manifest cannot carry two). */
async function driveChromeTheme(browser, ctx) {
  const env = await setupDesign(browser, ctx);
  const page = env.page;
  const failures = [];
  const measurements = { narrowViewport: await isNarrow(page) };
  const probeTheme = () => probe(page, probeChromeTheme, { darkBg: THEME_EXPECTATIONS.dark.bg });
  const initial = await probeTheme();
  measurements.initial = initial.measurements;
  failures.push(...initial.failures.map(f => `initial (${ctx.theme}): ${f}`));
  const target = ctx.theme === 'dark' ? 'Light' : 'Dark';
  try {
    await clickThroughRealEntry(page, '.th-settings-menu > button');
    await page.waitForSelector('.th-settings-panel', { timeout: 4000 });
    await page.click(`.th-settings-panel [role="radio"]:has-text("${target}")`);
    await page.waitForFunction(label => document.documentElement.getAttribute('data-theme') === label.toLowerCase(), target, { timeout: 4000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.th-settings-panel', { state: 'detached', timeout: 3000 });
  } catch (error) {
    failures.push(`theme switch through the settings control failed: ${errLine(error)}`);
  }
  const after = await probeTheme();
  measurements.afterSwitch = after.measurements;
  failures.push(...after.failures.map(f => `after switch (${target.toLowerCase()}): ${f}`));
  measurements.metaUpdatedOnSwitch = initial.measurements?.metaThemeColor !== after.measurements?.metaThemeColor;
  if (!measurements.metaUpdatedOnSwitch) {
    failures.push(`meta theme-color did not update on theme switch (stayed ${after.measurements?.metaThemeColor})`);
  }
  await closeMobileDrawer(page);
  const shot = await screenshot(page, ctx, '-after-switch');
  return { scenario: 'S20', pass: failures.length === 0, measurements: withPageErrors(env, measurements), failures, screenshots: [shot], teardown: await env.close() };
}

/** Hold :hover on the session row across Escape. A real pointer hover
 * is cleared whenever the dialog's backdrop becomes the hit target, which
 * hides the row action before focus restoration runs. Forcing the pseudo
 * state keeps that action visible so the desktop branch can require the
 * trigger. The session stays attached through the assertion; detaching
 * earlier drops the action and can move focus off the trigger. */
async function holdTreeRowHover(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const doc = await client.send('DOM.getDocument');
  const found = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.th-tree-node' });
  if (!found.nodeId) throw new Error('session row not found to hold hover');
  await client.send('CSS.forcePseudoState', { nodeId: found.nodeId, forcedPseudoClasses: ['hover'] });
  return client;
}

/** S23 - G25 focus restoration for the new-chat dialog.
 * Narrow (390): open the mobile drawer, activate Add chat session, Escape.
 * The pointer leaves the row first so the hover-only action is hidden;
 * focus must be the composer or main, never body.
 * Desktop (1280): hover the session row so the trigger is visible, activate
 * it, hold that hover, Escape; focus must return to the trigger. */
async function driveFocusRestore(browser, ctx) {
  const env = await setupOverlays(browser, ctx);
  const narrow = ctx.viewport.width <= 768;
  const failures = [];
  const measurements = { narrowViewport: narrow, viewport: ctx.viewport.label };
  const trigger = 'button[title="Add chat session"]';
  let hoverClient = null;
  try {
    const page = env.page;
    if (narrow) await openMobileDrawer(page);
    const button = page.locator(trigger).first();
    await page.locator('.th-tree-node').first().hover();
    await button.click({ timeout: 4000 });
    await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
    const title = (await page.locator('#th-new-chat-title').textContent())?.trim() ?? '';
    measurements.dialogOpened = true;
    measurements.dialogTitle = title;
    if (title !== 'New chat') failures.push(`new chat dialog title was ${title || 'missing'}`);
    if (narrow) await page.mouse.move(12, 12);
    else hoverClient = await holdTreeRowHover(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 3000 });
    const facts = await probe(page, modalFocusRestoreFacts, { trigger });
    const decision = modalFocusRestoreDecision(facts);
    measurements.focusRestore = { branch: decision.branch, pass: decision.pass, ...facts };
    // G25: the trigger wins whenever it can still take focus (the product
    // keeps the recorded row action revealed while its modal is open);
    // the fallback branch is required only when the trigger cannot. The
    // hidden-trigger fallback itself is pinned by modalStack.test.ts.
    const wanted = facts.triggerRestorable ? 'trigger' : 'fallback';
    measurements.expectedBranch = wanted;
    if (decision.branch !== wanted || !decision.pass) {
      failures.push(`${narrow ? 'narrow' : 'desktop'}: expected ${wanted} focus, branch ${decision.branch} on ${facts.activeElement}`);
    }
    if (facts.activeIsBody) failures.push('focus fell through to body');
  } catch (error) {
    failures.push(`focus restore probe failed: ${errLine(error)}`);
  } finally {
    if (hoverClient) await hoverClient.detach().catch(() => {});
  }
  let screenshots = [];
  try {
    screenshots = [await screenshot(env.page, ctx, '')];
  } catch (error) {
    failures.push(`focus restore screenshot failed: ${errLine(error)}`);
  }
  return {
    scenario: 'S23', pass: failures.length === 0, measurements: withPageErrors(env, measurements),
    failures, screenshots, teardown: await env.close(),
  };
}

const DRIVERS = {
  S1: driveTokens, S3: driveHierarchy, S4: driveSeparation, S5: driveStateColors,
  S6: driveHeader, S8: driveRunning, S12: driveOverlays, S15: driveMotion,
  S16: driveReducedMotion, S19: driveSurfaces, S20: driveChromeTheme,
  S23: driveFocusRestore,
};

// ---------------------------------------------------------------------------
// Per-task scenario plugins (see the contract in the header comment)
// ---------------------------------------------------------------------------

const PLUGIN_GLOB = 'visual-redesign-scenarios-*.mjs';

/** Import every plugin module in `dir` (sorted; later files override earlier
 * ones and everything overrides built-in stubs). Returns one entry per file
 * that exports a `scenarios` object. Exported for unit tests. */
export async function loadScenarioPlugins(dir) {
  const files = Array.from(new Bun.Glob(PLUGIN_GLOB).scanSync({ cwd: dir })).sort();
  const plugins = [];
  for (const file of files) {
    try {
      const module = await import(`${dir}/${file}`);
      if (module.scenarios && typeof module.scenarios === 'object') {
        plugins.push({ file, scenarios: module.scenarios });
      } else {
        plugins.push({ file, skipped: 'no scenarios export' });
      }
    } catch (error) {
      plugins.push({ file, skipped: `import failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return plugins;
}

/** Merge plugin probes over the built-in registry. Returns an ordered array
 * of { id, title, run, origin, stub, reason }. Built-in stubs and unknown ids
 * both get run=null. Exported for unit tests. */
export function buildScenarioRegistry(plugins) {
  const registry = new Map();
  for (const [id, meta] of Object.entries(SCENARIOS)) {
    registry.set(id, {
      id, title: meta.title, run: DRIVERS[id] ?? null,
      origin: DRIVERS[id] ? 'builtin' : 'stub',
      stub: Boolean(meta.stub), reason: meta.reason ?? null,
    });
  }
  for (const plugin of plugins) {
    for (const [id, run] of Object.entries(plugin.scenarios ?? {})) {
      if (typeof run !== 'function') continue;
      const previous = registry.get(id);
      registry.set(id, {
        id,
        title: previous?.title ?? `plugin scenario ${id}`,
        run, origin: `plugin:${plugin.file}`, stub: false, reason: null,
      });
    }
  }
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

async function screenshot(page, ctx, suffix) {
  const name = `${ctx.scenario}-${ctx.theme}-${ctx.viewport.label}${suffix}.png`;
  await page.screenshot({ path: join(ctx.shotsDir, name), fullPage: false });
  return `screenshots/${name}`;
}

function withPageErrors(env, measurements) {
  return { ...measurements, pageErrors: env.errors.slice(0, 5) };
}

async function loadBaseline(options) {
  const path = options.baselineFile ?? join(options.evidence, 'baseline-counts.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const evidence = options.evidence;
  const shotsDir = join(evidence, 'screenshots');
  await mkdir(shotsDir, { recursive: true });

  const { chromium } = await import(process.env.QA_PLAYWRIGHT);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];

  try {
    const plugins = await loadScenarioPlugins(import.meta.dir);
    const registry = buildScenarioRegistry(plugins);
    const registryIds = registry.map(entry => entry.id);
    const baselineMode = options.baseline;
    let scenarioIds = options.scenarios;
    if (baselineMode) scenarioIds = ['S4', 'S5'];
    else if (!options.scenarios) scenarioIds = registry.filter(entry => !entry.stub && entry.run).map(entry => entry.id);
    if (options.scenarios) {
      for (const id of options.scenarios) if (!registryIds.includes(id)) throw new Error(`unknown scenario ${id} (known: ${registryIds.join(',')})`);
    }
    const baselineData = baselineMode ? null : await loadBaseline(options);
    const baselineCounts = {};

    for (const id of scenarioIds) {
      const entry = registry.find(candidate => candidate.id === id);
      if (!entry || entry.stub || !entry.run) {
        results.push({
          scenario: id, title: entry?.title ?? `scenario ${id}`, theme: null, viewport: null,
          pass: null, origin: entry?.origin ?? 'unknown',
          reason: entry?.reason ?? 'no probe registered for this id', detail: (entry && SCENARIOS[id]?.detail) ?? null,
        });
        continue;
      }
      for (const theme of options.themes) {
        for (const viewport of options.viewports) {
          const comboKey = `${theme}/${viewport.label}`;
          const ctx = {
            scenario: id, theme, viewport, shotsDir,
            evidenceDir: options.evidence,
            baseline: !baselineMode && baselineData?.counts?.[comboKey] ? baselineData.counts[comboKey] : null,
            setupDesign: (extra = {}) => setupDesign(browser, { theme, viewport: { width: viewport.width, height: viewport.height }, ...extra }),
            setupLive: (extra = {}) => setupLive(browser, { theme, viewport: { width: viewport.width, height: viewport.height }, ...extra }),
            probe, motionSweep,
            save: (page, suffix = '') => screenshot(page, { scenario: id, theme, viewport, shotsDir }, suffix),
            constants: { THEME_EXPECTATIONS, HIERARCHY_MIN_RATIO, CONTRAST_BODY_MIN, CONTRAST_FAINT_MIN, SEED_CWD, CHAT },
          };
          let result;
          try {
            result = await (entry.origin.startsWith('plugin:') ? entry.run(ctx) : entry.run(browser, ctx));
          } catch (error) {
            result = {
              scenario: id, theme, viewport: viewport.label, pass: false, measurements: {}, failures: [],
              screenshots: [],
            };
            result.failures.push(`harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          }
          if (baselineMode) {
            // Several scenarios share one theme/viewport combo; merge so a later
            // scenario never erases counts an earlier one measured.
            const m = result.measurements ?? {};
            const prior = baselineCounts[comboKey] ?? {};
            const keep = (key) => m[key] ?? prior[key] ?? null;
            baselineCounts[comboKey] = {
              borderedCount: keep('borderedCount'), nestedBorderedCount: keep('nestedBorderedCount'),
              stateColorViolationCount: keep('stateColorViolationCount'), uppercaseCount: keep('uppercaseCount'),
            };
            result.pass = null;
            result.reason = 'baseline capture';
          }
          results.push({
            scenario: id, title: entry.title, theme, viewport: viewport.label, pass: result.pass,
            origin: entry.origin,
            failures: result.failures ?? [], measurements: result.measurements ?? {},
            screenshots: result.screenshots ?? [], teardown: result.teardown ?? null,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          process.stdout.write(`${id} ${comboKey}: ${result.pass === null ? 'STUB/CAPTURE' : result.pass ? 'PASS' : `FAIL (${result.failures.length})`}\n`);
        }
      }
    }

    // S15 also audits the motion inventories every scenario recorded.
    const s15 = results.find(row => row.scenario === 'S15' && row.pass !== null);
    if (s15) {
      const contributed = [];
      for (const row of results) {
        const sweep = row.measurements?.motion ?? row.measurements?.motionSweep;
        if (!sweep || row.scenario === 'S15') continue;
        for (const entry of sweep.violating ?? []) {
          contributed.push(`${row.scenario} ${row.theme}/${row.viewport}: ${entry.kind} "${entry.name}" -> ${(entry.violations ?? []).join(', ')}`);
        }
      }
      if (contributed.length > 0) {
        s15.failures.push(...contributed.map(text => `collected during other scenarios: ${text}`));
        s15.pass = false;
      }
      s15.measurements.auditedScenarios = results.filter(row => row.measurements?.motion ?? row.measurements?.motionSweep)
        .map(row => `${row.scenario}/${row.theme ?? ''}${row.viewport ?? ''}`);
    }

    if (baselineMode) {
      await writeFile(join(evidence, 'baseline-counts.json'), `${JSON.stringify({
        generatedAt: new Date().toISOString(), note: 'captured by visual-redesign.mjs --baseline; S4 compares borderedCount <= 50% of this',
        counts: baselineCounts,
      }, null, 2)}\n`);
    }

    await writeFile(join(evidence, 'results.json'), `${JSON.stringify({
      generatedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
      args: { ...options, viewports: options.viewports.map(v => v.label) },
      plugins: plugins.map(plugin => ({ file: plugin.file, ...(plugin.skipped ? { skipped: plugin.skipped } : { scenarios: Object.keys(plugin.scenarios) }) })),
      scenarios: results,
    }, null, 2)}\n`);

    const combos = [];
    for (const theme of options.themes) for (const viewport of options.viewports) combos.push(`${theme} ${viewport.label}`);
    const lines = [
      '# Visual redesign QA', '',
      `Generated ${startedAt.toISOString()} · scenarios ${scenarioIds.join(',')} · themes ${options.themes.join(',')}${baselineMode ? ' · BASELINE CAPTURE' : ''}`, '',
      '| Scenario | Title | ' + combos.join(' | ') + ' |',
      '|---|---|' + combos.map(() => ':---:').join('|') + '|',
    ];
    const byId = new Map();
    for (const row of results) {
      if (!byId.has(row.scenario)) byId.set(row.scenario, []);
      byId.get(row.scenario).push(row);
    }
    for (const [id, rows] of byId) {
      const cells = combos.map(combo => {
        const row = rows.find(r => `${r.theme} ${r.viewport}` === combo);
        if (!row) return '—';
        if (row.pass === null) return 'CAPTURE';
        return row.pass ? 'PASS' : `FAIL(${row.failures.length})`;
      });
      lines.push(`| ${id} | ${SCENARIOS[id]?.title ?? registry.find(entry => entry.id === id)?.title ?? ''} | ${cells.join(' | ')} |`);
    }
    lines.push('', 'Stub scenarios report pass:null and never affect the exit code.', '');
    await writeFile(join(evidence, 'summary.md'), lines.join('\n'));

    const failed = results.filter(row => row.pass === false);
    process.stdout.write(`\nWrote ${join(evidence, 'results.json')}, summary.md, screenshots/ (${results.length} results, ${failed.length} failing)\n`);
    await browser.close();
    process.exitCode = failed.length > 0 ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (import.meta.main) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  });
}
