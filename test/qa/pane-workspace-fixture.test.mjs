import { test, expect } from 'bun:test';
import { startFixture } from './pane-workspace-ui.mjs';

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
