import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { observeModelConnections, assertModelConnectionsTerminated } from "./model-control-evidence.mjs";

// These emitters expose the public Playwright event surface. Actions emit
// synchronously, so subscribing after an action cannot pass by scheduling luck.
function fixture() {
  const context = new EventEmitter(), page = new EventEmitter();
  let documentUrl = "about:blank";
  page.context = () => context;
  page.url = () => documentUrl;
  const observer = observeModelConnections(page);
  function navigate(url = "http://fixture.test/") {
    documentUrl = url;
    page.emit("framenavigated", { url: () => url });
  }
  function open() {
    const socket = new EventEmitter();
    socket.url = () => "ws://fixture.test/api/v2/ws";
    page.emit("websocket", socket);
    return socket;
  }
  return { context, page, observer, navigate, open };
}
const receipt = observer => JSON.parse(JSON.stringify(observer));

test("socket events retain raw closure, wire correlation and exact lifecycle ordering", () => {
  const { observer, navigate, open } = fixture();
  navigate();
  const socket = open();
  const sent = { type: "chat.set", requestId: "r1", sessionId: "s1" };
  const received = { type: "ack", requestId: "r1", chatId: "s1" };
  socket.emit("framesent", { payload: JSON.stringify(sent) });
  socket.emit("framereceived", { payload: Buffer.from(JSON.stringify(received)) });
  expect(observer.connections[0].closed).toBe(false);
  socket.emit("close");
  expect(observer.connections[0].closed).toBe(true);
  expect(observer.wire.map(({ sequence, socketId, direction, requestId, sessionId, frame }) =>
    ({ sequence, socketId, direction, requestId, sessionId, frame }))).toEqual([
    { sequence: 1, socketId: 1, direction: "outbound", requestId: "r1", sessionId: "s1", frame: sent },
    { sequence: 2, socketId: 1, direction: "inbound", requestId: "r1", sessionId: "s1", frame: received },
  ]);
  expect(observer.lifecycle).toEqual([
    { sequence: 1, kind: "socket-open", socketId: 1, pageId: 1, contextId: 1 },
    { sequence: 2, kind: "socket-close", socketId: 1, pageId: 1, contextId: 1 },
  ]);
  expect(() => assertModelConnectionsTerminated(receipt(observer))).not.toThrow();
  observer.stop();
});

test("no terminal evidence rejects even after navigation and a generic browserClosed flag", () => {
  const { observer, navigate, open } = fixture();
  navigate(); open(); navigate("about:blank");
  const data = { ...receipt(observer), browserClosed: true };
  expect(() => assertModelConnectionsTerminated(data)).toThrow();
  expect(data.connections[0].closed).toBe(false);
  observer.stop();
});

test("an observed context close accounts for raw-false sockets across navigations without inventing close events", () => {
  const { context, page, observer, navigate, open } = fixture();
  expect(context.listenerCount("close")).toBe(1);
  expect(page.listenerCount("close")).toBe(1);
  for (let i = 0; i < 53; i++) {
    navigate(`http://fixture.test/${i}`);
    open();
  }
  expect(context.listenerCount("close")).toBe(1);
  expect(page.listenerCount("close")).toBe(1);
  context.emit("close");
  const data = receipt(observer);
  expect(data.connections.every(connection => connection.closed === false)).toBe(true);
  expect(data.connections.map(connection => connection.documentUrl)).toEqual(
    Array.from({ length: 53 }, (_, i) => `http://fixture.test/${i}`));
  expect(data.contexts).toEqual([{ contextId: 1 }]);
  expect(data.pages).toEqual([{ pageId: 1, contextId: 1 }]);
  expect(data.lifecycle.at(-1)).toEqual({ sequence: 54, kind: "context-close", contextId: 1 });
  expect(data.lifecycle.filter(event => event.kind === "socket-close")).toEqual([]);
  expect(() => assertModelConnectionsTerminated(data)).not.toThrow();
  observer.stop();
});

test("observed page closure alone proves its socket terminal without claiming a context or socket close", () => {
  const { page, observer, open } = fixture();
  open(); page.emit("close");
  const data = receipt(observer);
  expect(data.connections[0]).toMatchObject({ closed: false, pageId: 1, contextId: 1 });
  expect(data.lifecycle.at(-1)).toEqual({ sequence: 2, kind: "page-close", pageId: 1, contextId: 1 });
  expect(() => assertModelConnectionsTerminated(data)).not.toThrow();
  observer.stop();
});

test("socket, page and context close events remain distinct when all are delivered", () => {
  const { context, page, observer, open } = fixture();
  open().emit("close"); page.emit("close"); context.emit("close");
  expect(observer.lifecycle.map(event => event.kind)).toEqual([
    "socket-open", "socket-close", "page-close", "context-close",
  ]);
  expect(observer.connections[0].closed).toBe(true);
  expect(() => assertModelConnectionsTerminated(receipt(observer))).not.toThrow();
  observer.stop();
});

test("a closed peer socket cannot account for another connection", () => {
  const { observer, open } = fixture();
  open().emit("close"); open();
  expect(() => assertModelConnectionsTerminated(receipt(observer))).toThrow();
  observer.stop();
});

test("owner closure from a different page or context is not terminal proof", () => {
  for (const kind of ["page-close", "context-close"]) {
    const { observer, open } = fixture();
    open();
    const data = receipt(observer);
    data.lifecycle.push({ sequence: 2, kind, pageId: 2, contextId: 2 });
    expect(() => assertModelConnectionsTerminated(data)).toThrow();
    observer.stop();
  }
});

test("a close observed before the connection is not terminal proof for that connection", () => {
  const { context, observer, open } = fixture();
  context.emit("close"); open();
  expect(() => assertModelConnectionsTerminated(receipt(observer))).toThrow();
  observer.stop();
});

test("raw true without a socket-close event is rejected even if the context really closed", () => {
  const { context, observer, open } = fixture();
  open(); context.emit("close");
  const data = receipt(observer);
  data.connections[0].closed = true;
  expect(() => assertModelConnectionsTerminated(data)).toThrow();
  observer.stop();
});

test("missing or mismatched ownership cannot borrow terminal evidence", () => {
  for (const mutate of [
    data => { data.connections[0].pageId = 2; },
    data => { data.connections[0].contextId = 2; },
    data => { data.pages = []; },
    data => { data.contexts = []; },
    data => { data.lifecycle = data.lifecycle.filter(event => event.kind !== "socket-open"); },
  ]) {
    const { context, observer, open } = fixture();
    open(); context.emit("close");
    const data = receipt(observer); mutate(data);
    expect(() => assertModelConnectionsTerminated(data)).toThrow();
    observer.stop();
  }
});

test("stop detaches only observer subscriptions and cannot manufacture terminal events", () => {
  const { context, page, observer, open } = fixture();
  const socket = open();
  const foreign = () => {};
  context.on("close", foreign); page.on("close", foreign); socket.on("close", foreign);
  observer.stop();
  const before = receipt(observer);
  socket.emit("close"); page.emit("close"); context.emit("close");
  expect(receipt(observer)).toEqual(before);
  expect(socket.listeners("close")).toEqual([foreign]);
  expect(socket.listenerCount("framesent")).toBe(0);
  expect(socket.listenerCount("framereceived")).toBe(0);
  expect(page.listenerCount("websocket")).toBe(0);
  expect(page.listeners("close")).toEqual([foreign]);
  expect(context.listeners("close")).toEqual([foreign]);
  expect(() => assertModelConnectionsTerminated(before)).toThrow();
});
