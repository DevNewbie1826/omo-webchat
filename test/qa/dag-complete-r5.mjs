import assert from 'node:assert/strict';
import { expectedRun, assertComplete } from './dag-complete-controls.mjs';
import { save, transcript } from './dag-complete-fixture.mjs';
import { r7Proof, taskHistoryFields } from './dag-complete-r7.mjs';
import { actionDOM, armDOM, doneDOM, statusIs, assertSurface, assertSubagents, capture, releaseComplete, resetScenarioViewport, waitForTranscript } from './dag-complete-browser.mjs';

const activityPath = '/api/workspaces/qa-dag/chats/qa-chat/activity';
export async function prepareF1Source(fixture) {
  const oldID = 'dense-64', id = '000-f1-dense-64';
  const source = structuredClone(await fixture.source(oldID));
  assert.equal(source.runId, oldID);
  assert.equal(fixture.manifest.files[id], undefined);
  assert.ok(fixture.manifest.files[oldID]);
  // A fresh shelf may bind before REST arrives. Its null choice then falls
  // back to the ID-sorted catalog, not the newest historical createdAt.
  // Make both real source orderings agree without changing either response.
  source.runId = id; source.runKey = id;
  source.createdAt = '2026-09-09T12:00:00Z'; source.updatedAt = source.createdAt;
  source.nodes[0].taskId = 't'.repeat(600) + '1';
  await fixture.replace(oldID, source);
  fixture.manifest.files[id] = fixture.manifest.files[oldID];
  delete fixture.manifest.files[oldID];
  fixture.manifest.runs = fixture.manifest.runs.map(run => run === oldID ? id : run).sort();
  assert.equal(fixture.manifest.runs[0], id);
  return source;
}

export function rawLoss(full, kind) {
  const run = { ...structuredClone(full), waves: [], truncated_nodes: false };
  assert.equal(run.nodes.length, 2);
  assert.equal(run.counts.running, 2);
  if (kind === 'malformed') delete run.nodes[1].depends_on;
  else if (kind === 'zero') for (const node of run.nodes) delete node.depends_on;
  else if (kind === 'run-local') {
    run.nodes = run.nodes.slice(0, 1); run.edges = [];
    run.counts = { ...run.counts, total: 1, running: 1 }; run.truncated_nodes = true;
  } else if (kind === 'duplicate-node') {
    run.nodes = [structuredClone(run.nodes[0]), structuredClone(run.nodes[0])]; run.edges = [];
  } else if (kind === 'duplicate-run') {
    return { parent_session_id: 'qa-chat', truncated_runs: false, runs: run.nodes.map(node => ({
      ...structuredClone(run), nodes: [{ ...structuredClone(node), depends_on: [] }], edges: [],
      counts: { ...run.counts, total: 1, running: 1 },
    })) };
  } else if (kind !== 'lost-run') throw new Error(`Unknown loss ${kind}`);
  return { parent_session_id: 'qa-chat', truncated_runs: false, runs: kind === 'lost-run' ? [null] : [run] };
}

export function taskTransition(full) {
  assert.equal(full.nodes.length, 64);
  assert.equal(full.nodes[0].id, 'node-00');
  assert.equal(Buffer.byteLength(full.nodes[0].task_id), 601);
  const lossyRun = { ...structuredClone(full), nodes: [{ ...structuredClone(full.nodes[0]),
    task_id: full.nodes[0].task_id.slice(0, 512), task_id_truncated: true }],
    edges: [], waves: [], truncated_nodes: true };
  assert.equal(Buffer.byteLength(lossyRun.nodes[0].task_id), 512);
  const exactRun = structuredClone(lossyRun);
  exactRun.updated_at = new Date(Date.parse(full.updated_at) - 1000).toISOString();
  exactRun.nodes[0].task_id = 'previous-attempt-task';
  delete exactRun.nodes[0].task_id_truncated;
  // The changed row label is a wire-supplied hydration sentinel, not a timer
  // or a private React-state probe. The node identity never changes.
  exactRun.nodes[0].label = `qa-exact-${full.updated_at}`;
  const envelope = run => ({ parent_session_id: 'qa-chat', truncated_runs: false, runs: [run] });
  return { exact: envelope(exactRun), lossy: envelope(lossyRun) };
}

/** A real native reconnect re-runs REST hydration on the SAME mounted state.
 * Do not reload/navigate here: that would erase the older exact identity and
 * turn the regression into the already-covered initial lossy hydration case. */
