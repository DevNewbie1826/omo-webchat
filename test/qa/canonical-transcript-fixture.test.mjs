import { test, expect } from 'bun:test';
import { startFixture } from './pane-workspace-ui.mjs';

function nextFrame(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('WS frame deadline')); }, 2000);
    function receive(event) {
      const frame = JSON.parse(String(event.data));
      if (predicate(frame)) { clearTimeout(timer); socket.removeEventListener('message', receive); resolve(frame); }
    }
    socket.addEventListener('message', receive);
  });
}
async function withFixture(options, action) {
  const fixture = startFixture({ port: 0, layout: 'single', ...options }), sockets = [];
  async function attach(id = 'stored-a') {
    const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws'); sockets.push(socket);
    const received = [];
    socket.addEventListener('message', event => received.push(JSON.parse(String(event.data))));
    await nextFrame(socket, frame => frame.type === 'hello');
    const entries = nextFrame(socket, frame => frame.type === 'entries' && frame.final);
    socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: id }));
    await entries;
    return { socket, received };
  }
  try { await action(fixture, attach); }
  finally { for (const socket of sockets) socket.close(); await fixture.stop(); }
}
const send = (socket, requestId = 'request-original', id = 'stored-a') => socket.send(JSON.stringify({
  type: 'chat.send', sessionId: id, requestId, run: { kind: 'prompt', message: '/wish original' },
}));

test('controlled send captures original without automatic admission, run or canonical history', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket, received } = await attach();
    const captured = fixture.wait('frame', frame => frame.type === 'chat.send');
    send(socket);
    expect((await captured).run.message).toBe('/wish original');
    expect(fixture.runState('stored-a').running).toBe(false);
    expect(fixture.runState('stored-a').entries).toEqual([]);
    const fence = nextFrame(socket, frame => frame.type === 'stats');
    socket.send(JSON.stringify({ type: 'chat.stats', sessionId: 'stored-a' })); await fence;
    expect(received.filter(frame => ['ack', 'run.started', 'message'].includes(frame.type))).toEqual([]);
  });
});

test('controlled explicit canonical message persists independently of the original request', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket } = await attach();
    const message = nextFrame(socket, frame => frame.type === 'message');
    fixture.deliver('stored-a', { type: 'message', message: { role: 'user', content: 'expanded canonical' } });
    await message;
    expect(fixture.runState('stored-a').entries.map(entry => entry.message.content)).toEqual(['expanded canonical']);
    const replay = await attach();
    expect(replay.received.find(frame => frame.type === 'entries').entries.map(entry => entry.message.content)).toEqual(['expanded canonical']);
  });
});

test('controlled terminal outcomes replay before the attach history boundary without a new send', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket } = await attach();
    const ack = { type: 'ack', requestId: 'done-original', command: 'chat.send', phase: 'completed' };
    const delivered = nextFrame(socket, frame => frame.requestId === ack.requestId);
    fixture.deliver('stored-a', ack); await delivered;
    const replay = await attach();
    expect(replay.received.filter(frame => frame.type === 'ack')).toEqual([{ sessionId: 'stored-a', ...ack }]);
    expect(fixture.frames.filter(frame => frame.type === 'chat.send')).toEqual([]);
  });
});

test('default fixture retains immediate admission/run and does not persist delivered user messages', async () => {
  await withFixture({}, async (fixture, attach) => {
    const { socket, received } = await attach();
    const started = nextFrame(socket, frame => frame.type === 'run.started'); send(socket); await started;
    expect(received.find(frame => frame.type === 'ack')).toMatchObject({ requestId: 'request-original', command: 'chat.send' });
    expect(received.find(frame => frame.type === 'ack').phase).toBeUndefined();
    const canonical = nextFrame(socket, frame => frame.type === 'message');
    fixture.deliver('stored-a', { type: 'message', message: { role: 'user', content: 'default ephemeral' } }); await canonical;
    expect(fixture.runState('stored-a').entries).toEqual([]);
    expect(fixture.runState('stored-a').running).toBe(true);
  });
});

