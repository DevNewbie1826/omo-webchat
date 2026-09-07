/** Real built App + Google Chrome + native network fixture for stats refresh.
 * QA_PLAYWRIGHT=<installed playwright-core/index.mjs> bun test/qa/rpc46-stats.mjs --evidence PATH
 * Import runRPC46Stats({ evidenceDir, chromium? }) from Bun eval for identical actions.
 */
import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { observeSockets } from './heartbeat-liveness.mjs';
import { startStatsFixture, usage } from './rpc46-stats-fixture.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const A = 'stored-a', B = 'newer';
const deadline = 10000;

export async function resolveChromeDriver() {
  for (const file of [process.env.QA_PLAYWRIGHT, resolve(root, 'frontend/node_modules/playwright-core/index.mjs'),
    '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs', '/private/tmp/zcode-asar/node_modules/playwright-core/index.mjs'].filter(Boolean)) {
    try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    return (await import(pathToFileURL(file).href)).chromium;
  }
  throw new Error('Set QA_PLAYWRIGHT to an already-installed playwright-core/index.mjs');
}

// Read-only DOM observation, armed before the corresponding network/UI action.
async function armDOM(page, predicate, args) {
  return page.evaluate(({ source, args, deadline }) => {
    const checkState = (0, eval)(`(${source})`);
    window.__rpc46Waiters ??= new Map();
    const id = (window.__rpc46Sequence = (window.__rpc46Sequence ?? 0) + 1);
    const promise = new Promise((done, fail) => {
      let timer;
      const finish = error => { clearTimeout(timer); observer.disconnect(); error ? fail(error) : done(true); };
      const check = () => { try { if (checkState(args)) finish(); } catch (error) { finish(error); } };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
      timer = setTimeout(() => finish(new Error(`RPC46 DOM deadline: ${source}`)), deadline); check();
    });
    promise.catch(() => {}); window.__rpc46Waiters.set(id, promise); return id;
  }, { source: String(predicate), args, deadline });
}
const doneDOM = (page, id) => page.evaluate(async id => {
  try { return await window.__rpc46Waiters.get(id); } finally { window.__rpc46Waiters.delete(id); }
}, id);
const hasMetric = ({ selector, percent }) => document.querySelector(selector)?.textContent === `${percent}%`;
const statsCount = observed => observed.timeline.filter(row => row.direction === 'sent' && row.frame?.type === 'chat.stats' && row.frame.sessionId === A).length;

async function assetManifest(directory) {
  const result = [];
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push({ path, sha256: createHash('sha256').update(await readFile(join(directory, path))).digest('hex') });
    }
  }
  await visit(); return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Owns both fixture listeners and a fresh Chrome profile/browser. An injected
 * chromium driver changes only driver resolution, never browser actions.
 * smoke runs baseline-independent held/rejected controls at both viewports.
 */
