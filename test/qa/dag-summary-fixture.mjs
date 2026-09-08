/** Synthetic summary inputs around the existing native HTTP/WS built-SPA fixture.
 * No source-store, engine, auth service, or user daemon is accessed.
 */
import assert from 'node:assert/strict';
import { startTaskFixture, chat } from './task-state-fixture.mjs';
import { dagRow } from './dag-state-ordering.mjs';

export const stages = Object.freeze(['partial-retained1', 'incomplete-retained0', 'malformed-node', 'complete2']);
export const viewports = Object.freeze([{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
export function summaryInput(stage) {
  const index = stages.indexOf(stage); assert.ok(index >= 0, `Unknown summary stage: ${stage}`);
  const marker = `dag-summary-${stage}`, updatedAt = `2026-09-08T10:0${index + 1}:00.000Z`;
  const run = dagRow('running', '01');
  Object.assign(run, { run_id: 'summary-run', run_key: 'summary', name: 'Summary fixture', updated_at: updatedAt,
    counts: { ...run.counts, total: 2, running: 2 },
    nodes: ['a', 'b'].map((id, i) => ({ id, prompt: `Description ${id}`, state: 'running', depends_on: i ? ['a'] : [], attempt: 1 })),
    edges: [{ from: 'a', to: 'b' }], waves: [{ index: 0, node_ids: ['a'] }, { index: 1, node_ids: ['b'] }] });
  if (stage === 'partial-retained1') { run.nodes.length = 1; run.edges = []; run.waves.length = 1; }
  if (stage === 'incomplete-retained0') {
    run.nodes = []; run.edges = []; run.waves = []; run.counts.total = 0; run.counts.running = 0;
  }
  if (stage === 'malformed-node') delete run.nodes[1].depends_on;
  return { id: chat, title: 'Stored A', marker,
    task: { parent_session_id: chat, truncated_tasks: false,
      tasks: [{ task_id: 'summary-marker', name: 'QA marker', status: 'pending', updated_at: updatedAt,
        live_progress: { last_assistant_line: marker } }] },
    dag: { parent_session_id: chat, truncated_runs: index < 2, runs: [run] } };
}
export function summaryFrame(stage) {
  const input = summaryInput(stage);
  return { type: 'sessions.activity', sessionId: input.id, durableSessionId: input.id, overflow: false,
    snapshots: [{ name: 'omo.task.updated', data: input.task, oversized: false },
      { name: 'omo.dag.updated', data: input.dag, oversized: false }] };
}
export function startSummaryFixture(options = {}) {
  const entries = Array.from({ length: 160 }, (_, i) => ({ id: `ordering-entry-${i}`, parentId: i ? `ordering-entry-${i - 1}` : null,
    type: 'message', message: { role: i % 2 ? 'assistant' : 'user',
      content: `ordering-entry-${i}\n\n${'Synthetic saved transcript paragraph. '.repeat(30)}` } }));
  return startTaskFixture({ ...options, layout: 'single', runs: { [chat]: { entries } } });
}