export async function rehydrateREST({ page, observed, fixture, raw, wire, beforeFulfill, task }) {
  const handler = async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200);
    const original = await response.json();
    assert.deepEqual(original.task?.tasks ?? [], []); assert.notEqual(original.task_oversized, true);
    await beforeFulfill();
    const body = { ...original, dag: raw, ...taskHistoryFields(task) };
    wire.push({ surface: 'REST', transition: true, original, delivered: body });
    await route.fulfill({ response, json: body });
  };
  await page.route(`**${activityPath}`, handler);
  const closed = observed.wait(row => row.kind === 'close', { label: 'r6 REST native close' });
  const bound = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.create' && row.frame.chatId === 'qa-chat', { label: 'r6 REST rebind' });
  const ready = observed.wait(row => row.direction === 'received' && row.frame?.type === 'ready' && row.frame.sessionId === 'qa-chat', { label: 'r6 REST ready' });
  const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final && row.frame.sessionId === 'qa-chat', { label: 'r6 REST transcript' });
  const activity = page.waitForResponse(response => new URL(response.url()).pathname === activityPath, { timeout: 15000 });
  const signals = Promise.all([closed, bound, ready, entries, activity]); signals.catch(() => {});
  try {
    fixture.transport.disconnect('qa-chat');
    const [old, attached, ack, history, response] = await signals;
    assert.notEqual(old.socketId, attached.socketId);
    assert.equal(attached.socketId, ack.socketId); assert.equal(ack.socketId, history.socketId);
    assert.ok(attached.sequence < ack.sequence && ack.sequence < history.sequence);
    assert.deepEqual(history.frame.entries.slice(0, 100), transcript());
    assert.ok(history.frame.entries.length > 100);
    const tail = await waitForTranscript(page, history.frame.entries);
    assert.equal(response.status(), 200); assert.deepEqual((await response.json()).dag, raw);
    if (task !== undefined) assert.deepEqual((await response.json()).task, task);
    assert.equal(observed.timeline.some(row => row.socketId === attached.socketId && row.direction === 'received' && row.frame?.name === 'omo.dag.updated'), false);
    return { oldSocket: old.socketId, socketId: attached.socketId, entries: history.frame.entries.length, tail };
  } finally { await page.unroute(`**${activityPath}`, handler); }
}

/** Appended to the original lead flow: no original action or screenshot is
 * replaced. Successful detail bodies always come from the owned Go server.
 * F3 and r6 transition activity inputs are injected before real REST/WS parsers. */