export async function runRPC46Stats({ evidenceDir, chromium, headless = true, smoke = false,
  assetsDir = resolve(root, 'frontend/dist') } = {}) {
  assert.ok(evidenceDir, 'evidenceDir is required');
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  await access(join(assetsDir, 'index.html'));
  const report = { startedAt: new Date().toISOString(), mode: smoke ? 'preparation-smoke' : 'C3',
    appURL: 'http://127.0.0.1:25263', assetsDir, assets: await assetManifest(assetsDir),
    scenarios: [], cleanup: [], errors: [], error: undefined };
  const save = (name, data) => writeFile(join(evidenceDir, name), JSON.stringify(data, null, 2) + '\n');
  let browser, failure;
  try {
    browser = await (chromium ?? await resolveChromeDriver()).launch({ channel: 'chrome', headless, timeout: deadline });
    report.browserVersion = browser.version();
    for (const mobile of [false, true]) {
      const name = mobile ? 'mobile' : 'desktop';
      const pane = mobile ? '.th-chat-pane' : '[data-pane-id="a"]';
      const metric = `${pane} .th-chat-status-details .th-chat-status-num`;
      let fixture, context, page, observed, scenarioFailure;
      const result = { name, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, checks: [], screenshots: [] };
      report.scenarios.push(result);
      try {
        fixture = await startStatsFixture({ mobile, assetsDir });
        context = await browser.newContext({ viewport: result.viewport, isMobile: mobile, hasTouch: mobile });
        page = await context.newPage(); page.setDefaultTimeout(deadline);
        page.on('pageerror', error => report.errors.push(String(error)));
        await context.addInitScript(() => {
          if (location.protocol !== 'http:') return;
          localStorage.setItem('th-lang', 'en'); localStorage.setItem('th-ws-expanded', '["ws"]');
        });
        observed = observeSockets(page);
        const initial = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.sessionId === A);
        await page.goto(fixture.url); const entries = await initial;
        assert.equal(entries.frame.entries.length, 240);
        await doneDOM(page, await armDOM(page, hasMetric, { selector: metric, percent: 34 }));
        await doneDOM(page, await armDOM(page, pane => document.querySelector(`${pane} .th-chat-body`)?.textContent.includes('stored-a-history-240'), pane));
        await page.locator(`${pane} .th-chat-status-details > summary`).click();
        assert.equal(await page.locator(metric).first().isVisible(), true);
        if (!mobile) {
          await doneDOM(page, await armDOM(page, () => document.querySelector('[data-pane-id="b"] .th-chat-body')?.textContent.includes('newer-history-240')));
          await page.locator('[data-pane-id="b"] .th-chat-status-details > summary').click();
          assert.equal(await page.locator('[data-pane-id="b"] .th-chat-status-num').first().textContent(), '23%');
          await page.locator('[data-pane-id="b"] .th-chat-input textarea').fill('RPC46 sibling draft');
        }
        let barrierSequence = 0;
        // A later same-socket title frame provides a visible React commit after
        // ignored controls. It does not write stats, model, or transcript state.
        async function barrier(label) {
          const title = `RPC46-${name}-${++barrierSequence}-${label}`;
          const dom = await armDOM(page, ({ pane, title }) => document.querySelector(`${pane} .th-termhead-name`)?.textContent === title, { pane, title });
          fixture.deliver(A, { type: 'chat.name', name: title, origin: 'provider' });
          await doneDOM(page, dom);
        }
        async function unchanged(label, percent, count) {
          await barrier(label);
          assert.equal(await page.locator(metric).first().textContent(), `${percent}%`, label);
          assert.equal(statsCount(observed), count, `${label}: no statistics request`);
          result.checks.push({ label, percent, statsRequests: count });
        }
        async function shot(label) {
          const filename = `${name}-${label}.png`;
          await page.screenshot({ path: join(evidenceDir, filename) });
          const geometry = await page.locator(metric).first().evaluate(element => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
          });
          assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.x >= 0 && geometry.y >= 0
            && geometry.x + geometry.width <= geometry.viewportWidth && geometry.y + geometry.height <= geometry.viewportHeight, 'usage is readable inside viewport');
          result.screenshots.push({ filename, geometry });
        }
        async function chooseSmall() {
          const request = fixture.wait(frame => frame.type === 'chat.set' && frame.sessionId === A);
          await page.locator(`${pane} .th-model-picker-btn`).click();
          await page.locator('.th-model-picker-search').fill('RPC46 Small');
          await page.getByRole('option', { name: /^RPC46 Small/ }).click();
          const frame = await request;
          assert.deepEqual(frame.model, { provider: 'rpc46', modelId: 'small' }); return frame;
        }
        async function compactRequest() {
          const request = fixture.wait(frame => frame.type === 'chat.compact' && frame.sessionId === A);
          await page.locator(`${pane} .th-chat-input textarea`).fill('/compact');
          await page.locator(`${pane} .th-chat-send-btn`).click();
          await request;
          const dom = await armDOM(page, pane => !!document.querySelector(`${pane} .th-chat-status-primary .th-chat-status-item--warn`), pane);
          fixture.startCompact(A); await doneDOM(page, dom);
          assert.equal(fixture.frames.filter(frame => frame.type === 'chat.send').length, 0, '/compact is not a prompt');
        }
        async function rejectCompact(percent) {
          const count = statsCount(observed); await compactRequest();
          await unchanged('compact-held', percent, count);
          fixture.resolveCompact(A, { success: false });
          await unchanged('compact-rejected', percent, count);
          assert.ok((await page.locator(pane).textContent()).includes('QA_COMPACT_REJECTED'));
          await shot(`compact-rejected-${percent}`);
        }
        await shot('initial-34');
        const initialCount = statsCount(observed);
        const rejected = await chooseSmall();
        await unchanged('model-held-before-ack', 34, initialCount);
        fixture.acknowledge(rejected.requestId);
        await unchanged('model-ack-not-success', 34, initialCount);
        fixture.resolveModel(rejected.requestId, { success: false });
        await unchanged('model-rejected', 34, initialCount);
        assert.equal(await page.locator(`${pane} .th-model-picker-label`).textContent(), 'RPC46 Large');
        await shot('model-rejected-34');
        if (smoke) await rejectCompact(34);
        else {
          const accepted = await chooseSmall(); fixture.acknowledge(accepted.requestId);
          fixture.deliver(A, { type: 'control.result', requestId: rejected.requestId, command: 'set_model', success: true });
          fixture.deliver(A, { type: 'control.result', sessionId: B, requestId: accepted.requestId, command: 'set_model', success: true });
          fixture.deliver(A, { type: 'stats', sessionId: B, ...usage(99) });
          await unchanged('stale-and-foreign-controls-held', 34, initialCount);
          const refresh = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.stats' && row.frame.sessionId === A);
          const dom50 = await armDOM(page, hasMetric, { selector: metric, percent: 50 });
          fixture.resolveModel(accepted.requestId, { success: true });
          await refresh; await doneDOM(page, dom50);
          assert.equal(statsCount(observed), initialCount + 1, 'one confirmed-model refresh owner');
          assert.equal(await page.locator(`${pane} .th-model-picker-label`).textContent(), 'RPC46 Small');
          result.checks.push({ label: 'model-success', percent: 50 }); await shot('model-success-50');
          fixture.deliver(A, { type: 'control.result', requestId: accepted.requestId, command: 'set_model', success: true });
          await unchanged('duplicate-model-success', 50, initialCount + 1);
          await rejectCompact(50);
          const beforeCompact = statsCount(observed); await compactRequest();
          fixture.deliver(A, { type: 'compaction.done', sessionId: B });
          fixture.deliver(A, { type: 'stats', sessionId: B, ...usage(99) });
          await unchanged('foreign-compact-held', 50, beforeCompact);
          assert.equal(await page.locator(`${pane} .th-chat-status-primary .th-chat-status-item--warn`).count(), 1);
          const compactRefresh = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.stats' && row.frame.sessionId === A);
          const dom10 = await armDOM(page, hasMetric, { selector: metric, percent: 10 });
          fixture.resolveCompact(A, { success: true });
          await compactRefresh; await doneDOM(page, dom10);
          assert.equal(statsCount(observed), beforeCompact + 1, 'one idle-compaction refresh owner');
          result.checks.push({ label: 'compact-success', percent: 10 }); await shot('compact-success-10');
        }
        assert.equal(observed.timeline.filter(row => row.direction === 'received' && row.frame?.type === 'run.done').length, 0);
        assert.equal(fixture.state(A).entries.length, 240);
        assert.ok((await page.locator(`${pane} .th-chat-body`).textContent()).includes('stored-a-history-240'));
        if (!mobile) {
          assert.equal(await page.locator('[data-pane-id="b"] .th-chat-status-num').first().textContent(), '23%');
          assert.equal(await page.locator('[data-pane-id="b"] .th-chat-input textarea').inputValue(), 'RPC46 sibling draft');
          assert.ok((await page.locator('[data-pane-id="b"] .th-chat-body').textContent()).includes('newer-history-240'));
        }
        assert.deepEqual(fixture.unexpected, []); assert.deepEqual(fixture.http.unexpected, []);
        result.outcome = 'passed';
      } catch (error) {
        scenarioFailure = error; result.outcome = 'failed'; result.error = error.stack ?? String(error);
        if (page && !page.isClosed()) {
          try { await page.screenshot({ path: join(evidenceDir, `${name}-failure.png`) }); }
          catch (captureError) { report.errors.push(`Failure screenshot: ${captureError}`); }
        }
      } finally {
        observed?.stop();
        const receipt = { name, contextClosed: false };
        try { if (context) { await context.close(); receipt.contextClosed = true; } }
        catch (error) { report.errors.push(`Context cleanup: ${error}`); }
        try { if (fixture) receipt.fixture = await fixture.stop(); }
        catch (error) { report.errors.push(`Fixture cleanup: ${error}`); }
        report.cleanup.push(receipt);
        await save(`${name}-timeline.json`, observed?.timeline ?? []);
        await save(`${name}-fixture.json`, fixture ? { traffic: fixture.traffic, unexpected: fixture.unexpected, http: fixture.http.requests } : {});
      }
      if (scenarioFailure) throw scenarioFailure;
    }
    assert.deepEqual(report.errors, []);
  } catch (error) { failure = error; report.error = error.stack ?? String(error); }
  finally {
    try { if (browser) { await browser.close(); report.browserClosed = !browser.isConnected(); } }
    catch (error) { report.errors.push(`Browser cleanup: ${error}`); }
    report.finishedAt = new Date().toISOString();
    report.outcome = !failure && report.errors.length === 0 ? 'passed' : 'failed';
    await save('report.json', report);
  }
  if (failure) throw failure;
  assert.deepEqual(report.errors, []); return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2), evidenceIndex = args.indexOf('--evidence');
  assert.ok(evidenceIndex >= 0 && args[evidenceIndex + 1] && !args[evidenceIndex + 1].startsWith('--'), 'Usage: bun test/qa/rpc46-stats.mjs --evidence PATH [--smoke]');
  assert.ok(args.every((arg, index) => index === evidenceIndex + 1 || ['--evidence', '--smoke'].includes(arg)), 'Unknown argument');
  const report = await runRPC46Stats({ evidenceDir: args[evidenceIndex + 1], smoke: args.includes('--smoke') });
  console.log(JSON.stringify({ outcome: report.outcome, mode: report.mode, evidence: resolve(args[evidenceIndex + 1]), cleanup: report.cleanup, browserClosed: report.browserClosed }, null, 2));
}
