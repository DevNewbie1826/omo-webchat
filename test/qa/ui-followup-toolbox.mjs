/** QA_PLAYWRIGHT=<installed-driver> bun test/qa/ui-followup-toolbox.mjs --phase red|green --out ABSOLUTE_PATH
 *
 * P4 distinct tool panels — real-SPA failing-first baseline runner (brief C002,
 * toolbox lane). Boots the actual built App through an idle controlled fixture
 * and judges the tool-block material contract on the real page:
 *
 *   O1  every collapsed tool record paints an opaque scoped tool surface
 *       (never the transparent Canvas the prose sits on);
 *   O2  every collapsed tool record carries a persistent 1px solid boundary;
 *   O3  the material is persistent across the disclosure state (expanded
 *       .th-tool computes the same fill and border as collapsed);
 *   O4  the material is visibly distinct from ordinary assistant prose in
 *       both themes (prose stays transparent on Canvas; tool fill differs);
 *   O5  no whole-card status glow (box-shadow stays none for ok/running/error);
 *   O6  compact header density: 48px minimum, unchanged across the toggle;
 *   O7  disclosure choice, collapsed latest-output preview, localized status
 *       word and non-colour glyph stay intact;
 *   O8  expanded long (Korean) output stays bounded in an internally scrolled
 *       region capped at min(360px, 45dvh) — including live streaming output
 *       inside an expanded running record;
 *   O9  no horizontal page overflow at 390px with long Korean content.
 *
 * State matrix: running/completed/error x collapsed/expanded captured as real
 * screenshots — 6 state PNGs per scenario, 24 per phase.
 *
 * --phase red   succeeds only while the unchanged build still MISSES the P4
 *               material/boundary observables, recording which seam fails.
 * --phase green succeeds only when every observable passes in every scenario.
 * Scenario definitions are identical in both phases. No backend, user session
 * or profile is touched; every context/fixture closes in finally.
 *
 * Scenario inventory: {1280x800, 390x844} x {dark, light}; tools design-read
 * (completed, toggled collapsed->expanded), design-failed (error, auto-open,
 * toggled to collapsed), design-running (running, via the live seed); prose and
 * canvas comparison rows from the same transcript.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { designSeed, installSignals, arm, complete, seedLive, output as longOutput } from './design-workbench-fixture.mjs';
import { startFixture } from './pane-workspace-ui.mjs';
import { closeResources, exposeTranscript, settleFrame } from './ui-theme-evidence.mjs';

const SCENARIOS = [
  { label: '1280x800-dark', viewport: { width: 1280, height: 800 }, theme: 'dark' },
  { label: '1280x800-light', viewport: { width: 1280, height: 800 }, theme: 'light' },
  { label: '390x844-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
  { label: '390x844-light', viewport: { width: 390, height: 844 }, theme: 'light' },
];

/** Async git + built-asset snapshots: source and artifact stability of one
 *  run is recorded at start and end, never through synchronous process APIs. */
const git = promisify(execFile);
const gitSnapshot = async () => ({
  sha: (await git('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  tree: (await git('git', ['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
  dirty: (await git('git', ['status', '--porcelain'])).stdout,
});
const assetsSnapshot = async () => {
  const dir = resolve(process.cwd(), 'frontend/dist/assets');
  const files = {};
  for (const name of (await readdir(dir)).sort()) {
    files[name] = createHash('sha256').update(await readFile(resolve(dir, name))).digest('hex');
  }
  return { dir, files };
};

const parseColor = value => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value ?? '');
  return match
    ? { rgb: match.slice(1, 4).map(Number), alpha: match[4] === undefined ? 1 : Number(match[4]) }
    : null;
};

/** Runs in the page: reads the real computed material of one tool record plus
 *  its disclosure/status/output state. No DOM or style substitution. */