export async function r5Proof({ page, observed, fixture, gate, deliver, record, evidenceDir }) {
  const wire = [];
  const select = async id => {
    const held = gate.arm(id); await page.locator('[data-activity-dag-select]').selectOption(id);
    await held.captured; return held;
  };
  const agents = () => actionDOM(page, () => document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected') === 'true',
    () => page.locator('[data-activity-tab="agents"]').click());
  async function counts(options) {
    const count = options.partial ? options.retained ? `${options.retained}+` : '?' : '2/2';
    await doneDOM(page, await armDOM(page, count => document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.textContent === count, count));
    return assertSubagents(page, options);
  }
  async function fresh(viewport, raw, task, beforeFulfill = async () => {}) {
    await resetScenarioViewport(page, fixture.url, viewport);
    const handler = async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const original = await response.json();
      assert.deepEqual(original.task?.tasks ?? [], []);
      assert.notEqual(original.task_oversized, true);
      const body = { ...original, ...(raw === undefined ? {} : { dag: raw }), ...taskHistoryFields(task) };
      wire.push({ surface: 'REST', injected: raw !== undefined, original, delivered: body });
      await beforeFulfill();
      await route.fulfill({ response, json: body });
    };
    await page.route(`**${activityPath}`, handler);
    const binding = observed.wait(row => row.direction === 'sent' && row.frame?.type === 'chat.create' && row.frame.chatId === 'qa-chat', { label: 'r5 binding' });
    const ready = observed.wait(row => row.direction === 'received' && row.frame?.type === 'ready' && row.frame.sessionId === 'qa-chat', { label: 'r5 ready' });
    const entries = observed.wait(row => row.direction === 'received' && row.frame?.type === 'entries' && row.frame.final && row.frame.sessionId === 'qa-chat', { label: 'r5 transcript' });
    const activity = page.waitForResponse(response => new URL(response.url()).pathname === activityPath, { timeout: 15000 });
    const signals = Promise.all([binding, ready, entries, activity]); signals.catch(() => {});
    try {
      await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
      const [attached, ack, history, response] = await signals;
      assert.equal(attached.socketId, ack.socketId); assert.equal(ack.socketId, history.socketId);
      assert.ok(attached.sequence < ack.sequence && ack.sequence < history.sequence);
      assert.deepEqual(history.frame.entries.slice(0, 100), transcript());
      assert.ok(history.frame.entries.length > 100);
      const tail = await waitForTranscript(page, history.frame.entries);
      assert.equal(response.status(), 200); await agents();
      record('r5-fresh-binding-growing-transcript', { viewport, socketId: ack.socketId, entries: history.frame.entries.length, tail });
      const delivered = await response.json();
      if (task !== undefined) assert.deepEqual(delivered.task, task);
      return delivered;
    } finally { await page.unroute(`**${activityPath}`, handler); }
  }
  async function openFull(id, expected, automatic = false) {
    const first = gate.arm('*');
    const catalog = await armDOM(page, ({ id, total }) => {
      const options = [...(document.querySelector('[data-activity-dag-select]')?.options ?? [])];
      return options.length === total && options.some(option => option.value === id);
    }, { id, total: fixture.manifest.runs.length });
    await page.locator('[data-activity-tab="dag"]').click();
    const receipt = await first.captured;
    const initial = decodeURIComponent(receipt.path.split('/').at(-1));
    if (automatic) assert.equal(initial, id, 'actual projected default loads without picker rescue');
    await releaseComplete({ page, held: first, expected: await fixture.expected(initial) });
    await doneDOM(page, catalog);
    assert.deepEqual((await page.locator('[data-activity-dag-select] option').evaluateAll(nodes => nodes.map(node => node.value))).sort(), fixture.manifest.runs);
    if (initial !== id) await releaseComplete({ page, held: await select(id), expected });
    return assertSurface(page, expected, 'graph');
  }
  try {
    // F1 uses an unchanged actual activity response and actual complete HTTP.
    // Retarget only this owned checkpoint after all original action classes.
    const source = await prepareF1Source(fixture);
    const full = expectedRun(source), desktop = { width: 1280, height: 800 };
    const history = await fresh(desktop);
    assert.equal(history.dag.runs[0]?.run_id, source.runId, 'actual projection and catalog agree on the automatic default');
    const projectedRun = history.dag.runs.find(run => run.run_id === source.runId);
    assert.ok(projectedRun);
    const projected = projectedRun.nodes.find(node => node.id === full.nodes[0].id);
    assert.ok(projected); assert.equal(projected.id, 'node-00');
    assert.equal(Buffer.byteLength(projected.task_id), 512); assert.equal(projected.task_id_truncated, true);
    assert.equal(Buffer.byteLength(full.nodes[0].task_id), 601);
    assert.equal(projectedRun.updated_at, full.updated_at);
    // A matching row proves REST reducer hydration before opening the DAG.
    const marker = `(${projectedRun.name}) - ${projected.label ?? projected.prompt}`;
    await doneDOM(page, await armDOM(page, marker => [...document.querySelectorAll('.th-activity-agent-name')].some(node => node.textContent === marker), marker));
    await capture(page, evidenceDir, 'F1-actual-projection-full-task-601', await openFull(source.runId, full, true));
    record('F1-actual-REST-projection-full-601-byte-task-identity', { projected, full: full.nodes[0], revision: full.updated_at });

    // F2: erase only nonterminal overview membership, not the hook's accepted
    // full facts. a is then discovered/selected solely via the actual picker.
    await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: false, runs: [] } }, 'F2-empty-overview-before-historical-picker');
    const a = await fixture.source('history-002'), b = await fixture.source('history-003');
    a.updatedAt = '2026-09-09T13:00:00Z'; a.nodes[0].state = 'completed'; a.nodes[0].completedAt = a.updatedAt;
    await fixture.replace(a.runId, a);
    const accepted = await releaseComplete({ page, held: await select(a.runId), expected: expectedRun(a) });
    await releaseComplete({ page, held: await select(b.runId), expected: expectedRun(b) });
    const conflict = structuredClone(a); conflict.nodes[0].state = 'running'; delete conflict.nodes[0].completedAt;
    await fixture.replace(a.runId, conflict);
    const rejected = await select(a.runId), rejectedDocument = JSON.parse(rejected.receipt.body);
    assertComplete(rejectedDocument, expectedRun(conflict));
    assert.equal(rejectedDocument.run.updated_at, accepted.run.updated_at);
    assert.notEqual(rejectedDocument.content_token, accepted.content_token);
    const stale = await armDOM(page, statusIs, 'stale'); rejected.release(); await doneDOM(page, stale);
    assert.equal(await page.locator('[data-activity-dag-select]').inputValue(), a.runId);
    assert.equal(await page.locator('.th-activity-gnode').count(), 0);
    assert.equal(await page.locator('[data-activity-dag-total]').count(), 0);
    const staleObservation = { viewport: desktop, status: 'stale', graphNodes: 0, acceptedToken: accepted.content_token, rejectedToken: rejectedDocument.content_token };
    await capture(page, evidenceDir, 'F2-picker-equal-conflict', staleObservation);
    record('F2-picker-a-b-a-equal-conflict-rejected', staleObservation);
    // Unknown checkpoint property changes original bytes/token, not full facts.
    await fixture.replace(a.runId, { ...a, qaOpaqueTokenSalt: 'r5-equal-facts' });
    await releaseComplete({ page, held: await select(b.runId), expected: expectedRun(b) });
    const equal = await releaseComplete({ page, held: await select(a.runId), expected: expectedRun(a) });
    assert.notEqual(equal.content_token, accepted.content_token); assert.deepEqual(equal.run, accepted.run);
    await capture(page, evidenceDir, 'F2-picker-equal-facts-token', await assertSurface(page, expectedRun(a), 'graph'));
    record('F2-equal-facts-different-token-accepted', { old: accepted.content_token, token: equal.content_token });
    await releaseComplete({ page, held: await select(b.runId), expected: expectedRun(b) });
    conflict.updatedAt = '2026-09-09T13:01:00Z'; conflict.nodes[0].attempt++;
    await fixture.replace(a.runId, conflict);
    await releaseComplete({ page, held: await select(a.runId), expected: expectedRun(conflict) });
    const newerRetry = gate.arm(a.runId); await page.locator('[data-activity-dag-retry]').click();
    await releaseComplete({ page, held: newerRetry, expected: expectedRun(conflict) });
    await capture(page, evidenceDir, 'F2-picker-newer-retry', await assertSurface(page, expectedRun(conflict), 'graph'));
    record('F2-picker-a-b-a-strictly-newer-retry-accepted', { revision: conflict.updatedAt, attempt: conflict.nodes[0].attempt });

    // F3 raw wire, not pre-parsed ActivityState. Both REST and native WS paths
    // include node loss, no retained nodes, lost run, and local-only partial.
    let sequence = 0;
    for (const surface of ['REST', 'live']) for (const kind of ['malformed', 'zero', 'run-local', 'lost-run', 'duplicate-run', 'duplicate-node']) {
      for (const viewport of [desktop, { width: 390, height: 844 }]) {
        const pair = await fixture.source('long-identities'); pair.status = 'running';
        pair.updatedAt = new Date(Date.parse('2026-09-09T14:00:00Z') + sequence++ * 3000).toISOString();
        for (const node of pair.nodes) { node.state = 'running'; delete node.completedAt; }
        const complete = expectedRun(pair);
        const baseline = { parent_session_id: 'qa-chat', truncated_runs: false, runs: [{ ...complete, waves: [] }] };
        const input = rawLoss(complete, kind);
        if (surface === 'REST') await fresh(viewport, input);
        else {
          const older = structuredClone(baseline); older.runs[0].updated_at = new Date(Date.parse(pair.updatedAt) - 1000).toISOString();
          await fresh(viewport, older); await counts({ partial: false, retained: 2 });
          // Remove baseline membership before lost-run packets: otherwise an
          // honest lower bound of two would correctly survive unknown loss.
          await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: false, runs: [] } }, 'F3-live-clear-after-REST-hydration');
          await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: input }, `F3-live-${kind}-raw-wire`);
          wire.push({ surface, kind, delivered: input });
        }
        const retained = kind === 'malformed' || kind === 'run-local' ? 1 : 0;
        // duplicate-run/duplicate-node must show `?` after quarantine under the
        // committed F3-R6 contract; exact counts or inflated bounds fail.
        const label = `F3-${surface}-${kind}-${viewport.width}`;
        const partial = await counts({ partial: true, retained });
        await capture(page, evidenceDir, label, { ...partial, viewport });
        record(label, { ...partial, viewport, raw: input, screenshot: `${label}.png` });
        pair.updatedAt = new Date(Date.parse(pair.updatedAt) + 1000).toISOString();
        await fixture.replace(pair.runId, pair);
        const recovered = expectedRun(pair);
        await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: { parent_session_id: 'qa-chat', truncated_runs: false, runs: [{ ...recovered, waves: [] }] } }, `${label}-complete-recovery-wire`);
        const exact = await counts({ partial: false, retained: 2 });
        await capture(page, evidenceDir, `${label}-recovered`, { ...exact, viewport });
        await capture(page, evidenceDir, `${label}-full-graph`, await openFull(pair.runId, recovered));
        record(`${label}-complete-2-of-2-and-original-graph`, { ...exact, viewport, revision: pair.updatedAt });
      }
    }
    // Append after every r5 class, retaining the same full-response gates,
    // pixel/bounds captures and outer cleanup. No accepted full exists in a
    // fresh pane before these exact -> newer lossy -> full transitions.
    let transitionSequence = 0;
    for (const surface of ['REST', 'live']) for (const viewport of [desktop, { width: 390, height: 844 }]) {
      const next = await fixture.source(source.runId);
      next.updatedAt = new Date(Date.parse('2026-09-09T16:00:00Z') + transitionSequence++ * 3000).toISOString();
      await fixture.replace(next.runId, next);
      const complete = expectedRun(next), input = taskTransition(complete);
      const label = `F1-R6-${surface}-exact-lossy-full601-${viewport.width}`;
      const markerFor = run => `(${run.name}) - ${run.nodes[0].label ?? run.nodes[0].prompt}`;
      const exactMarker = markerFor(input.exact.runs[0]), lossyMarker = markerFor(input.lossy.runs[0]);
      assert.notEqual(exactMarker, lossyMarker);
      const rowIs = marker => [...document.querySelectorAll('[data-activity-tabpanel="agents"] .th-activity-agent-name')].some(node => node.textContent === marker);
      if (surface === 'REST') await fresh(viewport, input.exact);
      else {
        await fresh(viewport, { parent_session_id: 'qa-chat', truncated_runs: false, runs: [] });
        await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: input.exact }, `${label}-exact-wire`);
        wire.push({ surface, stage: 'exact', delivered: input.exact });
      }
      await doneDOM(page, await armDOM(page, rowIs, exactMarker));
      assert.equal(await page.locator('.th-activity-gnode').count(), 0);
      await capture(page, evidenceDir, `${label}-exact`, { viewport, stage: 'exact', raw: input.exact });
      record(`${label}-exact-accepted`, { viewport, raw: input.exact });
      const acceptedLossy = await armDOM(page, ({ exactMarker, lossyMarker }) => {
        const names = [...document.querySelectorAll('[data-activity-tabpanel="agents"] .th-activity-agent-name')].map(node => node.textContent);
        return names.includes(lossyMarker) && !names.includes(exactMarker);
      }, { exactMarker, lossyMarker });
      let reconnect;
      if (surface === 'REST') reconnect = await rehydrateREST({ page, observed, fixture, raw: input.lossy, wire,
        beforeFulfill: async () => assert.equal(await page.evaluate(rowIs, exactMarker), true, 'older exact row survives reconnect until newer REST is released') });
      else {
        await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: input.lossy }, `${label}-lossy-wire`);
        wire.push({ surface, stage: 'lossy', delivered: input.lossy });
      }
      await doneDOM(page, acceptedLossy);
      assert.equal(await page.locator('.th-activity-gnode').count(), 0);
      await capture(page, evidenceDir, `${label}-lossy`, { viewport, stage: 'lossy', raw: input.lossy, reconnect });
      record(`${label}-newer-lossy-accepted`, { viewport, raw: input.lossy, reconnect });
      const graph = await openFull(next.runId, complete, true);
      assert.equal(graph.total, 64);
      await capture(page, evidenceDir, `${label}-recovered`, graph);
      record(`${label}-complete-original-64`, { viewport, revision: complete.updated_at, taskBytes: Buffer.byteLength(complete.nodes[0].task_id), graph });
    }
    await r7Proof({ page, observed, fixture, deliver, record, evidenceDir, fresh, rehydrateREST, wire });
  } finally { await save(evidenceDir, 'qa-r5-raw-wire.json', wire); }
}
