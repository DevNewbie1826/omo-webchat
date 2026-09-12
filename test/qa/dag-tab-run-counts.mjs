/** Real built SPA, fresh Chrome profiles, and synthetic native wire input. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { confirmPortReleased, dagRow, installDOMSignals, snapshotAssets } from './dag-state-ordering.mjs';
import { activityPath, chat, createTaskRequestGate, deadline, pollPath } from './task-state-fixture.mjs';
import { observeSockets } from './heartbeat-liveness.mjs';
import { startSummaryFixture, viewports } from './dag-summary-fixture.mjs';
import { armDOM, doneDOM, settleCapture } from './dag-summary-surface.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const save = (dir, name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2) + '\n');
function readDOM() {
  const tab = document.querySelector('button[data-activity-tab="dag"]');
  const count = tab?.querySelector('span.th-activity-tab-count');
  const strip = tab?.closest('.th-activity-tabs');
  const box = tab?.getBoundingClientRect();
  const hit = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return { count: count?.textContent ?? null, label: tab?.querySelector('span.th-activity-tab-label')?.textContent,
    tabHTML: tab?.outerHTML ?? null, stripHTML: strip?.outerHTML ?? null,
    forbidden: [...(strip?.querySelectorAll('*') ?? [])].filter(n => /[?+]/.test(n.textContent)).map(n => n.outerHTML),
    open: tab?.closest('.th-activity-shelf')?.getAttribute('data-open'),
    expanded: tab?.closest('.th-activity-shelf')?.getAttribute('data-expanded'),
    visible: !!tab?.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    countVisible: count ? count.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : null,
    hit: !!hit && tab.contains(hit), box: box?.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
}
function rich(statuses, running, total, truncated = false) {
  return { parent_session_id: chat, truncated_runs: truncated, run_running_count: running, run_total_count: total,
    runs: statuses.map((status, i) => ({ ...dagRow(status, '01'), run_id: `qa-run-${i}`, name: `QA run ${i}` })) };
}
function legacy(statuses, truncated = false, nodeTruncated = false) {
  const data = rich(statuses, 0, 0, truncated);
  delete data.run_running_count;
  delete data.run_total_count;
  if (nodeTruncated && data.runs.length > 0) data.runs[0] = { ...data.runs[0], truncated_nodes: true };
  return data;
}
// Cases are grouped by the authority state their first delivery requires, and
// every group runs against its own fixture, browser profile and page load. The
// scalar group's leading case must see an empty retained map, and the legacy
// group must never inherit an exact pair an earlier delivery established -
// retaining that pair is correct behaviour, so a shared page would hide the
// scalar-less fallback entirely.
const caseGroups = [
  { name: 'scalars', cases: [
    { name: 'compact-no-retained-runs', expected: '6/23', data: rich([], 6, 23, true) },
    { name: 'rich-all-terminal-spellings', expected: '2/6', data: rich(['running', 'pending', 'completed', 'failed', 'cancelled', 'canceled'], 2, 6) },
    { name: 'truncated-membership', expected: '3/17', data: rich(['running'], 3, 17, true) },
    { name: 'zero-total', expected: null, data: rich([], 0, 0) },
  ] },
  { name: 'legacy', cases: [
    { name: 'legacy-complete-node-truncated', expected: '1/2', data: legacy(['running', 'completed'], false, true) },
    { name: 'legacy-incomplete-membership', expected: null, data: legacy(['running'], true) },
  ] },
  { name: 'withdrawal', cases: [
    { name: 'exact-then-unavailable', expected: null, deliveries: [
      { expected: '1/2', data: rich(['running', 'completed'], 1, 2) },
      { expected: null, data: { ...rich(['completed'], 0, 0), run_counts_unavailable: true } },
    ] },
  ] },
  { name: 'withdrawal', cases: [
    { name: 'unavailable-first-with-retained-running', expected: null,
      data: { ...rich(['running'], 1, 1), run_counts_unavailable: true } },
  ] },
];
export async function run({ evidenceDir = join(root, '.omo/evidence/dagcount/browser-r2') } = {}) {
  assert.ok(globalThis.Bun, 'Run with Bun');
  await mkdir(evidenceDir, { recursive: true });
  const report = { passed: false, surface: 'real built SPA / real Chrome / synthetic native wire frames', actions: [], errors: [] };
  const cleanup = { cases: [], errors: [] };
  const record = row => report.actions.push({ sequence: report.actions.length + 1, ...row });
  const clean = async (receipt, key, fn) => {
    try { receipt[key] = await fn() ?? true; }
    catch (error) { receipt.errors.push({ key, error: String(error) }); }
  };
  let assets, failure;
  try {
    assets = await snapshotAssets(join(root, 'frontend/dist'));
    await save(evidenceDir, 'asset-hashes.json', assets);
    const { chromium } = await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href);
    for (const viewport of viewports) {
      for (const group of caseGroups) {
      const name = `${viewport.width}x${viewport.height}`, receipt = { name, group: group.name, errors: [] };
      cleanup.cases.push(receipt);
      let fixture, context, page, profile, gate, observed;
      try {
        fixture = startSummaryFixture({ assetsDir: assets.directory });
        receipt.urls = [fixture.url, fixture.base.url];
        profile = await mkdtemp(join(tmpdir(), 'cli-webchat-dagcount-chrome-')); receipt.profile = profile;
        context = await chromium.launchPersistentContext(profile, { executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, viewport, reducedMotion: 'reduce', timeout: deadline });
        context.setDefaultTimeout(deadline);
        receipt.browserVersion = context.browser()?.version();
        page = context.pages()[0] ?? await context.newPage();
        page.on('pageerror', error => report.errors.push({ name, error: String(error) }));
        observed = observeSockets(page);
        gate = createTaskRequestGate(row => record({ viewport: name, ...row }));
        await page.route('**/api/**', gate.handle); await installDOMSignals(page);
        const activity = gate.next(activityPath), polling = gate.next(pollPath);
        const subscription = fixture.base.wait('frame', f => f.type === 'sessions.subscribe' && f.mode === 'all_live');
        const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final);
        await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
        await subscription; assert.equal((await entries).frame.entries.length, 160);
        await page.evaluate(() => window.__dagQA.done(window.__dagQA.initial));
        const mounted = await armDOM(page, () => !!document.querySelector('[data-activity-tab="dag"]'));
        const response = page.waitForResponse(r => new URL(r.url()).pathname === activityPath, { timeout: deadline });
        await gate.release(await activity, { history: { task: { parent_session_id: chat, truncated_tasks: false,
          tasks: [{ task_id: 'keep-shelf', name: 'QA shelf presence', status: 'completed' }] } } });
        await (await response).finished(); await doneDOM(page, mounted); await polling;
        if ((await page.evaluate(readDOM)).open === 'true') {
          const collapsed = await armDOM(page, () => document.querySelector('.th-activity-shelf')?.getAttribute('data-open') === 'false');
          await page.locator('.th-activity-tabs [aria-selected="true"]').click(); await doneDOM(page, collapsed);
        }
        record({ viewport: name, action: 'loaded-real-transcript-and-collapsed-shelf', dom: await page.evaluate(readDOM) });
        for (const input of group.cases) {
          try {
          const deliveries = input.deliveries ?? [{ expected: input.expected, data: input.data }];
          let dom;
          for (const delivery of deliveries) {
            const frame = { type: 'extensionEvent', name: 'omo.dag.updated', data: delivery.data };
            const signal = await armDOM(page, expected => (document.querySelector('[data-activity-tab="dag"] .th-activity-tab-count')?.textContent ?? null) === expected, delivery.expected);
            const after = observed.mark();
            const received = observed.wait(row => row.direction === 'received' && row.frame?.type === frame.type
              && row.frame.name === frame.name && row.frame.data?.run_counts_unavailable === delivery.data.run_counts_unavailable
              && row.frame.data?.run_total_count === delivery.data.run_total_count, { after, label: input.name });
            record({ viewport: name, action: 'inject-native-wire', case: input.name, expected: delivery.expected, frame });
            fixture.deliver(chat, frame);
            await received; await doneDOM(page, signal); await settleCapture(page);
            dom = await page.evaluate(readDOM);
            record({ viewport: name, action: 'observed-tab', case: input.name, expected: delivery.expected, dom });
            assert.equal(dom.count, delivery.expected); assert.deepEqual(dom.forbidden, []);
          }
          assert.equal(dom.open, 'false'); assert.equal(dom.expanded, 'false');
          assert.ok(dom.visible && dom.hit && dom.box.width > 0 && dom.box.height > 0);
          assert.ok(dom.box.x >= 0 && dom.box.y >= 0 && dom.box.right <= viewport.width && dom.box.bottom <= viewport.height);
          if (input.expected !== null) assert.equal(dom.countVisible, true);
          const screenshot = join(evidenceDir, `${name}-${input.name}.png`);
          const png = await page.screenshot({ path: screenshot, fullPage: false });
          assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
          record({ viewport: name, action: 'asserted-and-captured', case: input.name, count: dom.count, forbidden: dom.forbidden, screenshot });
          } catch (error) {
            const dom = await page.evaluate(readDOM);
            const screenshot = join(evidenceDir, `${name}-${input.name}-failure.png`);
            await page.screenshot({ path: screenshot });
            const row = { viewport: name, case: input.name, expected: input.expected, dom, screenshot, error: String(error) };
            report.errors.push(row); record({ action: 'assertion-failed', ...row });
            await save(evidenceDir, `${name}-${input.name}-failure.json`, row);
          }
        }
        assert.deepEqual(fixture.base.unexpected, []); assert.deepEqual(fixture.errors, []);
        assert.equal(fixture.base.frames.filter(f => f.type === 'chat.send').length, 0);
      } catch (error) {
        if (page && !page.isClosed()) await clean(receipt, 'failureCapture', async () => {
          await save(evidenceDir, `${name}-${group.name}-failure.json`, await page.evaluate(readDOM));
          await page.screenshot({ path: join(evidenceDir, `${name}-${group.name}-failure.png`) });
        });
        throw error;
      } finally {
        if (gate) await clean(receipt, 'routes', async () => { const r = await gate.stop(); assert.deepEqual(r.errors, []); return r; });
        if (page && !page.isClosed()) await clean(receipt, 'domObservers', () => page.evaluate(() => window.__dagQA.stop()));
        if (observed) { observed.stop(); receipt.socketObserverStopped = true; }
        if (context) await clean(receipt, 'contextClosed', () => context.close());
        if (fixture) {
          await clean(receipt, 'fixture', async () => { const r = await fixture.stop(); assert.deepEqual(r.errors, []); assert.equal(r.pendingWebSockets, 0); assert.equal(r.original.pendingWebSockets, 0); return r; });
          await clean(receipt, 'portsReleased', () => Promise.all(receipt.urls.map(url => confirmPortReleased(Number(new URL(url).port)))));
        }
        if (profile) {
          await clean(receipt, 'remainingProfileProcesses', async () => {
            const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,command=']);
            const remaining = stdout.split('\n').filter(line => line.includes(profile));
            assert.deepEqual(remaining, []); return remaining;
          });
          await clean(receipt, 'profileRemoved', async () => { await rm(profile, { recursive: true, force: true }); await assert.rejects(access(profile), { code: 'ENOENT' }); return true; });
        }
        cleanup.errors.push(...receipt.errors.map(error => ({ name, group: group.name, ...error })));
      }
      }
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(cleanup.errors, []); report.passed = true;
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    if (assets) await clean(cleanup, 'assetsRemoved', async () => { await rm(assets.directory, { recursive: true, force: true }); await assert.rejects(access(assets.directory), { code: 'ENOENT' }); return true; });
    report.passed = report.passed && cleanup.errors.length === 0;
    await save(evidenceDir, 'actions.json', report); await save(evidenceDir, 'cleanup.json', cleanup);
  }
  if (failure) throw failure;
  assert.deepEqual(cleanup.errors, []);
  console.log(JSON.stringify({ passed: report.passed, assertions: report.actions.filter(row => row.action === 'asserted-and-captured'), cleanup }, null, 2));
  return report;
}
if (import.meta.main) await run();
