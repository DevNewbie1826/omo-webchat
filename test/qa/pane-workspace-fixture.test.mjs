import { test, expect } from 'bun:test';
import { startFixture } from './pane-workspace-ui.mjs';
import { parseCompleteDag, parseDagCatalog } from '../../frontend/src/features/split/activityCompleteParse.ts';

test('fixture serves complete DAG runs for a known chat and resets them', async () => {
  const fixture = startFixture({ port: 0, shelves: true });
  const base = `${fixture.url}/api/workspaces/ws/chats/stored-a/dag-runs`;
  const run = {
    run_id: 'qa-run', run_key: 'qa', name: 'QA DAG', status: 'running',
    created_at: '2026-09-26T09:00:00.000Z', updated_at: '2026-09-26T09:01:00.000Z',
    counts: { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
    nodes: [
      { id: 'a', prompt: 'Start', state: 'completed', depends_on: [], attempt: 1 },
      { id: 'b', prompt: 'Finish', state: 'running', depends_on: ['a'], attempt: 1 },
    ],
    edges: [{ from: 'a', to: 'b' }],
    waves: [{ index: 0, node_ids: ['a'] }, { index: 1, node_ids: ['b'] }],
  };
  try {
    // Given a complete run published by the shared fixture for the chat.
    fixture.setDagRuns('stored-a', [run]);
    // When the app asks for its newest catalog page and selected document.
    const catalogResponse = await fetch(`${base}?limit=10`);
    const catalog = parseDagCatalog(await catalogResponse.json());
    const documentResponse = await fetch(`${base}/qa-run`);
    const document = parseCompleteDag(await documentResponse.json());
    // Then both real parsers accept matching identities, counts and topology.
    expect(catalogResponse.status).toBe(200);
    expect(catalog?.runs.map(entry => entry.runId)).toEqual(['qa-run']);
    expect(documentResponse.status).toBe(200);
    expect(document?.run.counts).toEqual(run.counts);
    expect(document?.run.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect(document?.contentToken).toBe(catalog?.runs[0].contentToken);
    expect((await fetch(`${base}/missing`)).status).toBe(404);
    expect((await fetch(`${fixture.url}/api/workspaces/ws/chats/missing/dag-runs?limit=10`)).status).toBe(404);
    fixture.reset({ shelves: true });
    expect(parseDagCatalog(await (await fetch(`${base}?limit=10`)).json())?.runs).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    expect((await fixture.stop()).pendingWebSockets).toBe(0);
  }
});

// Given per-session provider history plus authoritative queue/stats snapshots,
// attachment must emit exactly those values, without shelves replacing history.
test('design seeds retain history identity and latest queue across attachment', async () => {
  const entries = [{ id: 'history', type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'pwd' } },
  ] } }];
  const queue = { revision: 1, items: [{ id: 'queued', text: 'next', hasImage: false, createdAt: 1 }],
    engine: { pendingMessageCount: 0, ordered: [] } };
  const stats = { cost: .25, contextUsage: { percent: 42 } };
  const fixture = startFixture({ port: 0, shelves: true, runs: { 'stored-a': { entries, queue, stats } } });
  const sockets = [];
  async function attach() {
    const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws'); sockets.push(socket);
    await nextFrame(socket, frame => frame.type === 'hello');
    const history = nextFrame(socket, frame => frame.type === 'entries');
    const snapshot = nextFrame(socket, frame => frame.type === 'queue');
    socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: 'stored-a' }));
    return { socket, history: await history, queue: await snapshot };
  }
  try {
    // When a seeded session attaches and then receives a changed queue snapshot.
    const first = await attach();
    expect(first.history.entries).toEqual(entries);
    expect(first.queue).toEqual({ type: 'queue', sessionId: 'stored-a', ...queue });
    const measured = nextFrame(first.socket, frame => frame.type === 'stats');
    first.socket.send(JSON.stringify({ type: 'chat.stats', sessionId: 'stored-a' }));
    expect(await measured).toEqual({ type: 'stats', sessionId: 'stored-a', ...stats });
    const updated = { ...queue, revision: 2, items: [] };
    const received = nextFrame(first.socket, frame => frame.type === 'queue');
    fixture.deliver('stored-a', { type: 'queue', ...updated }); await received;
    first.socket.close();
    // Then reattachment retains original history and the latest authoritative queue.
    const second = await attach();
    expect(second.history.entries).toEqual(entries);
    expect(second.queue).toEqual({ type: 'queue', sessionId: 'stored-a', ...updated });
    entries.length = 0; queue.items.length = 0;
    expect(fixture.runState('stored-a').entries).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    for (const socket of sockets) socket.close();
    const cleanup = await fixture.stop();
    expect(cleanup.pendingWebSockets).toBe(0);
  }
});

function nextFrame(socket, predicate) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); fail(new Error('Fixture frame deadline')); }, 2000);
    function receive(event) {
      const frame = JSON.parse(String(event.data));
      if (predicate(frame)) { clearTimeout(timer); socket.removeEventListener('message', receive); done(frame); }
    }
    socket.addEventListener('message', receive);
  });
}

test('fixture run survives subscriber detach and reattachment until explicit Stop', async () => {
  // Given a real isolated HTTP/WS fixture whose provider run outlives its clients.
  const fixture = startFixture({ port: 0, running: ['stored-a'] });
  const sockets = [];
  async function attach() {
    const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws'); sockets.push(socket);
    await nextFrame(socket, f => f.type === 'hello');
    const state = nextFrame(socket, f => f.type === 'state');
    socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: 'stored-a' }));
    expect((await state).isStreaming).toBe(true);
    return socket;
  }
  try {
    // When its mounted client goes away and a different pane reattaches.
    const first = await attach(); first.close();
    const second = await attach();
    const delta = nextFrame(second, f => f.type === 'messageDelta');
    fixture.deliver('stored-a', { type: 'messageDelta', delta: { kind: 'text_delta', delta: 'continued' } });
    // Then later events and the active run remain intact, until that session is stopped.
    expect((await delta).delta.delta).toBe('continued');
    expect(fixture.runState('stored-a').running).toBe(true);
    const done = nextFrame(second, f => f.type === 'run.done');
    second.send(JSON.stringify({ type: 'chat.abort', sessionId: 'stored-a' }));
    expect((await done).sessionId).toBe('stored-a');
    expect(fixture.runState('stored-a').running).toBe(false);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    for (const socket of sockets) socket.close();
    await fixture.stop();
  }
});
