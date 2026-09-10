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
import { assertComplete, bounded, catalogPageSize, expectedRun, isCatalogPath, isDetailPath, longRunIDs, parseArgs } from './dag-complete-controls.mjs';
import { chromePath, loadDriver, root, save, startCompleteFixture, transcript } from './dag-complete-fixture.mjs';
import { httpAudit } from './dag-complete-http.mjs';
import { r5Proof } from './dag-complete-r5.mjs';
import { actionDOM, armDOM, assertList, assertSurface, browserGate, capture, closeDescriptions, dagRunReceipts, descriptions, doneDOM, openDagTab, prepareSubagentsScenario, reconnectWithoutReplay, releaseComplete, resetScenarioViewport, runCard, screenshotPath, scrollDagListEnd, setupDOM, statusIs, view, waitForTranscript } from './dag-complete-browser.mjs';

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
  let expected, revisionDocument, loadedExpecteds = [];
  const pageIds = (start, count = catalogPageSize) => fixture.manifest.newestFirst.slice(start, start + count);
  const nodeCount = expecteds => expecteds.reduce((sum, item) => sum + item.nodes.length, 0);
  async function expectedsFor(ids) { return Promise.all(ids.map(id => fixture.expected(id))); }
  async function releasePage(ids, held, expectedById = {}) {
    const expecteds = [];
    for (const [index, id] of ids.entries()) {
      const item = expectedById[id] ?? await fixture.expected(id);
      expecteds.push(item);
      await releaseComplete({ page, held: held[index], expected: item });
    }
    return expecteds;
  }
  async function openList({ expectNewest = true } = {}) {
    const catalogHeld = gate.arm('catalog');
    const loading = await armDOM(page, statusIs, 'loading');
    assert.equal(await openDagTab(page), true);
    await catalogHeld.captured; await doneDOM(page, loading);
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'loading');
    assert.equal(await page.locator('.th-activity-gnode').count(), 0, 'no partial primary graph while the catalog is held');
    const body = JSON.parse(catalogHeld.receipt.body);
    const ids = body.runs.map(run => run.run_id);
    assert.equal(ids.length, catalogPageSize);
    if (expectNewest) {
      assert.deepEqual(ids, pageIds(0));
      assert.equal(body.runs.some(run => run.run_id === longRunIDs[0].slice(0, 512) || run.run_id === longRunIDs[1].slice(0, 512)), false);
      assert.equal(ids.includes(longRunIDs[0]) && ids.includes(longRunIDs[1]), true);
    }
    const held = ids.map(id => gate.arm(id));
    catalogHeld.release();
    await Promise.all(held.map(item => item.captured));
    assert.equal(await page.locator('.th-activity-gnode').count(), 0, 'no partial primary graph while initial full reads are held');
    loadedExpecteds = await releasePage(ids, held);
    const listed = await assertList(page, loadedExpecteds);
    record('automatic-newest-page-and-complete-catalog', { ids, catalogRequests: dagRunReceipts(http).filter(row => isCatalogPath(row.path)).length,
      details: dagRunReceipts(http).filter(row => isDetailPath(row.path)).length, rendered: listed.names.length });
    return listed;
  }
  async function loadMore() {
    const nextIds = pageIds(catalogPageSize);
    const priorNames = loadedExpecteds.map(item => item.name);
    const catalogHeld = gate.arm('catalog');
    const last = await fixture.expected(nextIds.at(-1));
    const rendered = await armDOM(page, ({ count, lastName, lastNodes }) => {
      const cards = [...document.querySelectorAll('.th-activity-dag')];
      const card = cards.at(-1);
      return cards.length === count
        && card?.querySelector('.th-activity-dag-name')?.textContent === lastName
        && card.querySelectorAll('.th-activity-gnode').length === lastNodes;
    }, { count: catalogPageSize * 2, lastName: last.name, lastNodes: last.nodes.length });
    await scrollDagListEnd(page);
    const body = JSON.parse((await catalogHeld.captured).body);
    assert.deepEqual(body.runs.map(run => run.run_id), nextIds);
    const held = nextIds.map(id => gate.arm(id));
    catalogHeld.release();
    await Promise.all(held.map(item => item.captured));
    const extraGraphs = await page.evaluate(names => names.reduce((sum, name) => {
      const card = [...document.querySelectorAll('.th-activity-dag')].find(node => node.querySelector('.th-activity-dag-name')?.textContent === name);
      return sum + (card?.querySelectorAll('.th-activity-gnode').length ?? 0);
    }, 0), (await expectedsFor(nextIds)).map(item => item.name));
    assert.equal(extraGraphs, 0, 'no partial next-page graphs while full reads are held');
    assert.deepEqual(await page.locator('.th-activity-dag .th-activity-dag-name').evaluateAll(nodes => nodes.map(node => node.textContent).slice(0, priorNames.length)), priorNames);
    const extra = await releasePage(nextIds, held);
    await doneDOM(page, rendered);
    loadedExpecteds = [...loadedExpecteds, ...extra];
    const listed = await assertList(page, loadedExpecteds);
    const catalogs = dagRunReceipts(http).filter(row => isCatalogPath(row.path));
    const details = dagRunReceipts(http).filter(row => isDetailPath(row.path));
    assert.equal(catalogs.length, 2, 'exactly two catalog pages after one more-page scroll');
    assert.equal(details.length, catalogPageSize * 2, 'exactly twenty full-run reads after one more-page scroll');
    assert.equal(listed.names.length, catalogPageSize * 2);
    record('scroll-end-next-page', { ids: nextIds, catalogRequests: catalogs.length, details: details.length, rendered: listed.names.length });
    return listed;
  }
  async function visit(reload = false, navigate = false) {
    const marked = http.length;
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
    assert.deepEqual(dagRunReceipts(http, marked), [], 'DAG tab closed: zero graph/full-run fetches; scalar polling only');
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
      await capture(page, evidenceDir, `${name}-description-${edge}`, observation, { node: expected.nodes.at(-1), edge, run: expected });
      record(`${name}-description-${edge}`, { expanded: true, bytes: 2048, edge, screenshot: `${name}-description-${edge}.png` });
    }
    await closeDescriptions(page, expected);
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
    await visit();
    await openList();
    await snap('C2-desktop');
    await expandedDescriptions('C2-desktop'); record('full-2048-byte-description-expanded');
    await view(page, 'list', nodeCount(loadedExpecteds)); await snap('C2-desktop-list', 'list'); await view(page, 'graph', nodeCount(loadedExpecteds));
    await actionDOM(page, () => document.querySelector('.th-chat-body')?.scrollTop === 0,
      () => page.locator('.th-chat-body').evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' })));
    await snap('C2-desktop-top');
    await capture(page, evidenceDir, 'C2-long-exact-identities', await assertSurface(page, await fixture.expected(longRunIDs[0]), 'graph'));
    record('implicit-truncated-summary-and-distinct-exact-long-identities', { prefixBytes: 512, exactIDs: longRunIDs, rendered: loadedExpecteds.map(item => item.run_id) });
    await loadMore();
    await capture(page, evidenceDir, 'C2-load-more', await assertSurface(page, expected, 'graph'));

    const restoreRuns = await fixture.isolateEmptyCatalog();
    const emptyCatalog = gate.arm('catalog');
    const empty = await armDOM(page, statusIs, 'empty');
    await page.locator('[data-activity-dag-retry]').click();
    assert.deepEqual(JSON.parse((await emptyCatalog.captured).body).runs, []);
    emptyCatalog.release(); await doneDOM(page, empty);
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'empty');
    assert.equal(await page.locator('.th-activity-dag').count(), 0);
    await capture(page, evidenceDir, 'C2-empty', { viewport: { width: 1280, height: 800 }, status: 'empty', rendered: 0 });
    record('forced-empty-catalog-renders-empty');
    await restoreRuns();
    loadedExpecteds = [];
    const restoredCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const restoredBody = JSON.parse((await restoredCatalog.captured).body);
    const restoredIds = restoredBody.runs.map(run => run.run_id);
    assert.deepEqual(restoredIds, pageIds(0));
    const restoredHeld = restoredIds.map(id => gate.arm(id));
    restoredCatalog.release();
    loadedExpecteds = await releasePage(restoredIds, restoredHeld);
    await assertList(page, loadedExpecteds);

    // A real invalid owned checkpoint supplies HTTP 422; no fake DAG error body.
    const brokenId = 'dense-64', original = await fixture.source(brokenId), broken = structuredClone(original);
    broken.definition.nodes.push(structuredClone(broken.definition.nodes[0]));
    await fixture.replace(brokenId, broken);
    const errorCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const errorIds = JSON.parse((await errorCatalog.captured).body).runs.map(run => run.run_id);
    const errorHeld = Object.fromEntries(errorIds.map(id => [id, gate.arm(id)]));
    errorCatalog.release();
    const invalid = errorHeld[brokenId]; assert.equal((await invalid.captured).status, 422);
    const errorDOM = await armDOM(page, statusIs, 'error'); invalid.release(); await doneDOM(page, errorDOM);
    assert.equal(await runCard(page, expected).locator('.th-activity-gnode').count(), 0);
    assert.equal(await page.locator('[role="alert"]').count() > 0, true); record('owned-malformed-422-no-primary-topology');
    await fixture.replace(brokenId, original);
    const retryCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const retryIds = JSON.parse((await retryCatalog.captured).body).runs.map(run => run.run_id);
    const retryHeld = retryIds.map(id => gate.arm(id));
    retryCatalog.release();
    loadedExpecteds = await releasePage(retryIds, retryHeld);
    await assertList(page, loadedExpecteds);

    // Each request keeps its own actual Go body. Reverse-release cannot swap cards.
    const genCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const genIds = JSON.parse((await genCatalog.captured).body).runs.map(run => run.run_id);
    const genHeld = genIds.map(id => gate.arm(id));
    genCatalog.release();
    await Promise.all(genHeld.map(item => item.captured));
    const genExpecteds = [];
    for (let index = genIds.length - 1; index >= 0; index--) {
      genExpecteds[index] = await fixture.expected(genIds[index]);
      await releaseComplete({ page, held: genHeld[index], expected: genExpecteds[index] });
    }
    loadedExpecteds = genExpecteds;
    await assertList(page, loadedExpecteds);
    record('late-request-generation-cannot-replace-neighbor-cards');

    // Hold an already-read old source, atomically install a new checkpoint, and
    // announce a newer partial summary while full retrieval is in flight.
    const oldCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const oldIds = JSON.parse((await oldCatalog.captured).body).runs.map(run => run.run_id);
    const oldHeld = oldIds.map(id => gate.arm(id));
    oldCatalog.release();
    const denseIndex = oldIds.indexOf('dense-64');
    await oldHeld[denseIndex].captured;
    const newer = await fixture.source('dense-64'); newer.updatedAt = '2026-09-08T10:01:00Z'; newer.nodes[0].state = 'completed';
    await fixture.replace('dense-64', newer); expected = expectedRun(newer);
    const heldNew = gate.arm('dense-64');
    const partial = { ...expected, nodes: expected.nodes.slice(0, 1), edges: [], waves: [], truncated_nodes: true };
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true, runs: [partial] } }, 'newer-partial-during-full-read');
    assert.equal(await runCard(page, expected).locator('.th-activity-gnode').count(), 64);
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'refreshing');
    assertComplete(JSON.parse(oldHeld[denseIndex].receipt.body), revisionDocument.run);
    for (const [index, id] of oldIds.entries()) {
      if (id === 'dense-64') oldHeld[index].release();
      else await releaseComplete({ page, held: oldHeld[index], expected: await fixture.expected(id) });
    }
    await heldNew.captured;
    assert.equal(await page.locator('[data-activity-dag-status]').getAttribute('data-activity-dag-status'), 'refreshing');
    assert.equal(await runCard(page, expected).locator('.th-activity-gnode').count(), 64);
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
    const conflictCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const conflictIds = JSON.parse((await conflictCatalog.captured).body).runs.map(run => run.run_id);
    const conflictHeld = Object.fromEntries(conflictIds.map(id => [id, gate.arm(id)]));
    conflictCatalog.release();
    const conflictingFull = conflictHeld['dense-64'];
    assertComplete(JSON.parse((await conflictingFull.captured).body), expectedRun(conflict));
    const staleFull = await armDOM(page, statusIs, 'stale'); conflictingFull.release(); await doneDOM(page, staleFull);
    const retained = await assertSurface(page, expected, 'graph', 'stale');
    assert.equal(retained.token, fresh.content_token);
    await capture(page, evidenceDir, 'C2-equal-version-full-conflict', retained);
    record('equal-version-conflicting-full-retains-original-facts', { token: retained.token, rejectedToken: JSON.parse(conflictingFull.receipt.body).content_token });
    for (const id of conflictIds) if (id !== 'dense-64') conflictHeld[id].release();
    await fixture.replace('dense-64', stableSource);
    expected = expectedRun(stableSource);
    const restoredCatalog2 = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const restoredIds2 = JSON.parse((await restoredCatalog2.captured).body).runs.map(run => run.run_id);
    const restoredHeld2 = restoredIds2.map(id => gate.arm(id));
    restoredCatalog2.release();
    loadedExpecteds = await releasePage(restoredIds2, restoredHeld2, { 'dense-64': expected });
    await assertList(page, loadedExpecteds);

    // An actual two-node checkpoint disagrees with a known partial node's state.
    let pairSource = await fixture.source('long-identities');
    pairSource.updatedAt = '2026-09-08T10:05:00Z'; pairSource.status = 'running';
    for (const node of pairSource.nodes) { node.state = 'running'; delete node.completedAt; }
    await fixture.replace('long-identities', pairSource);
    let pair = expectedRun(pairSource);
    const partialConflict = { ...pair, nodes: [{ ...pair.nodes[0], state: 'completed' }], edges: [], waves: [] };
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true, runs: [partialConflict] } }, 'known-partial-equal-version-conflicting-state');
    const rejectedCatalog = gate.arm('catalog');
    await page.locator('[data-activity-dag-retry]').click();
    const rejectedIds = JSON.parse((await rejectedCatalog.captured).body).runs.map(run => run.run_id);
    const rejectedHeld = Object.fromEntries(rejectedIds.map(id => [id, gate.arm(id)]));
    rejectedCatalog.release();
    const rejectedPartial = rejectedHeld['long-identities'];
    assertComplete(JSON.parse((await rejectedPartial.captured).body), pair);
    const stalePartial = await armDOM(page, statusIs, 'stale'); rejectedPartial.release(); await doneDOM(page, stalePartial);
    assert.equal(await runCard(page, pair).locator('.th-activity-gnode').count(), 0, 'conflicting partial cannot become a current full graph');
    assert.equal(await runCard(page, pair).locator('[data-activity-dag-total]').count(), 0);
    await screenshotPath(page, join(evidenceDir, 'C2-equal-version-partial-conflict.png'));
    record('equal-version-partial-conflict-stays-explicit-stale', { status: 'stale', graphNodes: 0, receivedToken: JSON.parse(rejectedPartial.receipt.body).content_token });
    for (const id of rejectedIds) if (id !== 'long-identities') rejectedHeld[id].release();

    pairSource.updatedAt = '2026-09-08T10:06:00Z'; await fixture.replace('long-identities', pairSource); pair = expectedRun(pairSource);
    const enrichCatalog = gate.arm('catalog');
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: true,
      runs: [{ ...pair, nodes: pair.nodes.slice(0, 1), edges: [], waves: [] }] } }, 'nonconflicting-partial-same-version-enrichment');
    await page.locator('[data-activity-dag-retry]').click();
    const enrichIds = JSON.parse((await enrichCatalog.captured).body).runs.map(run => run.run_id);
    const enrichHeld = enrichIds.map(id => gate.arm(id));
    enrichCatalog.release();
    loadedExpecteds = await releasePage(enrichIds, enrichHeld, { 'long-identities': pair });
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
    const denseNow = await fixture.source('dense-64');
    denseNow.updatedAt = '2026-09-08T12:00:00Z';
    await fixture.replace('dense-64', denseNow);
    expected = expectedRun(denseNow);
    fixture.manifest.newestFirst = ['dense-64', ...fixture.manifest.newestFirst.filter(id => id !== 'dense-64')];
    await openList();
    await capture(page, evidenceDir, 'C2-subagents-authoritative-full-two', await assertSurface(page, pair, 'graph'));
    record('partial-Subagents-qualified-and-authoritative-full-two-restored', { running: pair.counts.running, total: pair.counts.total });
    await resetScenarioViewport(page, fixture.url, { width: 1280, height: 800 });
    await visit(true, true); await visit(true); await openList(); await snap('C2-reload');
    await resetScenarioViewport(page, fixture.url, { width: 390, height: 844 });
    await visit(true, true); await visit(true); await openList(); await snap('C2-mobile');
    await expandedDescriptions('C2-mobile'); await view(page, 'list', nodeCount(loadedExpecteds)); await snap('C2-mobile-list', 'list'); await view(page, 'graph', nodeCount(loadedExpecteds));
    await r5Proof({ page, observed, fixture, gate, deliver, record, evidenceDir });
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