async function delivered(fixture, socket, frame, id = 'stored-a') {
  const observed = nextFrame(socket, value => value.type === frame.type && value.sessionId === id
    && (!frame.requestId || value.requestId === frame.requestId));
  fixture.deliver(id, frame); return observed;
}

test('admission, completion, failure and run terminal remain independent; repeated commits retain distinct IDs', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket } = await attach();
    await delivered(fixture, socket, { type: 'ack', command: 'chat.send', requestId: 'a', phase: 'admitted' });
    expect(fixture.runState('stored-a').outcomes).toEqual([]);
    await delivered(fixture, socket, { type: 'run.started' });
    await delivered(fixture, socket, { type: 'ack', command: 'chat.send', requestId: 'a', phase: 'completed' });
    expect(fixture.runState('stored-a').running).toBe(true);
    for (const unused of [1, 2]) await delivered(fixture, socket, { type: 'message', message: { role: 'user', content: 'same' } });
    await delivered(fixture, socket, { type: 'error', command: 'chat.send', requestId: 'b', message: 'controlled failure' });
    expect(fixture.runState('stored-a').running).toBe(true);
    await delivered(fixture, socket, { type: 'run.done', reason: 'stop' });
    const state = fixture.runState('stored-a');
    expect(state.entries.map(entry => entry.message.content)).toEqual(['same', 'same']);
    expect(new Set(state.entries.map(entry => entry.id)).size).toBe(2);
    expect(state.entries[1].parentId).toBe(state.entries[0].id);
    expect(state.outcomes.map(outcome => outcome.requestId)).toEqual(['a', 'b']);
    expect(state.running).toBe(false);
    const replay = await attach();
    expect(replay.received.filter(frame => ['ack', 'error'].includes(frame.type)).map(frame => frame.requestId)).toEqual(['a', 'b']);
  });
});

test('held stale history pages release only to their subscriber and never commit as live messages', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket } = await attach();
    await delivered(fixture, socket, { type: 'message', message: { role: 'user', content: 'old' } });
    fixture.holdHistory('stored-a');
    const held = fixture.wait('history-held', value => value.sessionId === 'stored-a');
    socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: 'stored-a' }));
    const snapshot = await held;
    await delivered(fixture, socket, { type: 'message', message: { role: 'user', content: 'new live suffix' } });
    const first = nextFrame(socket, frame => frame.type === 'entries' && !frame.final);
    fixture.releaseHistory(snapshot.token, { entries: snapshot.entries, final: false });
    expect((await first).entries.map(entry => entry.message.content)).toEqual(['old']);
    const final = nextFrame(socket, frame => frame.type === 'entries' && frame.final);
    const released = fixture.wait('history-released', value => value.token === snapshot.token && value.frame.final);
    fixture.releaseHistory(snapshot.token, { entries: [], final: true }); await final; await released;
    expect(fixture.runState('stored-a').entries.map(entry => entry.message.content)).toEqual(['old', 'new live suffix']);
    expect(() => fixture.releaseHistory(snapshot.token)).toThrow('completed history');
    expect(fixture.traffic.filter(event => event.kind === 'commit')).toHaveLength(2);
  });
});

