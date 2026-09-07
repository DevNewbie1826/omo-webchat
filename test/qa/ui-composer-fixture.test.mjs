import { test, expect } from 'bun:test';
import { startComposerFixture, transition, safeBounds, fits } from './ui-composer-fixture.mjs';

function next(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('WS event deadline')); }, 2000);
    function onMessage(event) {
      const frame = JSON.parse(event.data);
      if (!predicate(frame)) return;
      clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve(frame);
    }
    socket.addEventListener('message', onMessage);
  });
}

test('controlled composer fixture holds sends, keeps queue state coherent, and delivers exact outcomes', async () => {
  const fixture = startComposerFixture();
  const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/api/v2/ws');
  try {
    await next(socket, f => f.type === 'hello');
    const entries = next(socket, f => f.type === 'entries' && f.final);
    socket.send(JSON.stringify({ type: 'chat.create', chatId: 'stored-a', wsId: 'ws' }));
    expect((await entries).entries.length).toBeGreaterThan(24);
    expect(fixture.runState('stored-a').queue.items.length).toBe(9);
    const cleared = next(socket, f => f.type === 'queue' && f.revision === 2);
    fixture.deliver('stored-a', { type: 'queue', revision: 2, items: [], engine: { pendingMessageCount: 0, ordered: [] } });
    expect((await cleared).items).toEqual([]);
    expect(fixture.runState('stored-a').queue.items).toEqual([]);
    fixture.deliver('stored-a', { type: 'run.done', reason: 'stop' });
    const sent = fixture.wait('frame', f => f.type === 'chat.send' && f.requestId === 'probe');
    const start = fixture.traffic.length;
    socket.send(JSON.stringify({ type: 'chat.send', sessionId: 'stored-a', requestId: 'probe', run: { kind: 'prompt', message: 'original' } }));
    await sent; // Emitted only after the fixture send handler has finished.
    expect(fixture.traffic.slice(start).filter(e => e.kind === 'outgoing')).toEqual([]);
    expect(fixture.runState('stored-a').running).toBe(false);
    const done = next(socket, f => f.type === 'run.done' && f.reason === 'local_command');
    fixture.deliver('stored-a', { type: 'run.done', reason: 'local_command' });
    await done;
    expect(fixture.runState('stored-a').entries.some(e => e.message?.content === 'original')).toBe(false);
    const ack = next(socket, f => f.type === 'ack' && f.requestId === 'probe');
    fixture.deliver('stored-a', { type: 'ack', command: 'chat.send', requestId: 'probe', phase: 'completed' });
    expect((await ack).phase).toBe('completed');
    expect(fixture.runState('stored-a').outcomes).toHaveLength(1);
    const modelResult = next(socket, f => f.type === 'control.result' && f.requestId === 'model-change');
    socket.send(JSON.stringify({ type: 'chat.set', sessionId: 'stored-a', requestId: 'model-change',
      model: { provider: 'provider-b', modelId: 'model-b' } }));
    expect((await modelResult).success).toBe(true);
    expect(fixture.runState('stored-a').model).toEqual({ provider: 'provider-b', modelId: 'model-b' });
    const thinkingResult = next(socket, f => f.type === 'control.result' && f.requestId === 'thinking-change');
    socket.send(JSON.stringify({ type: 'chat.set', sessionId: 'stored-a', requestId: 'thinking-change', thinkingLevel: 'high' }));
    expect((await thinkingResult).success).toBe(true);
    expect(fixture.runState('stored-a').thinkingLevel).toBe('high');
  } finally {
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    socket.close(); await closed;
    expect((await fixture.stop()).pendingWebSockets).toBe(0);
  }
});

test('DOM transitions arm before action and await the actual signal', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let resolve, armed = false, complete = false;
  const event = new Promise(done => { resolve = done; });
  globalThis.window = { qaSignal() { armed = true; return event; } };
  const page = { async evaluate(fn, value) { return fn(value); } };
  try {
    const action = transition(page, '() => true', async () => {
      expect(armed).toBe(true);
      expect(complete).toBe(false);
      resolve(true);
    }).then(() => { complete = true; });
    await action;
    expect(complete).toBe(true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
});

test('safe bounds use the shrunken panned visual viewport, not original screen dimensions', () => {
  const bounds = safeBounds({ left: 60, top: 80, width: 300, height: 230 },
    { left: 47, right: 47, top: 59, bottom: 34 });
  expect(bounds).toEqual({ left: 107, right: 313, top: 139, bottom: 276 });
  expect(fits({ left: 269, right: 313, top: 139, bottom: 183 }, bounds)).toBe(true);
  for (const rect of [
    { left: 106, right: 150, top: 139, bottom: 183 },
    { left: 270, right: 314, top: 139, bottom: 183 },
    { left: 269, right: 313, top: 138, bottom: 182 },
    { left: 269, right: 313, top: 233, bottom: 277 },
  ]) expect(fits(rect, bounds)).toBe(false);
  expect(fits(null, bounds)).toBe(false);
});
