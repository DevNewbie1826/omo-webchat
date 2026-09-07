/** Native HTTP/WS fixture for confirmed model/compaction statistics refresh. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startFixture, leaf } from './pane-workspace-ui.mjs';

export const models = [
  { provider: 'rpc46', modelId: 'large', name: 'RPC46 Large' },
  { provider: 'rpc46', modelId: 'small', name: 'RPC46 Small' },
];
export const usage = percent => ({ cost: 0,
  contextUsage: { tokens: 272000 * percent / 100, contextWindow: 272000, percent } });
export const history = id => Array.from({ length: 240 }, (_, i) => ({
  id: `${id}-entry-${i}`, parentId: i ? `${id}-entry-${i - 1}` : null, type: 'message',
  message: { role: i % 2 ? 'assistant' : 'user', content: `${id}-history-${i + 1}: Saved RPC conversation.` },
}));

/** Reuse the production-App fixture's HTTP/assets/layout routes, but not its
 * automatic chat.set success. All WS traffic reaches this explicit controller.
 * No engine, disk sessions, browser socket replacement, or production routes.
 */
export async function startStatsFixture({ port = 25263, mobile = false, assetsDir } = {}) {
  const layout = mobile ? leaf('a', 'stored-a') : { kind: 'split', id: 'root', dir: 'h', ratio: .5,
    first: leaf('a', 'stored-a'), second: leaf('b', 'newer') };
  const http = startFixture({ port: 0, layout, assetsDir, controlled: true, deferred: false });
  const events = new EventEmitter(), sockets = new Map(), pending = new Map(), compact = new Set();
  const traffic = [], frames = [], unexpected = [], waiters = new Set();
  const states = new Map(['stored-a', 'newer'].map(id => [id, {
    model: models[0], stats: usage(id === 'stored-a' ? 34 : 23), entries: history(id),
  }]));
  let server, stopped = false;
  const record = (direction, frame) => {
    const row = { sequence: traffic.length + 1, direction, frame: structuredClone(frame) };
    traffic.push(row); events.emit(direction, row.frame); return row;
  };
  const send = (socket, frame) => { socket.send(JSON.stringify(frame)); record('received', frame); };
  const deliver = (routeId, frame) => {
    assert.ok([...sockets.values()].includes(routeId), `No subscriber for ${routeId}`);
    for (const [socket, id] of sockets) if (id === routeId) send(socket, { sessionId: routeId, ...frame });
  };
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port,
      async fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === '/api/v2/ws' && server.upgrade(request)) return;
        const response = await fetch(new Request(http.url + url.pathname + url.search, request));
        return new Response(response.body, { status: response.status, headers: response.headers });
      },
      websocket: {
        open(socket) { sockets.set(socket, null); send(socket, { type: 'hello', version: 2, serverVersion: 'rpc46-qa' }); },
        close(socket) { sockets.delete(socket); },
        message(socket, raw) {
          const frame = JSON.parse(String(raw)); frames.push(frame);
          const reply = value => send(socket, { sessionId: frame.sessionId ?? frame.chatId, ...value });
          switch (frame.type) {
            case 'hello': case 'sessions.subscribe': case 'activity.refresh': break;
            case 'ping': send(socket, { type: 'pong' }); break;
            case 'chat.create': {
              const state = states.get(frame.chatId);
              assert.ok(state, `Unknown fixture session ${frame.chatId}`);
              sockets.set(socket, frame.chatId);
              reply({ type: 'ready', resumed: true, piSessionId: frame.chatId });
              reply({ type: 'state', isStreaming: false, isCompacting: false, model: state.model, thinkingLevel: 'off' });
              reply({ type: 'models', models }); reply({ type: 'commands', commands: [] });
              reply({ type: 'entries', entries: state.entries, final: true }); break;
            }
            case 'chat.models': reply({ type: 'models', models }); break;
            case 'chat.stats': reply({ type: 'stats', ...states.get(frame.sessionId).stats }); break;
            case 'chat.set':
              assert.ok(frame.model && frame.requestId, 'Only correlated model controls are expected');
              pending.set(frame.requestId, frame); break;
            case 'chat.compact':
              assert.ok(!compact.has(frame.sessionId), 'Compaction is already held');
              compact.add(frame.sessionId); break;
            case 'chat.close': sockets.set(socket, null); break;
            default: unexpected.push(frame);
          }
          record('sent', frame);
        },
      },
    });
  } catch (error) { await http.stop(); throw error; }
  return {
    url: `http://127.0.0.1:${server.port}`, traffic, frames, unexpected, http, deliver,
    state(id) { return structuredClone(states.get(id)); },
    acknowledge(requestId) {
      const frame = pending.get(requestId); assert.ok(frame, `Unknown held model ${requestId}`);
      deliver(frame.sessionId, { type: 'ack', command: 'set_model', requestId });
    },
    resolveModel(requestId, { success, percent = 50 } = {}) {
      const frame = pending.get(requestId); assert.ok(frame, `Unknown held model ${requestId}`);
      pending.delete(requestId);
      if (success) { states.get(frame.sessionId).model = frame.model; states.get(frame.sessionId).stats = usage(percent); }
      deliver(frame.sessionId, success
        ? { type: 'control.result', command: 'set_model', requestId, success: true }
        : { type: 'error', command: 'set_model', requestId, code: 'provider_error', message: 'QA_MODEL_REJECTED' });
    },
    startCompact(id) {
      assert.ok(compact.has(id), 'No held manual compaction');
      deliver(id, { type: 'compaction.started' });
    },
    resolveCompact(id, { success, percent = 10 } = {}) {
      assert.ok(compact.delete(id), 'No held manual compaction');
      if (success) states.get(id).stats = usage(percent);
      deliver(id, { type: 'compaction.done', ...(success ? {} : { error: 'QA_COMPACT_REJECTED' }) });
    },
    wait(predicate, direction = 'sent') {
      let cancel;
      const promise = new Promise((resolveWait, reject) => {
        const finish = (error, value) => {
          clearTimeout(timer); events.off(direction, listener); waiters.delete(cancel);
          error ? reject(error) : resolveWait(value);
        };
        const listener = value => { try { if (predicate(value)) finish(null, value); } catch (error) { finish(error); } };
        const timer = setTimeout(() => finish(new Error('RPC46 fixture event deadline')), 10000);
        cancel = () => finish(new Error('RPC46 fixture stopped with pending waiter'));
        waiters.add(cancel); events.on(direction, listener);
      });
      promise.catch(() => {}); return promise;
    },
    async stop() {
      assert.equal(stopped, false, 'Fixture already stopped'); stopped = true;
      for (const cancel of [...waiters]) cancel();
      const releasedControls = { models: pending.size, compactions: compact.size };
      pending.clear(); compact.clear();
      const boundPort = server.port;
      await server.stop(true);
      return { publicServer: { port: boundPort, stopped: true, pendingWebSockets: server.pendingWebSockets },
        http: await http.stop(), releasedControls, inMemoryOnly: true };
    },
  };
}
