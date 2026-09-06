import { test, expect } from 'bun:test';
import { startFixture } from './pane-workspace-ui.mjs';

function next(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`Missing ${type}`)); }, 2000);
    function receive(event) {
      const frame = JSON.parse(event.data);
      if (frame.type !== type) return;
      clearTimeout(timer); socket.removeEventListener('message', receive); resolve(frame);
    }
    socket.addEventListener('message', receive);
  });
}

test('opt-in files serve and persist editor content without changing empty defaults', async () => {
  const fixture = startFixture({ port: 0, files: { '/fixture/session.ts': 'original' } });
  try {
    const list = await fetch(`${fixture.url}/api/fs/list?path=%2Ffixture`).then(r => r.json());
    expect(list.entries.map(entry => entry.name)).toEqual(['session.ts']);
    const read = () => fetch(`${fixture.url}/api/fs/read?path=%2Ffixture%2Fsession.ts`).then(r => r.json());
    expect(await read()).toEqual({ content: 'original', size: 8 });
    const response = await fetch(`${fixture.url}/api/fs/write?path=%2Ffixture%2Fsession.ts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'edited' }) });
    expect(response.status).toBe(204);
    expect(await read()).toEqual({ content: 'edited', size: 6 });
    expect(fixture.fileContent('/fixture/session.ts')).toBe('edited');
    expect(fixture.unexpected).toEqual([]);
    fixture.reset();
    expect((await fetch(`${fixture.url}/api/fs/list?path=%2Ffixture`).then(r => r.json())).entries).toEqual([]);
  } finally { expect((await fixture.stop()).pendingWebSockets).toBe(0); }
});

test('queue move/remove/clear acknowledge exact commands and publish retained authoritative state', async () => {
  const items = ['a', 'b', 'c'].map((id, i) => ({ id, text: id, hasImage: false, createdAt: i }));
  const engine = { pendingMessageCount: 1, ordered: [{ text: 'later', mode: 'followUp' }] };
  const fixture = startFixture({ port: 0, runs: { 'stored-a': { queue: { revision: 1, items, engine } } } });
  const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws');
  try {
    await next(socket, 'hello');
    const initial = next(socket, 'queue');
    socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: 'stored-a' })); await initial;
    let revision = 1;
    async function command(frame, ids, pending) {
      const ack = next(socket, 'ack'), snapshot = next(socket, 'queue');
      socket.send(JSON.stringify({ sessionId: 'stored-a', requestId: 'exact', ...frame }));
      expect(await ack).toEqual({ type: 'ack', sessionId: 'stored-a', requestId: 'exact', command: frame.type });
      const queue = await snapshot;
      expect(queue.revision).toBe(++revision);
      expect(queue.items.map(item => item.id)).toEqual(ids);
      expect(queue.engine.pendingMessageCount).toBe(pending);
      expect(fixture.runState('stored-a').queue.items).toEqual(queue.items);
    }
    await command({ type: 'chat.queue.move', itemId: 'b', toIndex: 0 }, ['b', 'a', 'c'], 1);
    await command({ type: 'chat.queue.remove', itemId: 'a' }, ['b', 'c'], 1);
    await command({ type: 'chat.queue.clear', scope: 'all' }, [], 0);
    expect(fixture.runState('stored-a').queue.engine.ordered).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { socket.close(); expect((await fixture.stop()).pendingWebSockets).toBe(0); }
});
