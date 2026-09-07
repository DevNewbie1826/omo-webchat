import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { startStatsFixture, models, usage } from './rpc46-stats-fixture.mjs';

function once(socket, event, action) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { socket.removeEventListener(event, listener); fail(new Error(`Native fixture ${event} deadline`)); }, 5000);
    const listener = value => { clearTimeout(timer); done(value); };
    socket.addEventListener(event, listener, { once: true }); action?.();
  });
}

test('held model and compaction controls change query results only after success', async () => {
  const fixture = await startStatsFixture({ port: 0 });
  let socket;
  try {
    socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws');
    await once(socket, 'open');
    const receive = (type, action) => {
      const result = fixture.wait(frame => frame.type === type, 'received'); action(); return result;
    };
    const send = frame => socket.send(JSON.stringify(frame));
    const query = () => receive('stats', () => send({ type: 'chat.stats', sessionId: 'stored-a' }));
    const entries = await receive('entries', () => {
      send({ type: 'hello', version: 2 }); send({ type: 'chat.create', wsId: 'ws', chatId: 'stored-a' });
    });
    assert.equal(entries.entries.length, 240);
    assert.deepEqual((await query()).contextUsage, usage(34).contextUsage);
    const submitModel = async requestId => {
      const held = fixture.wait(frame => frame.type === 'chat.set' && frame.requestId === requestId);
      send({ type: 'chat.set', sessionId: 'stored-a', requestId, model: models[1] }); await held;
    };
    await submitModel('reject-model');
    fixture.acknowledge('reject-model');
    assert.deepEqual((await query()).contextUsage, usage(34).contextUsage);
    fixture.resolveModel('reject-model', { success: false });
    assert.deepEqual((await query()).contextUsage, usage(34).contextUsage);
    assert.deepEqual(fixture.state('stored-a').model, models[0]);
    await submitModel('accept-model');
    const beforeSuccess = fixture.traffic.length;
    fixture.resolveModel('accept-model', { success: true });
    assert.deepEqual(fixture.traffic.slice(beforeSuccess).map(row => row.frame.type), ['control.result'], 'success itself never pushes stats');
    assert.deepEqual((await query()).contextUsage, usage(50).contextUsage);
    for (const success of [false, true]) {
      const held = fixture.wait(frame => frame.type === 'chat.compact');
      send({ type: 'chat.compact', sessionId: 'stored-a' }); await held;
      fixture.startCompact('stored-a');
      assert.deepEqual((await query()).contextUsage, usage(50).contextUsage);
      const beforeDone = fixture.traffic.length;
      fixture.resolveCompact('stored-a', { success });
      assert.deepEqual(fixture.traffic.slice(beforeDone).map(row => row.frame.type), ['compaction.done']);
      assert.deepEqual((await query()).contextUsage, usage(success ? 10 : 50).contextUsage);
    }
    fixture.deliver('stored-a', { type: 'stats', sessionId: 'newer', ...usage(99) });
    assert.equal(fixture.traffic.at(-1).frame.sessionId, 'newer', 'foreign envelope reaches chosen socket unchanged');
    assert.equal(fixture.traffic.some(row => row.frame.type === 'run.done'), false);
    assert.equal(fixture.state('stored-a').entries.length, 240);
    assert.deepEqual(fixture.unexpected, []);
    await once(socket, 'close', () => socket.close());
  } finally {
    if (socket && socket.readyState < WebSocket.CLOSING) await once(socket, 'close', () => socket.close());
    const cleanup = await fixture.stop();
    assert.equal(cleanup.publicServer.pendingWebSockets, 0);
    assert.equal(cleanup.http.pendingWebSockets, 0);
    console.log('RPC46 fixture cleanup', JSON.stringify(cleanup));
  }
}, 15000);
