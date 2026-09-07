/** Task-specific transport controls around the existing built-App fixture.
 * Native sockets on both hops; no browser WebSocket replacement or reducer.
 */
import assert from 'node:assert/strict';
import { startFixture } from './pane-workspace-ui.mjs';

export const chat = 'stored-a';
export const activityPath = `/api/workspaces/ws/chats/${chat}/activity`;
export const pollPath = '/api/sessions/live';
export const deadline = 15_000;

/** Holds actual requests individually, including unsolicited fallback polls. */
export function createTaskRequestGate(record = () => {}) {
  const held = new Map(), waiters = new Set(), requests = [];
  let stopped = false;
  function next(path) {
    assert.ok([activityPath, pollPath].includes(path));
    assert.equal(stopped, false);
    const available = [...held.values()].find(item => item.row.path === path && !item.claimed);
    if (available) { available.claimed = true; return Promise.resolve(available.row.token); }
    const promise = new Promise((resolve, reject) => {
      const waiter = { path, finish(error, token) {
        clearTimeout(timer); waiters.delete(waiter); error ? reject(error) : resolve(token);
      } };
      const timer = setTimeout(() => waiter.finish(new Error(`Request deadline: ${path}`)), deadline);
      waiters.add(waiter);
    });
    promise.catch(() => {}); return promise;
  }
  async function handle(route) {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' || ![activityPath, pollPath].includes(path)) return route.fallback();
    if (stopped) return route.abort();
    const row = { token: requests.length + 1, path, url: request.url(), method: request.method(), state: 'held' };
    requests.push(row);
    const pending = new Promise(done => held.set(row.token, { row, route, done, claimed: false }));
    record({ action: 'request-held', ...row });
    const waiter = [...waiters].find(item => item.path === path);
    if (waiter) { held.get(row.token).claimed = true; waiter.finish(null, row.token); }
    await pending;
  }
  async function release(token, body) {
    const item = held.get(token);
    assert.ok(item && item.row.state === 'held', `Unknown/released request: ${token}`);
    item.row.state = 'releasing';
    try {
      await item.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      item.row.state = 'released'; record({ action: 'request-released', token, path: item.row.path, body });
      held.delete(token); item.done();
    } catch (error) { item.row.state = 'held'; throw error; }
  }
  async function stop() {
    stopped = true;
    for (const waiter of [...waiters]) waiter.finish(new Error('Request gate stopped'));
    const errors = [];
    for (const [token, item] of held) {
      try { await item.route.abort(); item.row.state = 'aborted'; }
      catch (error) { errors.push({ token, error: String(error) }); item.row.state = 'abort-failed'; }
      finally { held.delete(token); item.done(); }
    }
    return { held: held.size, waiters: waiters.size, requests, errors };
  }
  return { next, handle, release, stop, requests };
}

export function startTaskFixture(options = {}) {
  const base = startFixture({ ...options, port: 0, controlled: true });
  const clients = new Set(), allClients = [], traffic = [], errors = [];
  let sequence = 0, stopped = false;
  const record = (direction, peer, raw) => traffic.push({ sequence: ++sequence, direction, socketId: peer.id,
    raw: String(raw), frame: JSON.parse(String(raw)) });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/api/v2/ws' && server.upgrade(request)) return;
      url.host = new URL(base.url).host;
      return fetch(new Request(url, request));
    },
    websocket: {
      open(socket) {
        const upstream = new WebSocket(base.url.replace(/^http/, 'ws') + '/api/v2/ws');
        let closed;
        const peer = { id: allClients.length + 1, socket, upstream, chat: null, overview: false, queue: [],
          closed: new Promise(resolve => { closed = resolve; }) };
        socket.data = peer; clients.add(peer); allClients.push(peer);
        upstream.addEventListener('open', () => { for (const raw of peer.queue) upstream.send(raw); peer.queue.length = 0; });
        upstream.addEventListener('message', event => { record('received', peer, event.data); socket.send(event.data); });
        upstream.addEventListener('error', event => { errors.push(String(event.message ?? 'upstream socket error')); socket.close(1011); });
        upstream.addEventListener('close', event => { closed(); socket.close(event.code === 1006 ? 1011 : event.code, event.reason); });
      },
      message(socket, raw) {
        const peer = socket.data, text = String(raw), frame = JSON.parse(text);
        record('sent', peer, text);
        if (frame.type === 'chat.create') peer.chat = frame.chatId;
        if (frame.type === 'chat.close') peer.chat = null;
        if (frame.type === 'sessions.subscribe') peer.overview = frame.mode === 'all_live';
        if (peer.upstream.readyState === WebSocket.OPEN) peer.upstream.send(text); else peer.queue.push(text);
      },
      close(socket) { const peer = socket.data; clients.delete(peer); peer.upstream.close(); },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, base, traffic, errors,
    deliver: (id, frame) => base.deliver(id, frame),
    overview(frame) {
      const targets = [...clients].filter(peer => peer.overview);
      assert.ok(targets.length > 0, 'No native overview subscription');
      for (const peer of targets) { const raw = JSON.stringify(frame); record('received', peer, raw); peer.socket.send(raw); }
      return targets.map(peer => peer.id);
    },
    disconnect: id => base.disconnect(id),
    async stop() {
      assert.equal(stopped, false); stopped = true;
      const port = server.port;
      for (const peer of clients) { peer.socket.close(); peer.upstream.close(); }
      let timer, closureError;
      try { await Promise.race([Promise.all(allClients.map(peer => peer.closed)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Upstream closure deadline')), deadline);
      })]); } catch (error) { closureError = error; } finally { clearTimeout(timer); }
      await server.stop(true);
      const original = await base.stop();
      if (closureError) throw closureError;
      return { port, pendingWebSockets: server.pendingWebSockets, upstreamSockets: allClients.length, original, errors };
    },
  };
}
