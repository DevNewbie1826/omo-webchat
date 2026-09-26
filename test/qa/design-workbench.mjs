/** QA_PLAYWRIGHT=<installed-driver> bun test/qa/design-workbench.mjs --phase before|after --evidence ABSOLUTE_PATH
 * Actual built React App. Every behaviour pin must pass in both phases.
 * Visual design predicates are recorded per scenario as designReds (failing
 * predicate + measurements) instead of throwing, so an acknowledged later-task
 * RED (e.g. the T2 collapsed-enclosure restyle) can never prevent
 * exerciseControls or auxiliarySurfaces from running for their original cases.
 * Exit is non-zero only when behaviour fails. Screenshots require a separate
 * rendered-evidence visual critique; this script does not claim aesthetics.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setupDesign, arm, complete, wheel } from './design-workbench-fixture.mjs';
import { measure, preservedGeometry, designAssertions, collectDesignReds } from './design-workbench-measure.mjs';
import { exerciseControls, auxiliarySurfaces } from './design-workbench-controls.mjs';
import { captureSettled } from './design-workbench-capture.mjs';

/** Per-scenario orchestration: the behaviour verdict and design REDs stay
 * distinct fields on one record. A design RED is reported data; only a
 * behaviour failure (thrown assertion, browser exception, unexpected traffic)
 * fails the scenario. */
export function scenarioRunner({ setup, save, evidence, results, screenshots, traffic, cleanup }) {
  return async function scenario(name, options, action) {
    const record = { scenario: name, behaviourPass: false, pass: false, designReds: [] };
    let q;
    try {
      q = await setup(options);
      const shot = async (suffix, readiness) => {
        const path = resolve(evidence, `${name}-${suffix}.png`);
        if (readiness) await save(`${name}-${suffix}-readiness.json`, await captureSettled(q.page, readiness, { path }));
        else await q.page.screenshot({ path });
        screenshots.push(path);
        await save(`${name}-${suffix}.json`, await measure(q.page));
      };
      const detail = await action(q, shot, record);
      assert.deepEqual(q.errors, [], `${name}: no browser exceptions`);
      assert.deepEqual(q.fixture.unexpected, [], `${name}: no unexpected HTTP/WS traffic`);
      record.behaviourPass = true; record.pass = true;
      Object.assign(record, detail);
    } catch (error) {
      record.behaviourPass = false; record.pass = false;
      record.error = String(error); record.stack = error.stack; record.cause = String(error.cause ?? '');
      if (q) {
        const path = resolve(evidence, `${name}-FAIL.png`); await q.page.screenshot({ path }); screenshots.push(path);
        await save(`${name}-FAIL-measurements.json`, await measure(q.page));
      }
    } finally {
      if (q) {
        traffic.push({ scenario: name, requests: q.fixture.requests, frames: q.fixture.frames, unexpected: q.fixture.unexpected, errors: q.errors });
        cleanup.push({ scenario: name, ...await q.close() });
      }
      results.push(record);
      await save('results.json', results);
    }
  };
}

/** Single-layout scenario script. Design predicates are measured and their
 * REDs recorded on the shared record (never thrown) before the behaviour
 * steps, so every original behaviour assertion still runs to completion for
 * this case even when a design predicate fails. */
export async function singleScenario(q, shot, { name, phase, width, save, record },
  { exerciseControls: runControls = exerciseControls, auxiliarySurfaces: runSurfaces = auxiliarySurfaces } = {}) {
  const { page } = q;
  assert.equal(await page.locator('[data-tool-call-id="design-failed"] .th-tool-head').getAttribute('aria-expanded'), 'true', 'untouched failure auto-opens');
  await shot('failure-open');
  await arm(page, () => document.querySelector('[data-tool-call-id="design-failed"] .th-tool-head')?.getAttribute('aria-expanded') === 'false');
  await page.locator('[data-tool-call-id="design-failed"] .th-tool-head').click(); await complete(page);
  await page.mouse.move(0, 0);
  const sample = await measure(page); preservedGeometry(sample);
  assert.equal(sample.fontSize, '14px', 'user font setting is honored');
  const assertions = designAssertions(sample);
  record.designReds = collectDesignReds(assertions, phase);
  await save(`${name}-measurements.json`, sample);
  await save(`${name}-assertions.json`, assertions);
  await shot('collapsed');
  await wheel(page, page.locator('.th-chat-body'), -100000, true); await shot('history-top');
  await wheel(page, page.locator('.th-chat-body'), 100000, true);
  const controls = await runControls(q, shot);
  if (width === 1280) await runSurfaces(q, shot);
  return { assertions, controls, designReds: record.designReds };
}