function pageProbe() {
  window.toolboxProbe = selector => {
    const card = document.querySelector(selector);
    if (!card) return { selector, present: false };
    const style = getComputedStyle(card);
    const head = card.querySelector('.th-tool-head');
    const headStyle = head ? getComputedStyle(head) : null;
    const headRect = head?.getBoundingClientRect();
    const body = card.querySelector('.th-tool-body');
    const output = card.querySelector('.th-tool-output');
    const outputRect = output?.getBoundingClientRect();
    const status = card.querySelector('[class*="th-tool-status--"]');
    return {
      selector, present: true,
      background: style.backgroundColor, borderColor: style.borderTopColor,
      borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle,
      boxShadow: style.boxShadow, radius: style.borderTopLeftRadius,
      expanded: head?.getAttribute('aria-expanded') ?? null,
      headerHeight: headRect ? Math.round(headRect.height * 100) / 100 : null,
      headerFontSize: headStyle ? headStyle.fontSize : null,
      labelSizeVar: headStyle ? headStyle.getPropertyValue('--th-type-label-size').trim() : null,
      hasBody: !!body,
      preview: card.querySelector('.th-tool-preview')?.textContent ?? null,
      statusWord: status?.textContent ?? null,
      statusClass: status ? /[^\s]*$/.exec(status.className)[0] : null,
      glyphClass: ['th-tool-glyph--running', 'th-tool-glyph--ok', 'th-tool-glyph--error']
        .find(name => card.querySelector(`.${name}`)) ?? null,
      output: outputRect ? {
        clientHeight: output.clientHeight, scrollHeight: output.scrollHeight,
        overflowY: getComputedStyle(output).overflowY,
        cap: Math.round(Math.min(360, innerHeight * 0.45) * 100) / 100,
        paintedHeight: Math.round(outputRect.height * 100) / 100,
      } : null,
    };
  };
  window.toolboxSurface = () => ({
    canvas: getComputedStyle(document.querySelector('.th-chat-pane')).backgroundColor,
    prose: getComputedStyle(document.querySelector('.th-chat-markdown p')).backgroundColor,
    pageScrollWidth: document.documentElement.scrollWidth, innerWidth,
  });
}

const judge = (probe, surface) => {
  const bg = parseColor(probe.background), border = parseColor(probe.borderColor);
  const canvas = parseColor(surface.canvas), prose = parseColor(surface.prose);
  return {
    o1OpaqueSurface: bg !== null && bg.alpha === 1,
    o2Boundary: probe.borderStyle === 'solid' && probe.borderWidth === '1px' && border !== null && border.alpha > 0,
    o4DistinctFromProse: bg !== null && bg.alpha === 1 && canvas !== null && prose !== null
      && prose.alpha === 0 && bg.rgb.join() !== canvas.rgb.join(),
    o5NoStatusGlow: probe.boxShadow === 'none',
    probe, surface,
  };
};

