/** Reusable actual-built-App HTTP/WS fixture. No user backend or disk state.
 * Import startFixture({ port: 25173, layout: "h3" }); await fixture.stop().
 * CLI: QA_PLAYWRIGHT=<installed-driver> bun test/qa/pane-workspace-ui.mjs EVIDENCE
 * Layouts: single, empty, two, h3, h4, v3, v4, mixed. Seed through fixture.reset().
 * Deferred opens: await fixture.wait("open"); fixture.resolveOpen(index, chat).
 * Running: seed { running: ["stored-a"] }; deliver(id, frame) reaches current subscribers.
 * Deferred creation: seed { deferredCreate: true }; wait("create"), resolveCreate(index).
 * Per-session seeds: runs: { [id]: { entries, queue, stats, running, model, thinkingLevel } }.
 * Entries use provider history shapes; queue/stats use server-frame payloads without type/sessionId.
 */
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
export const leaf = (id, sessionId = null) => ({ kind: "leaf", id, sessionId });
const split = (id, dir, first, second) => ({ kind: "split", id, dir, first, second, ratio: .5 });
export const chats = [{ id: "stored-a", name: "Stored A", provider: "omo" },
  { id: "newer", name: "Newer", provider: "omo" }];
export const layouts = {
  single: leaf("a", "stored-a"), empty: leaf("a"),
  two: split("root", "h", leaf("a", "stored-a"), leaf("b")),
  h3: split("root", "h", split("inner", "h", leaf("a", "stored-a"), leaf("b")), leaf("c")),
  h4: split("root", "h", split("inner", "h", leaf("a", "stored-a"), leaf("b")), split("other", "h", leaf("c"), leaf("d"))),
  v3: split("root", "v", split("inner", "v", leaf("a", "stored-a"), leaf("b")), leaf("c")),
  v4: split("root", "v", split("inner", "v", leaf("a", "stored-a"), leaf("b")), split("other", "v", leaf("c"), leaf("d"))),
  mixed: split("root", "h", split("inner", "v", leaf("a", "stored-a"), leaf("b")), leaf("c")),
};
export const models = [{ provider: "provider-a", modelId: "model-a", name: "Model A" },
  { provider: "provider-b", modelId: "model-b", name: "Model B" },
  { provider: "provider-c", modelId: "model-b", name: "Model B" },
  ...Array.from({ length: 50 }, (_, i) => ({ provider: "long-provider", modelId: `long-${i}`,
    name: `Long model ${i}: 실험 검증용 긴 모델 이름 with readable identity` }))];
const entries = Array.from({ length: 40 }, (_, i) => ({ id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null,
  type: "message", message: { role: i % 2 ? "assistant" : "user", content: `Synthetic turn ${i}. ${"Readable transcript. ".repeat(20)}` } }));
const goal = { status: "active", objective: "Preserve conversation, composer and bounded shelves.\n".repeat(8) };
const activity = { history: { task: { parent_session_id: "qa-durable", truncated_tasks: false,
  tasks: Array.from({ length: 18 }, (_, i) => ({ task_id: `task-${i}`, name: `Verified task ${i}`, status: "completed" })) }, dag: null } };