export async function run({ phase, evidence, driver = process.env.QA_PLAYWRIGHT }) {
  assert(['before', 'after'].includes(phase), '--phase must be before or after');
  assert(driver, 'QA_PLAYWRIGHT must identify an existing installed driver');
  evidence = resolve(evidence); await mkdir(evidence, { recursive: true });
  const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + '\n');
  const results = [], cleanup = [], traffic = [], screenshots = [];
  const receipt = { phase, evidence, driver, cwd: process.cwd(),
    sha: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    tree: Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}']).stdout.toString().trim(),
    diff: Bun.spawnSync(['git', 'diff', '--stat']).stdout.toString(),
    command: `QA_PLAYWRIGHT=${driver} bun test/qa/design-workbench.mjs --phase ${phase} --evidence ${evidence}` };
  let browser;
  try {
    const { chromium } = await import(driver);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browserVersion = browser.version();
    const scenario = scenarioRunner({ setup: options => setupDesign(browser, options), save, evidence, results, screenshots, traffic, cleanup });
    for (const theme of ['dark', 'light']) for (const [width, height] of [[1280, 900], [768, 1024], [390, 844]]) {
      const name = `single-${theme}-${width}`;
      await scenario(name, { theme, viewport: { width, height }, coarse: width === 390 },
        (q, shot, record) => singleScenario(q, shot, { name, phase, width, save, record }));
    }
    for (const layout of ['two', 'h4', 'v4', 'mixed']) {
      await scenario(`layout-${layout}`, { layout, viewport: { width: 1280, height: 900 } }, async (q, shot) => {
        const sample = await measure(q.page); preservedGeometry(sample);
        await shot('initial');
        return { geometry: sample, controls: await exerciseControls(q, shot) };
      });
    }
    await scenario('font-15', { fontSize: 15 }, async (q, shot) => {
      const sample = await measure(q.page); assert.equal(sample.fontSize, '15px'); preservedGeometry(sample);
      await shot('comparison'); return { geometry: sample };
    });
  } catch (error) { results.push({ scenario: 'runner', behaviourPass: false, pass: false, designReds: [], error: String(error), stack: error.stack }); }
  finally {
    if (browser) { await browser.close(); cleanup.push({ browserClosed: !browser.isConnected(), disposableProfilesRemovedByDriver: true }); }
    await save('results.json', results); await save('cleanup.json', cleanup); await save('traffic.json', traffic);
    await save('screenshots.json', screenshots); await save('receipt.json', receipt);
  }
  const behaviourFailures = results.filter(result => !result.behaviourPass);
  const designReds = results.flatMap(result => result.designReds.map(red => ({ scenario: result.scenario, ...red })));
  const pass = results.length === 11 && behaviourFailures.length === 0;
  const summary = `behaviour ${results.length - behaviourFailures.length}/${results.length} scenarios pass, ${behaviourFailures.length} fail; design REDs ${designReds.length}${designReds.length ? ` (${[...new Set(designReds.map(red => red.id))].join(', ')})` : ''}`;
  console.log(summary);
  console.log(JSON.stringify({ pass, phase, summary,
    behaviour: { pass: results.length - behaviourFailures.length, fail: behaviourFailures.length, scenarios: results.length },
    designReds,
    scenarios: results.map(({ scenario, pass, behaviourPass, designReds, error }) => ({ scenario, pass, behaviourPass, designReds: designReds.map(red => red.id), error })),
    evidence }, null, 2));
  return pass;
}
if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { phase: { type: 'string' }, evidence: { type: 'string' } }, strict: true });
  if (!await run(values)) process.exitCode = 1;
}
