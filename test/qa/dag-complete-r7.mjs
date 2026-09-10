import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { root, save } from './dag-complete-fixture.mjs';
import { armDOM, doneDOM, capture } from './dag-complete-browser.mjs';

/** Fail before allocating browser/server resources. The QA commit may descend
 * from the producer commit, but neither an uncommitted fix nor a stale tree is
 * final evidence. The lead supplies the round-specific PASS receipt. */
export async function requireR7Ready() {
  assert.ok(process.env.QA_F4R7_READY, 'QA_F4R7_READY must point to r7/f4r7-ready.json');
  const receipt = JSON.parse(await readFile(process.env.QA_F4R7_READY, 'utf8'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.workingTreeClean, true);
  const producer = receipt.committedHead;
  assert.equal(producer, '971956fd3f76e9f56b256aae68a10df2da8a1048');
  assert.equal(receipt.tree, 'fb9db7f0a3613b63bbb34fd9aa5b579ab0d64884');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'fix/dag-complete-20260908');
  assert.equal(git('status', '--porcelain'), '', 'final QA requires a clean committed tree');
  assert.equal(git('rev-parse', `${producer}^{tree}`), receipt.tree);
  git('merge-base', '--is-ancestor', '066b2fdd19630f9560d8e1b121e339e62174cb67', producer);
  git('merge-base', '--is-ancestor', producer, 'HEAD');
  return { producer, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

/** This mixed-source case uses the supported rich-only REST envelope, as in
 * the reviewer reproduction. Drop the owned fixture's unrelated empty compact
 * membership rather than letting it discard the injected authoritative task.
 * JSON serialization omits undefined; DAG-only responses are unchanged. */
export function taskHistoryFields(task) {
  return task === undefined ? {} : { task, task_digest: undefined };
}

export function mixedTaskCase({ taskState, truncated, sequence }) {
  assert.ok(['running', 'completed'].includes(taskState));
  assert.equal(typeof truncated, 'boolean');
  const taskID = 't'.repeat(600) + 'a';
  const revision = stage => new Date(Date.parse('2026-09-09T18:00:00Z') + sequence * 10000 + stage * 1000).toISOString();
  const task = { parent_session_id: 'qa-chat', truncated_tasks: false, tasks: [{ task_id: taskID,
    name: `qa-r7-task-${sequence}`, status: taskState, updated_at: revision(2) }] };
  const run = { run_id: `qa-r7-overlap-${sequence}`, run_key: `qa-r7-overlap-${sequence}`, name: `qa-r7-overlap-${sequence}`,
    status: 'running', updated_at: revision(0), truncated_nodes: false,
    counts: { total: 1, running: 1 }, edges: [], waves: [],
    nodes: [{ id: 'same-child', prompt: 'same child', state: 'running', depends_on: [], attempt: 1, task_id: taskID }] };
  // The exact agent aggregate rides both wire surfaces: the digest the REST
  // boundary carries and the envelope fields the live frames carry. One
  // authoritative task means an exact 1/1 or 0/1 at every stage.
  const running = taskState === 'running' ? 1 : 0;
  const aggregate = { agent_running_count: running, agent_total_count: 1 };
  // Digest rows are the REST membership authority, so the retained list must
  // mirror the rich payload's stage: an empty list with truncated:false would
  // contradict the one authoritative task and discard it at hydration.
  const digestFor = payload => ({ tasks: payload.tasks.map(row => ({ task_id: row.task_id, status: row.status, updated_at: row.updated_at })),
    truncated: false, running_count: running, total_count: 1, ...aggregate });
  const digest = digestFor(task);
  const envelope = value => ({ parent_session_id: 'qa-chat', truncated_runs: false, ...aggregate, runs: [value] });
  const lossy = structuredClone(run);
  lossy.updated_at = revision(1); lossy.truncated_nodes = truncated;
  lossy.nodes[0].task_id = taskID.slice(0, 512); lossy.nodes[0].task_id_truncated = true;
  const recovered = structuredClone(run); recovered.updated_at = revision(3);
  const baselineTask = structuredClone(task);
  baselineTask.tasks[0].name += '-baseline'; baselineTask.tasks[0].updated_at = revision(0);
  const liveTask = { ...structuredClone(task), ...aggregate };
  const liveBaselineTask = { ...structuredClone(baselineTask), ...aggregate };
  return { task, baselineTask, liveTask, liveBaselineTask, digest, digestFor, aggregate, exact: envelope(run), lossy: envelope(lossy), recovered: envelope(recovered),
    exactCount: taskState === 'running' ? '1/1' : '0/1',
    // The marker-free surface counts the authoritative row exactly at every
    // stage: the lossy child's truncated task identity can never add a second
    // row, and an exact count never degrades into a qualified lower bound.
    partialCount: taskState === 'running' ? '1/1' : '0/1' };
}

// The name is a wire sentinel for task hydration, not pinned product prose.
export function mixedStateIs({ count, name }) {
  const names = [...document.querySelectorAll('[data-activity-tabpanel="agents"] .th-activity-agent-name')].map(node => node.textContent);
  return document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.textContent === count
    && names.length === 1 && names[0] === name;
}

export async function assertMixedSubagents(page, { count, name, partial }) {
  assert.equal(await page.evaluate(mixedStateIs, { count, name }), true, 'one authoritative task, no duplicate DAG row');
  const actual = await page.evaluate(() => ({
    count: document.querySelector('[data-activity-tab="agents"] .th-activity-tab-count')?.textContent ?? null,
    selected: document.querySelector('[data-activity-tab="agents"]')?.getAttribute('aria-selected'),
    explanation: document.querySelector('[data-activity-tab="agents"]')?.getAttribute('title'),
    partial: document.querySelector('[data-activity-tabpanel="agents"] [class*="partial"]')?.textContent ?? null,
    rows: [...document.querySelectorAll('[data-activity-tabpanel="agents"] .th-activity-agent-name')].map(node => node.textContent),
  }));
  assert.equal(actual.selected, 'true');
  assert.equal(actual.count, count, 'exact marker-free mixed count');
  assert.equal(actual.rows.length, 1, 'one authoritative task row, never a duplicate DAG row');
  assert.equal(actual.partial, null, 'no partial-classed element on the mixed surface');
  assert.equal(actual.explanation, null, 'no partial qualification title on the mixed surface');
  if (actual.count !== null) assert.equal(/[+?]$/.test(actual.count), false, 'mixed count is exact, never a qualified lower bound');
  assert.equal(await page.locator('.th-activity-gnode').count(), 0, 'mixed count proof does not open or inject full detail');
  return actual;
}

/** Append only: all original/r5/r6 classes and their cleanup still run. Raw
 * task+DAG REST replacements remain at the activity boundary; live uses both
 * actual task and DAG websocket events. No parsed state or full HTTP is faked. */
export async function r7Proof({ page, observed, fixture, deliver, record, evidenceDir, fresh, rehydrateREST, wire }) {
  const receipts = [];
  let sequence = 0;
  try {
    for (const surface of ['REST', 'live']) for (const taskState of ['running', 'completed']) {
      for (const truncated of [false, true]) for (const transition of [false, true]) {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
          const input = mixedTaskCase({ taskState, truncated, sequence: sequence++ });
          const name = input.task.tasks[0].name;
          const label = `F4-R7-${surface}-${taskState}-${truncated ? 'partial' : 'metadata'}-${transition ? 'transition' : 'direct'}-${viewport.width}`;
          const exact = { name, count: input.exactCount, partial: false };
          const lossy = { name, count: input.partialCount, partial: true };
          let initialSignal;
          const initial = surface === 'live' ? { ...exact, name: input.baselineTask.tasks[0].name } : transition ? exact : lossy;
          const initialRaw = surface === 'live' ? { parent_session_id: 'qa-chat', truncated_runs: false, ...input.aggregate, runs: [] } : transition ? input.exact : input.lossy;
          const initialTask = surface === 'live' ? input.liveBaselineTask : input.task;
          await fresh(viewport, initialRaw, initialTask, async () => { initialSignal = await armDOM(page, mixedStateIs, initial); }, input.digestFor(initialTask));
          await doneDOM(page, initialSignal);
          await assertMixedSubagents(page, initial);
          async function send(raw, stage, expected) {
            const signal = await armDOM(page, mixedStateIs, expected);
            let reconnect;
            if (surface === 'REST') {
              const incumbent = stage === 'recovered' ? lossy : exact;
              reconnect = await rehydrateREST({ page, observed, fixture, raw, task: input.task, digest: input.digest, wire,
                beforeFulfill: () => assertMixedSubagents(page, incumbent) });
            } else {
              await deliver({ type: 'extensionEvent', name: 'omo.dag.updated', data: raw }, `${label}-${stage}-wire`);
              wire.push({ surface, stage, delivered: raw });
            }
            await doneDOM(page, signal);
            return reconnect;
          }
          async function snap(stage, expected, raw, reconnect) {
            const actual = await assertMixedSubagents(page, expected);
            const receipt = { surface, taskState, truncated, transition, viewport, stage, raw, task: input.task,
              ...actual, reconnect, screenshot: `${label}-${stage}.png` };
            await capture(page, evidenceDir, `${label}-${stage}`, receipt);
            receipts.push(receipt); record(`${label}-${stage}`, receipt);
          }
          if (surface === 'live') {
            const taskSignal = await armDOM(page, mixedStateIs, exact);
            await deliver({ type: 'extensionEvent', name: 'omo.task.updated', data: input.liveTask }, `${label}-authoritative-task-wire`);
            wire.push({ surface, stage: 'task', delivered: input.liveTask });
            await doneDOM(page, taskSignal);
            if (transition) await send(input.exact, 'exact', exact);
          }
          if (transition) await snap('exact', exact, input.exact);
          const reconnect = surface === 'live' || transition ? await send(input.lossy, 'lossy', lossy) : undefined;
          await snap('lossy', lossy, input.lossy, reconnect);
          const recovered = await send(input.recovered, 'recovered', exact);
          await snap('recovered', exact, input.recovered, recovered);
        }
      }
    }
    assert.equal(sequence, 32); assert.equal(receipts.length, 80);
  } finally { await save(evidenceDir, 'qa-r7-mixed-wire.json', receipts); }
}
