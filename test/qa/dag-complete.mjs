/** Lead-owned final gate. Builds an isolated Go fixture against the current
 * built SPA; never starts an external engine or accesses a user's store. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { observeSockets } from './heartbeat-liveness.mjs';
import { assertComplete, bounded, catalogPath, detailPath, expectedRun, longRunIDs, parseArgs } from './dag-complete-controls.mjs';
import { chromePath, loadDriver, root, save, startCompleteFixture, transcript } from './dag-complete-fixture.mjs';
import { httpAudit } from './dag-complete-http.mjs';
import { actionDOM, armDOM, assertSurface, browserGate, capture, closeDescriptions, descriptions, doneDOM, prepareSubagentsScenario, reconnectWithoutReplay, releaseComplete, resetScenarioViewport, screenshotPath, setupDOM, statusIs, view, waitForTranscript } from './dag-complete-browser.mjs';

export async function run({ evidenceDir }) {
  assert.ok(globalThis.Bun, 'Run with bun test/qa/dag-complete.mjs');
  evidenceDir = resolve(evidenceDir); await mkdir(evidenceDir, { recursive: true });
  const report = { passed: false, actions: [], errors: [], startedAt: new Date().toISOString() };
  const cleanup = { errors: [] }, http = [];
  let fixture, profile, context, page, observed, gate, failure;
  const interrupted = new AbortController();
  const interrupt = () => {
    interrupted.abort(new Error('QA interrupted'));
    if (context) context.close().catch(error => cleanup.errors.push({ key: 'interruptContext', error: String(error) }));
  };
  const record = (action, value = {}) => report.actions.push({ sequence: report.actions.length + 1, action, ...value });
  const command = promisify(execFile);
  const head = await command('git', ['rev-parse', 'HEAD'], { cwd: root });
  const diff = await command('git', ['diff', '--stat'], { cwd: root });
  report.input = { head: head.stdout.trim(), diff: diff.stdout };
  let expected, revisionDocument;
  async function select(id) {
    const held = gate.arm(id);
    await page.locator('[data-activity-dag-select]').selectOption(id);
    await held.captured; return held;
  }
  async function open(implicitDefault = false) {
    // The initial real summary may contain only the legacy 512-byte prefix.
    // Never select an option to rescue this: the authoritative default must load itself.
    const held = gate.arm(implicitDefault ? longRunIDs[0] : '*');
    const catalogReady = await armDOM(page, count => document.querySelector('[data-activity-dag-select]')?.options.length === count, fixture.manifest.runs.length);
    const loading = await armDOM(page, statusIs, 'loading');
    await page.locator('[role="tab"][data-activity-tab="dag"]').click();
    const receipt = await held.captured; await doneDOM(page, loading);
    const id = decodeURIComponent(receipt.path.split('/').at(-1));
    assert.equal(await page.locator('.th-activity-gnode').count(), 0, 'no partial primary graph while initial full read is held');
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'loading');
    await releaseComplete({ page, held, expected: await fixture.expected(id) });
    await doneDOM(page, catalogReady);
    assert.deepEqual((await page.locator('[data-activity-dag-select] option').evaluateAll(nodes => nodes.map(node => node.value))).sort(), fixture.manifest.runs);
    record('automatic-default-and-complete-catalog', { defaultRun: id, options: fixture.manifest.runs.length });
    if (implicitDefault) {
      assert.equal(id, longRunIDs[0]);
      assert.equal(await page.locator('[data-activity-dag-select]').inputValue(), longRunIDs[0]);
      assert.equal((await page.locator('[data-activity-dag-select] option').evaluateAll(nodes => nodes.map(node => node.value))).includes(longRunIDs[0].slice(0, 512)), false);
      await capture(page, evidenceDir, 'C2-long-implicit-default', await assertSurface(page, await fixture.expected(id), 'graph'));
      const other = await fixture.expected(longRunIDs[1]);
      await releaseComplete({ page, held: await select(longRunIDs[1]), expected: other });
      const lastPage = page.waitForResponse(async response => new URL(response.url()).pathname === catalogPath && response.status() === 200 && (await response.json()).next_cursor === null);
      const explicit = gate.arm(longRunIDs[1]);
      await page.locator('[data-activity-dag-retry]').click();
      await releaseComplete({ page, held: explicit, expected: other }); await lastPage;
      await deliver({ type: 'extensionEvent', name: 'omo.dag.heartbeat', data: { at: '2026-09-08T10:00:01Z', runs: [] } }, 'long-explicit-selection-after-paginated-refresh');
      await capture(page, evidenceDir, 'C2-long-explicit-selection', await assertSurface(page, other, 'graph'));
      record('implicit-truncated-default-and-distinct-exact-long-identities', { prefixBytes: 512, exactIDs: longRunIDs, options: fixture.manifest.runs.length });
    }
    if (id !== 'dense-64' || implicitDefault) await releaseComplete({ page, held: await select('dense-64'), expected });
  }
  async function visit(reload = false, navigate = false) {
    const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final && row.frame.sessionId === 'qa-chat', { label: '100-message native transcript' });
    if (reload && !navigate) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    const history = (await entries).frame.entries;
    assert.ok(history.length >= 100);
    assert.deepEqual(history.slice(0, 100), transcript(), 'all original 100 message IDs, links, roles and text survive');
    await waitForTranscript(page, history);
    if (!reload) {
      const original = await fixture.expected(longRunIDs[0]);
      await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true,
        runs: [{ ...original, run_id: longRunIDs[0].slice(0, 512), nodes: [], edges: [], waves: [] }] } }, 'truncated-implicit-summary-before-opening-DAG');
    }
    await open(!reload);
  }
  async function deliver(frame, label) {
    const sentinel = `dag-qa-event-${report.actions.length}`;
    const processed = await armDOM(page, value => document.querySelector('.th-chat-body')?.textContent.includes(value), sentinel);
    const seen = observed.wait(row => row.direction === 'received' && row.frame?.type === 'message' && row.frame.message.content === sentinel, { label });
    fixture.transport.deliver('qa-chat', frame);
    fixture.transport.deliver('qa-chat', { type: 'message', message: { role: 'assistant', content: sentinel } });
    await seen; await doneDOM(page, processed); record(label);
  }
  async function snap(name, mode = 'graph') {
    const observation = await assertSurface(page, expected, mode); await capture(page, evidenceDir, name, observation); record(name, { total: observation.total, mode });
  }
  async function expandedDescriptions(name) {
    for (const edge of ['start', 'end']) {
      await descriptions(page, expected, edge);
      const observation = await assertSurface(page, expected, 'graph');
      await capture(page, evidenceDir, `${name}-description-${edge}`, observation, { node: expected.nodes.at(-1), edge });
      record(`${name}-description-${edge}`, { expanded: true, bytes: 2048, edge, screenshot: `${name}-description-${edge}.png` });
    }
    await closeDescriptions(page);
  }
  let scenarioRevision = 0;
  async function subagentsProof(name, options, source) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const revision = new Date(Date.parse('2026-09-08T11:00:00Z') + scenarioRevision++ * 1000).toISOString();
      const counts = await prepareSubagentsScenario({ page, observed, fixture, viewport, source, revision, options, deliver });
      const label = viewport.width === 1280 ? name : `${name}-mobile`;
      await capture(page, evidenceDir, label, { ...counts, viewport });
      record(label, { ...counts, viewport, screenshot: `${label}.png` });
    }
  }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    fixture = await startCompleteFixture({ evidenceDir }); interrupted.signal.throwIfAborted();
    expected = await fixture.expected('dense-64');
    profile = await mkdtemp(join(tmpdir(), 'dag-complete-chrome-'));
    context = await (await loadDriver()).launchPersistentContext(profile, { executablePath: chromePath, headless: true,
      viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', timeout: 30000 });
    interrupted.signal.throwIfAborted();
    await context.grantPermissions(['local-network-access'], { origin: fixture.url });
    context.setDefaultTimeout(15000); page = context.pages()[0];
    report.browser = context.browser()?.version();
    const documents = await httpAudit({ fixture, request: context.request, evidenceDir });
    revisionDocument = documents['dense-64']; record('actual-Go-HTTP-catalog-detail-auth-path-guards');
    observed = observeSockets(page); await setupDOM(page); gate = await browserGate(page, http);
    page.on('pageerror', error => report.errors.push({ type: 'pageerror', error: String(error) }));
    await visit(); await snap('C2-desktop');
    await expandedDescriptions('C2-desktop'); record('full-2048-byte-description-expanded');
    await view(page, 'list'); await snap('C2-desktop-list', 'list'); await view(page, 'graph');
    await actionDOM(page, () => document.querySelector('.th-chat-body')?.scrollTop === 0,
      () => page.locator('.th-chat-body').evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' })));
    await snap('C2-desktop-top');

    // A real invalid owned checkpoint supplies HTTP 422; no fake DAG error body.
    const brokenId = 'history-000', original = await fixture.source(brokenId), broken = structuredClone(original);
    broken.definition.nodes.push(structuredClone(broken.definition.nodes[0]));
    await fixture.replace(brokenId, broken);
    const invalid = await select(brokenId); assert.equal(invalid.receipt.status, 422);
    const errorDOM = await armDOM(page, statusIs, 'error'); invalid.release(); await doneDOM(page, errorDOM);
    assert.equal(await page.locator('.th-activity-gnode').count(), 0);
    assert.equal(await page.locator('[role="alert"]').count() > 0, true); record('owned-malformed-422-no-primary-topology');
    await fixture.replace(brokenId, original);
    const retry = gate.arm(brokenId); await page.locator('[data-activity-dag-retry]').click();
    await releaseComplete({ page, held: retry, expected: expectedRun(original) });
    await releaseComplete({ page, held: await select('dense-64'), expected });

    // Each request keeps its own actual Go body. Abort the old browser generation.
    const old = await select('history-001');
    const aborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === detailPath('history-001'), timeout: 15000 });
    const selected = await select('dense-64'); await aborted;
    await releaseComplete({ page, held: selected, expected }); old.release();
    await assertSurface(page, expected, 'graph'); record('late-request-generation-cannot-replace-selection');

    // Hold an already-read old source, atomically install a new checkpoint, and
    // announce a newer partial summary while full retrieval is in flight.
    const heldOld = gate.arm('dense-64'); await page.locator('[data-activity-dag-retry]').click(); await heldOld.captured;
    const newer = await fixture.source('dense-64'); newer.updatedAt = '2026-09-08T10:01:00Z'; newer.nodes[0].state = 'completed';
    await fixture.replace('dense-64', newer); expected = expectedRun(newer);
    const heldNew = gate.arm('dense-64');
    const partial = { ...expected, nodes: expected.nodes.slice(0, 1), edges: [], waves: [], truncated_nodes: true };
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true, runs: [partial] } }, 'newer-partial-during-full-read');
    assert.equal(await page.locator('.th-activity-gnode').count(), 64);
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'refreshing');
    assertComplete(JSON.parse(heldOld.receipt.body), revisionDocument.run); heldOld.release();
    await heldNew.captured;
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'refreshing');
    assert.equal(await page.locator('.th-activity-gnode').count(), 64);
    const fresh = await releaseComplete({ page, held: heldNew, expected });
    assert.notEqual(fresh.content_token, revisionDocument.content_token);
    await save(evidenceDir, 'C4-stable.json', { boundary: 'old Go response captured before owned atomic rename; next read is wholly new',
      old: revisionDocument.content_token, newer: fresh.content_token, oldTotal: 64, newTotal: 64, passed: true });
    const requestCount = http.length;
    await deliver({ type: 'extensionEvent', name: 'omo.dag.heartbeat', data: { at: '2026-09-08T10:02:00Z', runs: [{ runId: 'dense-64', headSeq: 123 }] } }, 'heartbeat-does-not-restart-full-read');
    assert.equal(http.length, requestCount); await assertSurface(page, expected, 'graph');

    const oversizedFrame = { type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: false, runs: [{ ...expected, waves: [] }] } };
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedFrame)) > 64 * 1024);
    const beforeDuplicate = http.length;
    const recovery = await reconnectWithoutReplay({ deliver, frame: oversizedFrame, gate, observed,
      disconnect: () => fixture.transport.disconnect('qa-chat'),
      assertCurrent: async () => { assert.equal(http.length, beforeDuplicate, 'equal-revision duplicate does not require redundant HTTP'); await assertSurface(page, expected, 'graph'); },
      restore: held => releaseComplete({ page, held, expected }),
    });
    record('oversized-replay-loss-authoritative-HTTP-restoration', recovery);
    await snap('C2-reconnect');

    // Equal revision is not permission to replace already accepted full facts.
    const stableSource = await fixture.source('dense-64'), conflict = structuredClone(stableSource);
    conflict.nodes[0].state = 'running';
    await fixture.replace('dense-64', conflict);
    const conflictingFull = gate.arm('dense-64'); await page.locator('[data-activity-dag-retry]').click();
    assertComplete(JSON.parse((await conflictingFull.captured).body), expectedRun(conflict));
    const staleFull = await armDOM(page, statusIs, 'stale'); conflictingFull.release(); await doneDOM(page, staleFull);
    const retained = await assertSurface(page, expected, 'graph', 'stale');
    assert.equal(retained.token, fresh.content_token);
    await capture(page, evidenceDir, 'C2-equal-version-full-conflict', retained);
    record('equal-version-conflicting-full-retains-original-facts', { token: retained.token, rejectedToken: JSON.parse(conflictingFull.receipt.body).content_token });
    await fixture.replace('dense-64', stableSource);
    const restoredFull = gate.arm('dense-64'); await page.locator('[data-activity-dag-retry]').click();
    await releaseComplete({ page, held: restoredFull, expected });

    // An actual two-node checkpoint disagrees with a known partial node's state.
    // No complete document for this run has been admitted by the browser yet.
    let pairSource = await fixture.source('long-identities');
    pairSource.updatedAt = '2026-09-08T10:05:00Z'; pairSource.status = 'running';
    for (const node of pairSource.nodes) { node.state = 'running'; delete node.completedAt; }
    await fixture.replace('long-identities', pairSource);
    let pair = expectedRun(pairSource);
    const partialConflict = { ...pair, nodes: [{ ...pair.nodes[0], state: 'completed' }], edges: [], waves: [] };
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true, runs: [partialConflict] } }, 'known-partial-equal-version-conflicting-state');
    const rejectedPartial = await select('long-identities');
    assertComplete(JSON.parse(rejectedPartial.receipt.body), pair);
    const stalePartial = await armDOM(page, statusIs, 'stale'); rejectedPartial.release(); await doneDOM(page, stalePartial);
    assert.equal(await page.locator('.th-activity-gnode').count(), 0, 'conflicting partial cannot become a current full graph');
    assert.equal(await page.locator('[data-activity-dag-total]').count(), 0);
    await screenshotPath(page, join(evidenceDir, 'C2-equal-version-partial-conflict.png'));
    record('equal-version-partial-conflict-stays-explicit-stale', { status: 'stale', graphNodes: 0, receivedToken: JSON.parse(rejectedPartial.receipt.body).content_token });

    pairSource.updatedAt = '2026-09-08T10:06:00Z'; await fixture.replace('long-identities', pairSource); pair = expectedRun(pairSource);
    const enrichment = gate.arm('long-identities');
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true,
      runs: [{ ...pair, nodes: pair.nodes.slice(0, 1), edges: [], waves: [] }] } }, 'nonconflicting-partial-same-version-enrichment');
    await releaseComplete({ page, held: enrichment, expected: pair });
    await capture(page, evidenceDir, 'C2-same-version-enrichment', await assertSurface(page, pair, 'graph'));
    record('same-version-full-enriches-nonconflicting-original-topology', { total: 2, exactNodeIDs: pair.nodes.map(node => node.id) });

    // Each viewport gets a fresh native binding and completed REST hydration,
    // then real tab selection and strictly newer controlled source revisions.
    // Complete task authority is not mocked; no task records are injected.
    const largeSource = structuredClone(stableSource); largeSource.status = 'running';
    for (const node of largeSource.nodes) { node.state = 'running'; delete node.completedAt; }
    await subagentsProof('C2-subagents-partial-twelve', { partial: true, retained: 12 }, largeSource);
    await fixture.replace('dense-64', stableSource);
    for (const [retained, partial, name] of [[1, true, 'C2-subagents-partial-one'], [0, true, 'C2-subagents-partial-zero'], [2, false, 'C2-subagents-full-two']]) {
      await subagentsProof(name, { partial, retained }, pairSource);
    }
    pair = await fixture.expected('long-identities');
    // Fresh panes have no remembered run selection. Discover the real catalog
    // and explicitly select the authoritative pair through the actual control.
    await open();
    await releaseComplete({ page, held: await select('long-identities'), expected: pair });
    await capture(page, evidenceDir, 'C2-subagents-authoritative-full-two', await assertSurface(page, pair, 'graph'));
    record('partial-Subagents-qualified-and-authoritative-full-two-restored', { running: 2, total: 2 });
    await releaseComplete({ page, held: await select('dense-64'), expected });
    await resetScenarioViewport(page, fixture.url, { width: 1280, height: 800 });
    await visit(true, true); await visit(true); await snap('C2-reload');
    await resetScenarioViewport(page, fixture.url, { width: 390, height: 844 });
    await visit(true, true); await visit(true); await snap('C2-mobile');
    await expandedDescriptions('C2-mobile'); await view(page, 'list'); await snap('C2-mobile-list', 'list'); await view(page, 'graph');
    assert.equal(fixture.transport.base.frames.filter(frame => frame.type === 'chat.send').length, 0);
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    cleanup.interrupted = interrupted.signal.aborted;
    const clean = async (key, action) => { try { cleanup[key] = await action() ?? true; } catch (error) { cleanup.errors.push({ key, error: String(error) }); } };
    if (failure && page && !page.isClosed()) await clean('failureScreenshot', () => screenshotPath(page, join(evidenceDir, 'C2-failure.png')));
    if (gate) await clean('gate', async () => { const result = await bounded(gate.stop(), 'route cleanup'); assert.deepEqual(result.errors, []); return result; });
    if (page && !page.isClosed()) await clean('DOMObservers', () => page.evaluate(() => window.__dagQA?.stop() ?? 0));
    if (observed) { observed.stop(); await save(evidenceDir, 'qa-websocket-timeline.json', observed.timeline); }
    if (context) await clean('browserContextClosed', () => context.close());
    if (profile) await clean('profileRemoved', () => rm(profile, { recursive: true, force: true }));
    if (fixture) await clean('fixture', async () => { const result = await fixture.stop(); assert.deepEqual(result.errors, []); return result; });
    report.passed = report.passed && !failure && cleanup.errors.length === 0; report.finishedAt = new Date().toISOString();
    await save(evidenceDir, 'qa-browser-http-receipts.json', http);
    await save(evidenceDir, 'cleanup.json', cleanup); await save(evidenceDir, 'C2-actions.json', report);
  }
  if (failure) throw failure;
  assert.equal(report.passed, true, 'QA or cleanup failed'); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