export function startFixture(options = {}) {
  const events = new EventEmitter(), requests = [], frames = [], unexpected = [], opens = [], creates = [], sockets = new Map();
  const runs = new Map(), files = new Map(), useTimes = new Map();
  let layout, workspace, stopped = false, pageFailures = 0, deferred = true, deferredCreate = false, shelves = false;
  function runFor(id) {
    if (!runs.has(id)) runs.set(id, { running: false, model: models[0], thinkingLevel: 'low', entries: shelves ? structuredClone(entries) : [] });
    return runs.get(id);
  }
  function deliver(id, frame) {
    const run = runFor(id);
    if (frame.type === 'run.started') run.running = true;
    if (frame.type === 'run.done') run.running = false;
    if (frame.type === 'queue') { const { type, sessionId, ...queue } = frame; run.queue = structuredClone(queue); }
    if (frame.type === 'stats') { const { type, sessionId, ...stats } = frame; run.stats = structuredClone(stats); }
    for (const [socket, sessionId] of sockets) if (sessionId === id) socket.send(JSON.stringify({ sessionId: id, ...frame }));
  }
  function reset(seed = {}) {
    layout = structuredClone(typeof seed.layout === "object" ? seed.layout : layouts[seed.layout ?? "two"]);
    workspace = { id: "ws", name: seed.longLabels ? "워크스페이스 검증 Long workspace identity for overflow checks" : "Workspace",
      path: "/fixture", chats: structuredClone(chats) };
    if (seed.longLabels) workspace.chats[0].name = "긴 세션 이름 verification with a deliberately long readable conversation identity";
    pageFailures = seed.pageFailures ?? 0; deferred = seed.deferred ?? true; shelves = seed.shelves ?? false;
    deferredCreate = seed.deferredCreate ?? false;
    files.clear();
    for (const [path, content] of Object.entries(seed.files ?? {})) files.set(path, content);
    runs.clear(); useTimes.clear();
    for (const [id, state] of Object.entries(seed.runs ?? {})) Object.assign(runFor(id), structuredClone(state));
    for (const id of seed.running ?? []) runFor(id).running = true;
  }
  reset(options);
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 25173,
    async fetch(req, server) {
      const url = new URL(req.url), path = url.pathname;
      const body = ["POST", "PUT"].includes(req.method) && req.headers.get("content-type")?.includes("application/json") ? await req.json() : undefined;
      const request = { method: req.method, path: path + url.search, body }; requests.push(request);
      events.emit("request", request);
      if (path === "/api/v2/ws" && server.upgrade(req)) return;
      if (path === "/api/auth/check") return new Response(null, { status: 204 });
      if (path === "/api/providers") return Response.json([{ id: "omo", label: "omo", available: true }]);
      if (path === "/api/workspaces") return Response.json([workspace]);
      if (path === "/api/layout") {
        if (req.method === "PUT") { layout = body; events.emit("layout", structuredClone(layout)); }
        return Response.json({ layout });
      }
      if (path === "/api/workspaces/ws/chats" && req.method === "POST") {
        const chat = { id: `created-${workspace.chats.length}`, name: "Created chat", provider: "omo" };
        if (!deferredCreate) { workspace.chats.push(chat); return Response.json(chat); }
        return new Promise(done => {
          const pending = { release: (value = chat, status = 200) => {
            pending.release = null;
            if (status === 200) workspace.chats.push(value);
            done(Response.json(value, { status }));
          } };
          creates.push(pending); events.emit('create', { index: creates.length - 1 });
        });
      }
      const usage = /^\/api\/workspaces\/ws\/chats\/([^/]+)\/touch$/.exec(path);
      if (usage && req.method === "POST") {
        const id = decodeURIComponent(usage[1]);
        if (id !== "union" && !workspace.chats.some(chat => chat.id === id)) return Response.json({ error: "not found" }, { status: 404 });
        const recencyMs = (options.now ?? Date.now)();
        useTimes.set(id, recencyMs);
        return Response.json({ recencyMs });
      }
      if (path === "/api/workspaces/ws/sessions") {
        if (pageFailures > 0) { pageFailures--; return Response.json({ error: "fixture page failure" }, { status: 503 }); }
        return Response.json(url.searchParams.has("cursor")
          ? { items: [{ id: "discovered-c", name: "Discovered C", source: "discovered", recencyMs: 10 }], nextCursor: "" }
          : { items: [{ id: "discovered-b", name: "Discovered B", source: "discovered", recencyMs: 50 },
            ...workspace.chats.map((chat, i) => ({ ...chat, source: "stored", recencyMs: useTimes.get(chat.id) ?? 40 - i })),
            { id: "union", name: "Union stored row", source: "stored", recencyMs: useTimes.get("union") ?? 20 }]
            .sort((a, b) => b.recencyMs - a.recencyMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), nextCursor: "page2" });
      }
      if (path.endsWith("/sessions/open")) {
        const chat = { id: `opened-${body.id}`, name: `Opened ${body.id}`, provider: "omo" };
        if (!deferred) { workspace.chats.push(chat); return Response.json(chat); }
        return new Promise(done => {
          const pending = { body, release: (value = chat, status = 200) => {
            pending.release = null;
            if (status === 200) workspace.chats.push(value);
            done(Response.json(value, { status }));
          } };
          opens.push(pending); events.emit("open", { index: opens.length - 1, body });
        });
      }
      if (path.startsWith("/api/sessions/")) return Response.json({ sessions: [] });
      if (path.endsWith("/goal")) return Response.json({ goal: shelves ? goal : null });
      if (path.endsWith("/activity")) return Response.json(shelves ? activity : { history: {} });
      if (path === "/api/fs/list") return Response.json({ path: "/fixture", entries: [...files].map(([path, content]) => ({
        name: path.slice('/fixture/'.length), isDir: false, size: Buffer.byteLength(content), modTime: '2026-09-06T00:00:00Z',
      })) });
      if (files.has(url.searchParams.get('path'))) {
        const filePath = url.searchParams.get('path');
        if (path === '/api/fs/read' && req.method === 'GET') {
          const content = files.get(filePath); return Response.json({ content, size: Buffer.byteLength(content) });
        }
        if (path === '/api/fs/write' && req.method === 'POST' && typeof body.content === 'string') {
          files.set(filePath, body.content); return new Response(null, { status: 204 });
        }
      }
      if (path.startsWith("/api/")) { unexpected.push(request); return new Response(`Unexpected ${path}`, { status: 404 }); }
      const file = Bun.file(resolve(import.meta.dir, "../../frontend/dist", path === "/" ? "index.html" : path.slice(1)));
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) { sockets.set(ws, null); ws.send(JSON.stringify({ type: "hello", version: 2, serverVersion: "qa" })); },
      close(ws) { sockets.delete(ws); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)); frames.push(frame);
        const send = body => ws.send(JSON.stringify({ sessionId: frame.sessionId ?? frame.chatId, ...body }));
        switch (frame.type) {
          case "chat.create": {
            sockets.set(ws, frame.chatId);
            const run = runFor(frame.chatId);
            send({ type: "ready", resumed: true, piSessionId: frame.chatId });
            send({ type: "state", isStreaming: run.running, isCompacting: false, model: run.model, thinkingLevel: run.thinkingLevel });
            send({ type: "models", models }); send({ type: "commands", commands: [] });
            send({ type: "entries", entries: run.entries, final: true });
            if (run.queue) send({ type: "queue", ...run.queue });
            break;
          }
          case "chat.stats": send({ type: "stats", ...(runFor(frame.sessionId).stats ?? { cost: 0 }) }); break;
          case "chat.models": send({ type: "models", models }); break;
          case "chat.set":
            if (frame.model) runFor(frame.sessionId).model = frame.model;
            if (frame.thinkingLevel) runFor(frame.sessionId).thinkingLevel = frame.thinkingLevel;
            send({ type: "ack", requestId: frame.requestId, command: frame.model ? "set_model" : "set_thinking_level" });
            send({ type: "control.result", requestId: frame.requestId,
              command: frame.model ? "set_model" : "set_thinking_level", success: true }); break;
          case "chat.send":
            send({ type: "ack", requestId: frame.requestId, command: "chat.send" });
            deliver(frame.sessionId, { type: "run.started" }); break;
          case "chat.queue.move": case "chat.queue.remove": case "chat.queue.clear": {
            const queue = structuredClone(runFor(frame.sessionId).queue);
            if (!queue) { unexpected.push({ frame }); break; }
            if (frame.type === 'chat.queue.clear') {
              if (!['webchat', 'engine', 'all'].includes(frame.scope)) { unexpected.push({ frame }); break; }
              if (frame.scope !== 'engine') queue.items = [];
              if (frame.scope !== 'webchat') queue.engine = { pendingMessageCount: 0, ordered: [] };
            } else {
              const index = queue.items.findIndex(item => item.id === frame.itemId);
              if (index < 0) { send({ type: 'error', code: 'queue_item_not_found', requestId: frame.requestId }); break; }
              if (frame.type === 'chat.queue.move' && (!Number.isInteger(frame.toIndex) || frame.toIndex < 0 || frame.toIndex >= queue.items.length)) {
                unexpected.push({ frame }); break;
              }
              const [item] = queue.items.splice(index, 1);
              if (frame.type === 'chat.queue.move') queue.items.splice(frame.toIndex, 0, item);
            }
            send({ type: 'ack', requestId: frame.requestId, command: frame.type });
            deliver(frame.sessionId, { type: 'queue', ...queue, revision: queue.revision + 1 });
            break;
          }
          case "chat.abort": deliver(frame.sessionId, { type: "run.done", reason: "stop" }); break;
          case "hello": case "sessions.subscribe": case "activity.refresh": break;
          default: unexpected.push({ frame });
        }
        events.emit("frame", frame);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`, requests, frames, unexpected, opens, creates, reset, deliver,
    fileContent(path) { return files.get(path); },
    runState(id) { return structuredClone(runFor(id)); },
    subscribers(id) { return [...sockets.values()].filter(sessionId => sessionId === id).length; },
    resolveCreate(index, chat, status) { creates[index].release(chat, status); },
    get layout() { return structuredClone(layout); },
    failNextPage() { pageFailures++; },
    resolveOpen(index, chat, status) { opens[index].release(chat, status); },
    wait(event, predicate = () => true) {
      return new Promise((done, fail) => {
        const listener = value => { if (predicate(value)) { clearTimeout(timer); events.off(event, listener); done(value); } };
        const timer = setTimeout(() => { events.off(event, listener); fail(new Error(`Fixture ${event} deadline`)); }, 8000);
        events.on(event, listener);
      });
    },
    async stop() {
      if (stopped) throw new Error("Fixture already stopped");
      stopped = true;
      for (const pending of [...opens, ...creates]) if (pending.release) pending.release({ error: "fixture stopping" }, 503);
      for (const socket of sockets.keys()) socket.close();
      await server.stop(true);
      return { serverStopped: true, pendingWebSockets: server.pendingWebSockets, port: server.port,
        fixtureInMemoryOnly: true, pendingOpens: opens.filter(open => open.release).length,
        pendingCreates: creates.filter(create => create.release).length };
    },
  };
}
if (import.meta.main) {
  const { run } = await import("./pane-workspace-regressions.mjs");
  await run(resolve(process.argv[2]));
}