test('queue snapshots and controls are per session, replay without resending, and never add canonical rows', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const a = await attach(), b = await attach('newer');
    const items = ['q1', 'q2'].map((id, i) => ({ id, text: 'same queued', hasImage: false, createdAt: i + 1, requestId: 'req-' + id }));
    await delivered(fixture, a.socket, { type: 'queue', revision: 1, items, engine: { pendingMessageCount: 0, ordered: [] } });
    const moved = nextFrame(a.socket, frame => frame.type === 'queue' && frame.revision === 2);
    a.socket.send(JSON.stringify({ type: 'chat.queue.move', sessionId: 'stored-a', itemId: 'q2', toIndex: 0 }));
    expect((await moved).items.map(item => item.id)).toEqual(['q2', 'q1']);
    const replay = await attach();
    expect(replay.received.find(frame => frame.type === 'queue').items.map(item => item.requestId)).toEqual(['req-q2', 'req-q1']);
    const removed = nextFrame(a.socket, frame => frame.type === 'queue' && frame.revision === 3);
    a.socket.send(JSON.stringify({ type: 'chat.queue.remove', sessionId: 'stored-a', itemId: 'q1' })); await removed;
    const cleared = nextFrame(a.socket, frame => frame.type === 'queue' && frame.revision === 4);
    a.socket.send(JSON.stringify({ type: 'chat.queue.clear', sessionId: 'stored-a', scope: 'all' }));
    expect((await cleared).items).toEqual([]);
    expect(fixture.runState('newer').queue.revision).toBe(0);
    const fence = nextFrame(b.socket, frame => frame.type === 'stats');
    b.socket.send(JSON.stringify({ type: 'chat.stats', sessionId: 'newer' })); await fence;
    expect(b.received.filter(frame => frame.sessionId === 'stored-a')).toEqual([]);
    expect(fixture.runState('stored-a').entries).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});

test('disconnect signals ownership and retained outcomes remain available on a new subscription', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket } = await attach();
    await delivered(fixture, socket, { type: 'ack', command: 'chat.send', requestId: 'settled', phase: 'completed' });
    const closed = fixture.wait('subscription', value => value.action === 'close' && value.sessionId === 'stored-a');
    fixture.disconnect('stored-a'); await closed;
    expect(fixture.subscribers('stored-a')).toBe(0);
    const subscribed = fixture.wait('subscription', value => value.action === 'attach' && value.sessionId === 'stored-a');
    const replay = await attach(); await subscribed;
    expect(replay.received.find(frame => frame.requestId === 'settled').phase).toBe('completed');
    expect(fixture.frames.filter(frame => frame.type === 'chat.send')).toEqual([]);
  });
});

test('retention is bounded to 64 terminal IDs and duplicate terminal replay does not replace the first outcome', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    for (let i = 0; i < 65; i++) fixture.deliver('stored-a', { type: 'ack', command: 'chat.send', requestId: 'r' + i, phase: 'completed' });
    fixture.deliver('stored-a', { type: 'error', command: 'chat.send', requestId: 'r64', message: 'contradictory replay' });
    const replay = await attach();
    const outcomes = replay.received.filter(frame => frame.type === 'ack' || frame.type === 'error');
    expect(outcomes).toHaveLength(64);
    expect(outcomes[0].requestId).toBe('r1');
    expect(outcomes.at(-1)).toMatchObject({ type: 'ack', requestId: 'r64', phase: 'completed' });
  });
});

test('owned fixture shutdown closes sockets, emits a receipt and releases its actual port', async () => {
  const fixture = startFixture({ controlled: true, port: 0 });
  const port = Number(new URL(fixture.url).port), stopped = fixture.wait('shutdown');
  const receipt = await fixture.stop(); await stopped;
  expect(receipt).toMatchObject({ serverStopped: true, pendingWebSockets: 0, pendingOpens: 0, pendingCreates: 0, port });
  const replacement = startFixture({ controlled: true, port });
  await replacement.stop();
});

test('controlled heartbeat receives pong before the next response without starting a run', async () => {
  await withFixture({ controlled: true }, async (fixture, attach) => {
    const { socket, received } = await attach();
    const fence = nextFrame(socket, frame => frame.type === 'stats');
    socket.send(JSON.stringify({ type: 'ping' }));
    socket.send(JSON.stringify({ type: 'chat.stats', sessionId: 'stored-a' })); await fence;
    expect(received.some(frame => frame.type === 'pong')).toBe(true);
    expect(fixture.runState('stored-a').running).toBe(false);
    expect(fixture.unexpected).toEqual([]);
  });
});

