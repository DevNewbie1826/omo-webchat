/** Lead-owned C3 gate: real built SPA + fresh Chrome profiles, native summary WS.
 * Build separately after producers settle. This command never edits product files.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { confirmPortReleased, installDOMSignals, launchChild, snapshotAssets } from './dag-state-ordering.mjs';
import { activityPath, createTaskRequestGate, deadline, pollPath } from './task-state-fixture.mjs';
import { observeSockets } from './heartbeat-liveness.mjs';
import { stages, summaryInput, summaryFrame, startSummaryFixture, viewports } from './dag-summary-fixture.mjs';
import { armDOM, doneDOM, readSummaryDOM, assertSummaryDOM, assertVisibleBadge, settleCapture } from './dag-summary-surface.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '../..');
const save = (dir, name, body) => writeFile(join(dir, name), JSON.stringify(body, null, 2) + '\n');
export function parseArgs(args) {
  assert.equal(args.length, 2, 'Usage: bun test/qa/dag-summary.mjs --evidence-dir ABSOLUTE_PATH');
  assert.equal(args[0], '--evidence-dir'); assert.ok(args[1] && !args[1].startsWith('--'));
  return { evidenceDir: resolve(args[1]) };
}

export async function run({ evidenceDir, assetsDir = join(root, 'frontend/dist'), chromium } = {}) {
  assert.ok(evidenceDir, '--evidence-dir is required'); evidenceDir = resolve(evidenceDir);
  await mkdir(evidenceDir, { recursive: true });
  if (!globalThis.Bun) {
    assert.ok(!chromium && assetsDir === join(root, 'frontend/dist'), 'Injected test resources require Bun');
    const child = await launchChild('/opt/homebrew/bin/bun', [script, '--evidence-dir', evidenceDir], { cwd: root });
    const cleanup = JSON.parse(await readFile(join(evidenceDir, 'cleanup.json'), 'utf8'));
    cleanup.child = child; await save(evidenceDir, 'cleanup.json', cleanup);
    assert.equal(child.code, 0, `Bun child exited ${child.code ?? child.signal}`);
    return { ...JSON.parse(await readFile(join(evidenceDir, 'C3-actions.json'), 'utf8')), cleanup };
  }
  const report = { startedAt: new Date().toISOString(), passed: false, surface: 'built-SPA', actions: [], captures: [], errors: [] };
  const cleanup = { fixtureInMemoryOnly: true, cases: [], errors: [] };
  const record = row => report.actions.push({ sequence: report.actions.length + 1, ...row });
  let assets, failure;
  const clean = async (receipt, key, action) => {
    try { receipt[key] = await action() ?? true; }
    catch (error) { receipt.errors.push({ key, error: String(error) }); }
  };
  try {
    const git = async args => (await promisify(execFile)('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout;
    report.inputTree = { root, head: (await git(['rev-parse', 'HEAD'])).trim(), status: await git(['status', '--short']) };
    await writeFile(join(evidenceDir, 'input-tree.diff'), await git(['diff', 'HEAD', '--', 'frontend', 'test/qa']));
    assets = await snapshotAssets(assetsDir); await save(evidenceDir, 'asset-hashes.json', assets);
    const copy = JSON.parse(await readFile(join(root, 'frontend/src/i18n/locales/en.json'), 'utf8'));
    const driver = chromium ?? (await import(pathToFileURL(process.env.QA_PLAYWRIGHT ?? '/private/tmp/omo-asar/node_modules/playwright-core/index.mjs').href)).chromium;
    for (const viewport of viewports) {
      const name = `${viewport.width}x${viewport.height}`, receipt = { name, errors: [] };
      cleanup.cases.push(receipt);
      let fixture, context, page, observed, gate, profile;
      async function overview(open) {
        const signal = await armDOM(page, open => Boolean(document.querySelector('.th-overview')) === open, open);
        if (open) await page.locator('.th-sidebar-nav').getByRole('button', { name: copy['sidebar.overview'], exact: true }).click();
        else await page.locator('[role="dialog"] .th-modal-close').click();
        await doneDOM(page, signal);
      }
      async function capture(stage, surface) {
        const settled = await settleCapture(page), dom = await page.evaluate(readSummaryDOM);
        const binary = assertSummaryDOM(dom, stage, copy, [surface]); assertVisibleBadge(dom, surface);
        const stem = `C3-${name}-${stage}-${surface}`;
        const png = await page.screenshot({ path: join(evidenceDir, stem + '.png'), fullPage: false });
        assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
        const data = { name: stem, stage, surface, settled, dom, binary,
          screenshot: { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } };
        await writeFile(join(evidenceDir, stem + '.html'), await page.content());
        await save(evidenceDir, stem + '.json', data); report.captures.push(data);
        if (viewport.width === 1280 && stage === stages[0] && surface === 'overview') await writeFile(join(evidenceDir, 'C3-overview.png'), png);
      }
      try {
        fixture = startSummaryFixture({ assetsDir: assets.directory }); receipt.urls = [fixture.url, fixture.base.url];
        profile = await mkdtemp(join(tmpdir(), 'cli-webchat-dag-summary-chrome-')); receipt.profile = profile;
        context = await driver.launchPersistentContext(profile, {
          executablePath: process.env.QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          headless: true, viewport, reducedMotion: 'reduce', timeout: deadline,
        });
        receipt.browserVersion = context.browser()?.version(); context.setDefaultTimeout(deadline);
        page = context.pages()[0] ?? await context.newPage(); observed = observeSockets(page);
        page.on('pageerror', error => report.errors.push({ name, kind: 'pageerror', error: String(error) }));
        page.on('console', msg => { if (msg.type() === 'error') report.errors.push({ name, kind: 'console', error: msg.text() }); });
        page.on('response', r => { if (r.status() >= 400) report.errors.push({ name, kind: 'http', url: r.url(), status: r.status() }); });
        gate = createTaskRequestGate(row => record({ viewport: name, ...row }));
        await page.route('**/api/**', gate.handle); await installDOMSignals(page);
        const activity = gate.next(activityPath), polling = gate.next(pollPath);
        const subscription = fixture.base.wait('frame', f => f.type === 'sessions.subscribe' && f.mode === 'all_live');
        const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final);
        await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
        await subscription; assert.equal((await entries).frame.entries.length, 160);
        await page.evaluate(() => window.__dagQA.done(window.__dagQA.initial));
        const response = page.waitForResponse(r => new URL(r.url()).pathname === activityPath, { timeout: deadline });
        await gate.release(await activity, { history: {} }); await (await response).finished();
        const pollToken = await polling;
        const initial = await page.evaluate(readSummaryDOM);
        assert.ok(initial.transcript.height > initial.transcript.client, 'real long transcript overflows');
        if (viewport.width === 390) {
          const signal = await armDOM(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true' && !!document.querySelector('.th-backdrop'));
          await page.locator('.th-mobile-menu').click(); await doneDOM(page, signal);
        }
        for (const stage of stages) {
          await overview(true);
          const input = summaryInput(stage);
          const signal = await armDOM(page, marker => [...document.querySelectorAll('.th-overview-card-line')].some(n => n.textContent === marker), input.marker);
          if (stage === stages[0]) {
            const { marker, ...session } = input, body = { sessions: [session] };
            const response = page.waitForResponse(r => new URL(r.url()).pathname === pollPath, { timeout: deadline });
            await gate.release(pollToken, body); await (await response).finished();
            record({ viewport: name, action: 'summary-REST', stage, marker, body });
          } else {
            const frame = summaryFrame(stage), after = observed.mark();
            const received = observed.wait(row => row.direction === 'received' && JSON.stringify(row.frame) === JSON.stringify(frame), { after, label: stage });
            fixture.overview(frame); const delivery = await received;
            record({ viewport: name, action: 'summary-native-WS', stage, frame, socketId: delivery.socketId });
          }
          await doneDOM(page, signal);
          const dom = await page.evaluate(readSummaryDOM);
          record({ viewport: name, stage, action: 'observed-summary-projection', dom });
          const binary = assertSummaryDOM(dom, stage, copy);
          assert.equal(dom.marker, input.marker, 'same projection marker proves the exact summary was consumed');
          record({ viewport: name, stage, action: 'assert-summary-projection', binary });
          await capture(stage, 'overview'); await overview(false); await capture(stage, 'sidebar');
        }
        if (viewport.width === 390) {
          const signal = await armDOM(page, () => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true' && !document.querySelector('.th-backdrop'));
          await page.locator('.th-backdrop').click({ position: { x: 380, y: 100 } }); await doneDOM(page, signal);
        }
        assert.equal(fixture.base.frames.filter(f => f.type === 'chat.send').length, 0, 'no prompts sent');
        assert.deepEqual(fixture.base.unexpected, []); assert.deepEqual(fixture.errors, []);
        assert.deepEqual(report.errors.filter(row => row.name === name), []);
      } catch (error) {
        if (page && !page.isClosed()) await clean(receipt, 'failureCapture', async () => {
          await save(evidenceDir, `C3-${name}-failure.json`, await page.evaluate(readSummaryDOM));
          await writeFile(join(evidenceDir, `C3-${name}-failure.html`), await page.content());
          await page.screenshot({ path: join(evidenceDir, `C3-${name}-failure.png`), fullPage: false });
        });
        throw error;
      } finally {
        if (gate) await clean(receipt, 'routes', async () => { const value = await gate.stop(); assert.deepEqual(value.errors, []); return value; });
        if (page && !page.isClosed()) await clean(receipt, 'domObservers', () => page.evaluate(() => window.__dagQA?.stop() ?? 0));
        observed?.stop();
        if (context) await clean(receipt, 'contextClosed', () => context.close());
        if (fixture) {
          await clean(receipt, 'fixture', async () => { const value = await fixture.stop(); assert.deepEqual(value.errors, []); assert.equal(value.pendingWebSockets, 0); return value; });
          await clean(receipt, 'portsReleased', () => Promise.all(receipt.urls.map(url => confirmPortReleased(Number(new URL(url).port)))));
        }
        if (profile) await clean(receipt, 'profileRemoved', async () => { await rm(profile, { recursive: true, force: true }); await assert.rejects(access(profile), { code: 'ENOENT' }); return true; });
        await save(evidenceDir, `${name}-websocket-timeline.json`, observed?.timeline ?? []);
        await save(evidenceDir, `${name}-fixture-traffic.json`, { proxy: fixture?.traffic ?? [], base: fixture?.base.traffic ?? [] });
        cleanup.errors.push(...receipt.errors.map(error => ({ name, ...error })));
      }
    }
    assert.equal(report.captures.length, viewports.length * stages.length * 2);
    assert.deepEqual(cleanup.errors, []); report.passed = true;
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    if (assets) await clean(cleanup, 'assetsRemoved', async () => { await rm(assets.directory, { recursive: true, force: true }); await assert.rejects(access(assets.directory), { code: 'ENOENT' }); return true; });
    report.passed = report.passed && cleanup.errors.length === 0; report.finishedAt = new Date().toISOString();
    await save(evidenceDir, 'C3-actions.json', report); await save(evidenceDir, 'cleanup.json', cleanup);
  }
  if (failure) throw failure;
  assert.deepEqual(cleanup.errors, []); return { ...report, cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const report = await run(parseArgs(process.argv.slice(2))); console.log(JSON.stringify({ passed: report.passed, cleanup: report.cleanup }, null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
