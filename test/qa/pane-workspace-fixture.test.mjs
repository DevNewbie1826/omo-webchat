import { test, expect } from 'bun:test';
import { startFixture } from './pane-workspace-ui.mjs';

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