export async function run({ phase, out, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['red', 'green'].includes(phase), '--phase must be red or green');
  assert(driver, 'QA_PLAYWRIGHT must identify an existing installed driver');
  out = resolve(out);
  await mkdir(out, { recursive: true });
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
  const [startSource, startAssets] = await Promise.all([gitSnapshot(), assetsSnapshot()]);
  const receipt = {
    phase, out, driver, cwd: process.cwd(),
    startSource, startAssets,
    command: `QA_PLAYWRIGHT=${driver} bun test/qa/ui-followup-toolbox.mjs --phase ${phase} --out ${out}`,
  };
  const observations = [], shots = [], actions = [], resources = [], sessions = [], failures = [];
  let browser, mismatches;
  try {
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browserVersion = browser.version();
    for (const { label, viewport, theme } of SCENARIOS) {
      const seed = designSeed('single');
      seed.running = [];
      seed.runs['stored-a'].queue = { revision: 1, items: [], engine: { pendingMessageCount: 0, ordered: [] } };
      const fixture = startFixture({ ...seed, controlled: true, port: 0 });
      resources.push({ name: `${label}/fixture`, close: () => fixture.stop() });
      const context = await browser.newContext({ viewport, colorScheme: theme });
      resources.splice(resources.length - 1, 0, { name: `${label}/context`, close: async () => {
        await context.close(); return { contextClosed: true, url: fixture.url };
      } });
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      const errors = []; page.on('pageerror', error => errors.push(String(error)));
      sessions.push({ label, page, fixture, errors });
      await installSignals(page, { theme });
      // Record the actual URL before navigation (brief: real SPA, port0).
      const url = fixture.url;
      actions.push({ scenario: label, action: 'idle controlled fixture navigation', url });
      console.log(`WORKING: ${label} actual SPA ${url}`);
      const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
      await page.goto(url); await attached;
      await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-activity-bar')
        && document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
        && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
      await seedLive(page, fixture);
      await page.evaluate(pageProbe);

      const scroll = async selector =>
        actions.push({ scenario: label, action: 'expose transcript target', selector,
          ...(await page.evaluate(exposeTranscript, selector)) });
      const shoot = async name => {
        await page.evaluate(settleFrame);
        const bytes = await page.screenshot({ animations: 'allow' });
        const path = resolve(out, `p4-${phase}-${label}-${name}.png`);
        await writeFile(path, bytes);
        shots.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });
      };
      const probe = selector => page.evaluate(selector => window.toolboxProbe(selector), selector);
      const surface = async () => {
        const value = await page.evaluate(() => window.toolboxSurface());
        actions.push({ scenario: label, action: 'surface comparison', ...value });
        return value;
      };
      const record = (observable, pass, detail) => observations.push({ scenario: label, observable, pass, detail });
      const expectMaterial = (tool, state, probeValue, surfaceValue, extras = {}) => {
        const result = judge(probeValue, surfaceValue);
        record(`o1OpaqueSurface/${tool}/${state}`, result.o1OpaqueSurface, probeValue.background);
        record(`o2Boundary/${tool}/${state}`, result.o2Boundary,
          `${probeValue.borderWidth} ${probeValue.borderStyle} ${probeValue.borderColor}`);
        record(`o4DistinctFromProse/${tool}/${state}`, result.o4DistinctFromProse,
          `tool ${probeValue.background} vs canvas ${surfaceValue.canvas}, prose ${surfaceValue.prose}`);
        record(`o5NoStatusGlow/${tool}/${state}`, result.o5NoStatusGlow, probeValue.boxShadow);
        for (const [observable, pass, detail] of extras) record(`${observable}/${tool}/${state}`, pass, detail);
        return result;
      };

      // Completed tool: collapsed first, then expanded through the real head.
      const read = '[data-tool-call-id="design-read"]';
      await scroll(`${read} > .th-tool-head`);
      const proseSurface = await surface();
      const collapsedRead = await probe(read);
      await shoot('read-collapsed');
      expectMaterial('design-read', 'collapsed', collapsedRead, proseSurface, [
        ['o6Density', collapsedRead.headerHeight >= 48, `header ${collapsedRead.headerHeight}px`],
        ['o7PreviewPreserved', (collapsedRead.preview ?? '').length > 0, collapsedRead.preview],
        ['o7StatusPreserved', collapsedRead.statusClass === 'th-tool-status--ok'
          && (collapsedRead.statusWord ?? '').length > 0, `${collapsedRead.statusWord} (${collapsedRead.glyphClass})`],
      ]);
      await arm(page, () => !!document.querySelector(`[data-tool-call-id="design-read"] > .th-tool-body`));
      await page.locator(`${read} > .th-tool-head`).click();
      await complete(page);
      await scroll(`${read} > .th-tool-head`);
      const expandedRead = await probe(read);
      await shoot('read-expanded');
      expectMaterial('design-read', 'expanded', expandedRead, proseSurface, [
        ['o3PersistentMaterial', expandedRead.background === collapsedRead.background
          && expandedRead.borderColor === collapsedRead.borderColor
          && expandedRead.borderWidth === collapsedRead.borderWidth,
          `collapsed ${collapsedRead.background}/${collapsedRead.borderColor} vs expanded ${expandedRead.background}/${expandedRead.borderColor}`],
        ['o6DensityStable', expandedRead.headerHeight !== null && collapsedRead.headerHeight !== null
          && Math.abs(expandedRead.headerHeight - collapsedRead.headerHeight) <= 1,
          `collapsed ${collapsedRead.headerHeight}px vs expanded ${expandedRead.headerHeight}px`],
        ['o7DisclosureToggles', expandedRead.expanded === 'true' && expandedRead.hasBody, expandedRead.expanded],
        ['o8BoundedOutput', expandedRead.output !== null
          && expandedRead.output.overflowY === 'auto'
          && expandedRead.output.paintedHeight <= expandedRead.output.cap + 1
          && expandedRead.output.scrollHeight > expandedRead.output.clientHeight,
          JSON.stringify(expandedRead.output)],
      ]);
      await arm(page, () => !document.querySelector(`[data-tool-call-id="design-read"] > .th-tool-body`));
      await page.locator(`${read} > .th-tool-head`).click();
      await complete(page);

      // Failed tool: auto-open error state, then collapsed through the head.
      const failed = '[data-tool-call-id="design-failed"]';
      await scroll(`${failed} > .th-tool-head`);
      const expandedFailed = await probe(failed);
      await shoot('failed-expanded');
      expectMaterial('design-failed', 'expanded', expandedFailed, proseSurface, [
        ['o7ErrorStatusPreserved', expandedFailed.statusClass === 'th-tool-status--error'
          && expandedFailed.glyphClass === 'th-tool-glyph--error'
          && expandedFailed.expanded === 'true', `${expandedFailed.statusWord} (${expandedFailed.glyphClass})`],
      ]);
      await arm(page, () => !document.querySelector(`[data-tool-call-id="design-failed"] > .th-tool-body`));
      await page.locator(`${failed} > .th-tool-head`).click();
      await complete(page);
      await scroll(`${failed} > .th-tool-head`);
      const collapsedFailed = await probe(failed);
      await shoot('failed-collapsed');
      expectMaterial('design-failed', 'collapsed', collapsedFailed, proseSurface, [
        ['o7DisclosureCollapses', collapsedFailed.expanded === 'false' && !collapsedFailed.hasBody, collapsedFailed.expanded],
      ]);

      // Running tool from the live seed: material plus non-colour running cue.
      const running = '[data-tool-call-id="design-running"]';
      await scroll(`${running} > .th-tool-head`);
      const collapsedRunning = await probe(running);
      await shoot('running-collapsed');
      expectMaterial('design-running', 'collapsed', collapsedRunning, proseSurface, [
        ['o7RunningStatusPreserved', collapsedRunning.statusClass === 'th-tool-status--running'
          && collapsedRunning.glyphClass === 'th-tool-glyph--running'
          && (collapsedRunning.statusWord ?? '').length > 0, `${collapsedRunning.statusWord} (${collapsedRunning.glyphClass})`],
      ]);

      // Grow the live output with a long Korean streaming update, then expand
      // the running record: live output must stay bounded inside the card.
      // The record is collapsed here, so observe growth through the visible
      // latest-output preview line (the output element only exists expanded).
      await arm(page, () => (document.querySelector('[data-tool-call-id="design-running"] .th-tool-preview')?.textContent ?? '').includes('record 69'));
      fixture.deliver('stored-a', { type: 'tool', toolCallId: 'design-running', toolName: 'bash',
        phase: 'update', partial: { content: [{ text: `\n${longOutput}` }] } });
      await complete(page);
      await arm(page, () => !!document.querySelector(`[data-tool-call-id="design-running"] > .th-tool-body`));
      await page.locator(`${running} > .th-tool-head`).click();
      await complete(page);
      await scroll(`${running} > .th-tool-head`);
      const expandedRunning = await probe(running);
      await shoot('running-expanded');
      expectMaterial('design-running', 'expanded', expandedRunning, proseSurface, [
        ['o3PersistentMaterial', expandedRunning.background === collapsedRunning.background
          && expandedRunning.borderColor === collapsedRunning.borderColor
          && expandedRunning.borderWidth === collapsedRunning.borderWidth,
          `collapsed ${collapsedRunning.background}/${collapsedRunning.borderColor} vs expanded ${expandedRunning.background}/${expandedRunning.borderColor}`],
        ['o7RunningStatusPreserved', expandedRunning.statusClass === 'th-tool-status--running'
          && expandedRunning.glyphClass === 'th-tool-glyph--running'
          && expandedRunning.expanded === 'true', `${expandedRunning.statusWord} (${expandedRunning.glyphClass})`],
        ['o8BoundedOutput', expandedRunning.output !== null
          && expandedRunning.output.overflowY === 'auto'
          && expandedRunning.output.paintedHeight <= expandedRunning.output.cap + 1
          && expandedRunning.output.scrollHeight > expandedRunning.output.clientHeight,
          JSON.stringify(expandedRunning.output)],
      ]);

      if (viewport.width <= 768) {
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth, innerWidth }));
        record('o9NoHorizontalOverflow', overflow.scrollWidth <= overflow.innerWidth + 1, JSON.stringify(overflow));
      }
      actions.push({ scenario: label, action: 'fixture traffic', sends: fixture.frames.length,
        unexpected: fixture.unexpected.length });
    }
    mismatches = observations.filter(row => !row.pass);
    const [endSource, endAssets] = await Promise.all([gitSnapshot(), assetsSnapshot()]);
    receipt.endSource = endSource;
    receipt.endAssets = endAssets;
    receipt.stability = {
      source: startSource.sha === endSource.sha && startSource.tree === endSource.tree
        && startSource.dirty === endSource.dirty,
      assets: JSON.stringify(startAssets.files) === JSON.stringify(endAssets.files),
    };
    await save('observations.json', { ...receipt, mismatches: mismatches.map(row => `${row.scenario}/${row.observable}`),
      observations, shots, actions });
    if (phase === 'red') {
      assert(mismatches.length > 0, 'red phase requires the unchanged build to MISS a P4 observable; the tree already matches');
      console.log(`RED confirmed: ${mismatches.length} P4 observable failures:\n  ${mismatches.map(row => `${row.scenario}/${row.observable}`).join('\n  ')}`);
    } else {
      assert.deepEqual(mismatches, [], `green phase requires every P4 observable to pass; failing: ${mismatches.map(row => `${row.scenario}/${row.observable}`).join(', ')}`);
    }
  } catch (error) {
    failures.push(error);
    try { await save('observations-FAIL.json', { ...receipt, observations, shots, actions, error: String(error), stack: error.stack }); }
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
  if (failures.length) throw new AggregateError(failures, 'ui-followup-toolbox QA failed');
  console.log(`${phase.toUpperCase()} complete; all owned resource closures awaited.`);
  return { phase, mismatches, observations };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { phase: { type: 'string' }, out: { type: 'string' } } });
  await run({ phase: values.phase, out: values.out })
    .then(() => process.exit(0))
    .catch(error => { console.error(error); process.exit(1); });
}