test.each([false, true])('integrated touch/model/reset preserves canonical and replay mode (controlled=%s)', async controlled => {
  await withFixture({ controlled, now: () => 100 }, async (fixture, attach) => {
    // Real HTTP requests and WS frames share this one fixture, not separate mocks.
    const { socket, received } = await attach();
    const captured = fixture.wait('frame', frame => frame.type === 'chat.send');
    const fence = nextFrame(socket, frame => frame.type === 'stats');
    send(socket, 'integrated-request');
    socket.send(JSON.stringify({ type: 'chat.stats', sessionId: 'stored-a' }));
    await captured; await fence;
    expect(received.filter(frame => frame.type === 'ack')).toHaveLength(controlled ? 0 : 1);
    expect(fixture.runState('stored-a').running).toBe(!controlled);
    expect(fixture.runState('stored-a').entries).toEqual([]);

    async function request(path, init = {}) {
      const observed = fixture.wait('request', value => value.path === path && value.method === (init.method ?? 'GET'));
      const [response] = await Promise.all([
        fetch(fixture.url + path, { ...init, signal: AbortSignal.timeout(2000) }), observed,
      ]);
      return response;
    }
    async function sessions() {
      const response = await request('/api/workspaces/ws/sessions');
      expect(response.status).toBe(200);
      return response.json();
    }
    const initial = await sessions();
    expect(initial.items.map(item => [item.id, item.recencyMs])).toEqual([
      ['discovered-b', 50], ['stored-a', 40], ['newer', 39], ['union', 20],
    ]);
    // JSON first gives the old task parent a meaningful missing-route RED, not a parse error.
    for (const [id, init] of [
      ['newer', { headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['stored-a', {}], ['union', {}],
    ]) {
      const response = await request(`/api/workspaces/ws/chats/${id}/touch`, { method: 'POST', ...init });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ recencyMs: 100 });
    }
    expect((await sessions()).items.map(item => [item.id, item.recencyMs])).toEqual([
      ['newer', 100], ['stored-a', 100], ['union', 100], ['discovered-b', 50],
    ]);
    const missing = await request('/api/workspaces/ws/chats/missing/touch', { method: 'POST' });
    expect(missing.status).toBe(404);
    const page = await request('/api/workspaces/ws/sessions?cursor=page2');
    expect(await page.json()).toEqual({ items: [{ id: 'discovered-c', name: 'Discovered C', source: 'discovered', recencyMs: 10 }], nextCursor: '' });

    const model = { provider: 'provider-c', modelId: 'model-b' };
    for (const [requestId, change, command] of [
      ['integrated-model', { model }, 'set_model'],
      ['integrated-thinking', { thinkingLevel: 'high' }, 'set_thinking_level'],
    ]) {
      const ack = nextFrame(socket, frame => frame.type === 'ack' && frame.requestId === requestId);
      const result = nextFrame(socket, frame => frame.type === 'control.result' && frame.requestId === requestId);
      socket.send(JSON.stringify({ type: 'chat.set', sessionId: 'stored-a', requestId, ...change }));
      expect(await ack).toMatchObject({ command });
      expect(await result).toMatchObject({ command, success: true });
    }
    await delivered(fixture, socket, { type: 'message', message: { role: 'user', content: 'integrated canonical' } });
    const canonical = fixture.runState('stored-a').entries;
    expect(canonical.map(entry => entry.message.content)).toEqual(controlled ? ['integrated canonical'] : []);
    let staleHistory, staleReplay;
    if (controlled) {
      await delivered(fixture, socket, { type: 'run.started' });
      await delivered(fixture, socket, { type: 'ack', command: 'chat.send', requestId: 'integrated-request', phase: 'completed' });
      await delivered(fixture, socket, { type: 'queue', revision: 1,
        items: [{ id: 'q1', requestId: 'queued-request', text: 'queued original' }],
        engine: { pendingMessageCount: 0, ordered: [] } });
      fixture.holdHistory('stored-a'); fixture.holdReplay('stored-a');
      async function holdAttach() {
        const history = fixture.wait('history-held', event => event.sessionId === 'stored-a');
        const replay = fixture.wait('replay-held', event => event.sessionId === 'stored-a');
        socket.send(JSON.stringify({ type: 'chat.create', wsId: 'ws', chatId: 'stored-a' }));
        return Promise.all([history, replay]);
      }
      const [history, replay] = await holdAttach();
      expect(history.entries).toEqual(canonical);
      expect(replay.state).toMatchObject({ model, thinkingLevel: 'high', isStreaming: true });
      expect(replay.outcomes.map(frame => frame.requestId)).toEqual(['integrated-request']);
      const start = received.length;
      const state = nextFrame(socket, frame => frame.type === 'state');
      fixture.releaseReplay(replay.token, { stateFirst: false }); await state;
      const entries = nextFrame(socket, frame => frame.type === 'entries' && frame.final);
      fixture.releaseHistory(history.token);
      expect((await entries).entries).toEqual(canonical);
      expect(received.slice(start).filter(frame => ['ack', 'state', 'entries'].includes(frame.type)).map(frame => frame.type)).toEqual(['ack', 'state', 'entries']);
      [staleHistory, staleReplay] = await holdAttach();
      expect(fixture.traffic.filter(event => event.kind === 'commit')).toHaveLength(1);
    } else {
      const replay = await attach();
      expect(replay.received.find(frame => frame.type === 'state')).toMatchObject({ model, thinkingLevel: 'high', isStreaming: true });
      expect(replay.received.find(frame => frame.type === 'entries').entries).toEqual([]);
    }
    expect((await sessions()).items[0].recencyMs).toBe(100);

    fixture.reset({ layout: 'single' });
    expect(await sessions()).toEqual(initial);
    expect(fixture.runState('stored-a')).toMatchObject({ running: false, entries: [],
      model: { provider: 'provider-a', modelId: 'model-a' }, thinkingLevel: 'low' });
    if (controlled) {
      expect(() => fixture.releaseHistory(staleHistory.token)).toThrow('Unknown or completed history');
      expect(() => fixture.releaseReplay(staleReplay.token)).toThrow('Unknown or completed replay');
      expect(fixture.runState('stored-a')).toMatchObject({ outcomes: [],
        queue: { revision: 0, items: [], engine: { pendingMessageCount: 0, ordered: [] } } });
    }
    // Final entries fence proves neither old history nor replay holds survive reset.
    const reset = await attach();
    expect(reset.received.find(frame => frame.type === 'state')).toMatchObject({ isStreaming: false, thinkingLevel: 'low' });
    expect(reset.received.find(frame => frame.type === 'entries').entries).toEqual([]);
    expect(reset.received.filter(frame => frame.type === 'ack')).toEqual([]);
    if (controlled) {
      fixture.reset({ holdReplay: ['stored-a'], running: ['stored-a'] });
      const held = fixture.wait('replay-held', event => event.sessionId === 'stored-a');
      const seeded = await attach();
      expect(seeded.received.some(frame => frame.type === 'state')).toBe(false);
      const state = nextFrame(seeded.socket, frame => frame.type === 'state');
      fixture.releaseReplay((await held).token);
      expect((await state).isStreaming).toBe(true);
    }
    expect(fixture.unexpected).toEqual([]);
  });
});

test('controlled retained state/outcome replay can be released after terminal history', async () => {
  await withFixture({ controlled: true, holdReplay: ['stored-a'] }, async (fixture, attach) => {
    fixture.deliver('stored-a', { type: 'ack', command: 'chat.send', requestId: 'retained', phase: 'completed' });
    const { socket, received } = await attach();
    expect(received.filter(frame => frame.type === 'state' || frame.type === 'ack')).toEqual([]);
    const held = fixture.traffic.find(event => event.kind === 'replay-held');
    const outcome = nextFrame(socket, frame => frame.type === 'ack' && frame.requestId === 'retained');
    const state = nextFrame(socket, frame => frame.type === 'state');
    const released = fixture.wait('replay-released', event => event.token === held.token);
    fixture.releaseReplay(held.token, { stateFirst: false }); await outcome; await state; await released;
    expect(received.filter(frame => ['entries', 'ack', 'state'].includes(frame.type)).map(frame => frame.type)).toEqual(['entries', 'ack', 'state']);
    expect(fixture.runState('stored-a').entries).toEqual([]);
    expect(() => fixture.releaseReplay(held.token)).toThrow('completed replay');
  });
});
