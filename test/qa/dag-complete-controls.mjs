import assert from 'node:assert/strict';
import { resolve } from 'node:path';
export const deadline = 15_000;
export const longRunIDs = ['0', '1'].map(suffix => 'a'.repeat(600) + suffix);
export const catalogPath = '/api/workspaces/qa-dag/chats/qa-chat/dag-runs';
export const detailPath = id => `${catalogPath}/${encodeURIComponent(id)}`;

export function parseArgs(args) {
  assert.equal(args.length, 2, 'one --evidence-dir argument is required');
  assert.equal(args[0], '--evidence-dir');
  assert.ok(args[1] && !args[1].startsWith('--'));
  return { evidenceDir: resolve(args[1]) };
}

export function bounded(promise, label, milliseconds = deadline) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

/** This gate never invents successful DAG documents. Each held body is read
 * from one actual Go HTTP response BEFORE the release signal is published. */
export function createResponseGate(upstream, receipts = []) {
  const barriers = [], pending = new Set(); let stopped = false;
  function arm(id) {
    assert.equal(stopped, false);
    let captured, failed, deliver;
    const signal = new Promise((resolve, reject) => { captured = resolve; failed = reject; });
    const released = new Promise(resolve => { deliver = resolve; });
    const barrier = { id, state: 'armed', receipt: null, captured: bounded(signal, `DAG ${id} capture`),
      release() { assert.equal(barrier.state, 'held'); barrier.state = 'released'; deliver(false); pending.delete(barrier); },
      capturedResponse(row) { barrier.receipt = row; barrier.state = 'held'; captured(row); },
      fail(error) { barrier.state = 'failed'; failed(error); pending.delete(barrier); },
      cancel() { barrier.state = 'stopped'; failed(new Error('DAG gate stopped')); deliver(true); pending.delete(barrier); },
      released };
    barrier.captured.catch(() => {}); barriers.push(barrier); pending.add(barrier); return barrier;
  }
  async function handle(request) {
    assert.equal(stopped, false);
    const path = new URL(request.url).pathname;
    const barrier = barriers.find(item => item.state === 'armed' && (path === detailPath(item.id)
      || (item.id === '*' && path.startsWith(catalogPath + '/'))));
    if (barrier) barrier.state = 'fetching';
    try {
      const response = await upstream(request);
      const body = await response.text();
      const row = { sequence: receipts.length + 1, method: request.method, path, status: response.status,
        headers: Object.fromEntries(response.headers), body };
      receipts.push(row);
      if (barrier) {
        if (stopped) return new Response('fixture stopped', { status: 503 });
        barrier.capturedResponse(row);
        if (await barrier.released) return new Response('fixture stopped', { status: 503 });
      }
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) { if (barrier) barrier.fail(error); throw error; }
  }
  async function stop() { stopped = true; for (const item of [...pending]) item.cancel(); return { pending: pending.size, states: barriers.map(({ id, state }) => ({ id, state })) }; }
  return { arm, handle, stop, receipts };
}

export function expectedRun(source) {
  const counts = { total: source.nodes.length, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  const nodes = source.definition.nodes.map(definition => {
    const runtime = source.nodes.find(node => node.id === definition.id);
    assert.ok(runtime); counts[runtime.state]++;
    const node = { id: definition.id, label: definition.label, prompt: definition.prompt, depends_on: definition.dependsOn,
      state: runtime.state, attempt: runtime.attempt, task_id: runtime.taskId, started_at: runtime.startedAt };
    if (runtime.completedAt) node.completed_at = runtime.completedAt;
    return node;
  });
  return { run_id: source.runId, run_key: source.runKey, name: source.name, status: source.status,
    created_at: source.createdAt, updated_at: source.updatedAt, counts, nodes,
    edges: nodes.flatMap(node => node.depends_on.map(from => ({ from, to: node.id }))) };
}

export function assertComplete(document, expected) {
  assert.equal(document.complete, true);
  assert.match(document.content_token, /^[a-f0-9]{64}$/);
  const actual = document.run;
  for (const key of ['run_id', 'run_key', 'name', 'status', 'created_at', 'updated_at']) {
    if (key in expected) assert.equal(actual[key], expected[key], key);
  }
  assert.equal(actual.counts.total, expected.counts.total);
  for (const [key, value] of Object.entries(expected.counts)) {
    assert.equal(actual.counts[key], value, `count ${key}`);
  }
  assert.equal(actual.nodes.length, expected.nodes.length);
  const ids = actual.nodes.map(node => node.id); assert.equal(new Set(ids).size, ids.length);
  for (const node of expected.nodes) {
    const found = actual.nodes.find(candidate => candidate.id === node.id); assert.ok(found, node.id);
    for (const [key, value] of Object.entries(node)) assert.deepEqual(found[key], value, `${node.id}.${key}`);
  }
  const edges = values => values.map(edge => JSON.stringify([edge.from, edge.to])).sort();
  assert.deepEqual(edges(actual.edges), edges(expected.edges));
}
