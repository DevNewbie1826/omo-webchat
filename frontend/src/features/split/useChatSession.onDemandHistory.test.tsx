import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";
import { recordSteerMark } from "./chatSteerMarks";

const session = { id: "older-chat", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
const entry = (id: string, role = "user", text = id) => ({ type: "message", id, message: { role, content: text } });
let root: Root;
let state: ReturnType<typeof useChatSession>;
let handlers: Parameters<ChatConnector>[0];
let sent: ChatClientFrame[];
let requests: Array<{ url: string; signal: AbortSignal | null | undefined; finish: (response: Response) => void }>;
const deliver = (frame: ChatServerFrame) => act(() => handlers.onFrame(frame));
const tail = (historySessionId = "durable") => deliver({
  type: "entries", sessionId: session.id, historySessionId,
  entries: [entry("tail")], historyComplete: false, final: true,
});
const ready = () => deliver({ type: "ready", sessionId: session.id, piSessionId: "durable", resumed: true });
const load = () => act(() => state.olderHistory.loadOlder());
async function respond(index: number, status: number, body: unknown = {}) {
  const request = requests[index];
  if (!request) throw new Error("history request missing");
  await act(async () => request.finish(new Response(JSON.stringify(body), { status })));
}
const olderPage = (complete = false) => ({
  sessionId: "durable", entries: [entry("older")], historyComplete: complete,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  sent = [];
  requests = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (!url.includes("/history?")) return Promise.resolve(new Response("{}", { status: 200 }));
    return new Promise<Response>(finish => requests.push({ url, signal: init?.signal, finish }));
  });
  const connect: ChatConnector = (next) => {
    handlers = next;
    next.onOpen?.();
    return { send: frame => { sent.push(frame); return true; }, close: () => undefined };
  };
  function Probe() { state = useChatSession(session, connect); return null; }
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  ready();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("requests one bounded page per pane and prepends without changing committed message identity", async () => {
  recordSteerMark(session.id, { requestId: "old-steer", entryId: "tail", text: "tail" });
  tail();
  const committed = state.messages[0];
  const restore = state.restoreVersion;
  act(() => { state.olderHistory.loadOlder(); state.olderHistory.loadOlder(); });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toContain("session=durable&before=tail&limit=100");
  expect(state.olderHistory.state).toBe("loading");
  await respond(0, 200, olderPage(true));
  expect(state.messages.map(message => message.id)).toEqual(["older", "tail"]);
  expect(state.messages[1]).toBe(committed);
  expect(state.messages[1]?.customType).toBe("steer");
  expect(state.restoreVersion).toBe(restore);
  expect(state.historyRootKnown).toBe(true);
  expect(state.olderHistory.state).toBe("complete");
  load();
  expect(requests).toHaveLength(1);
});

it("advances the before cursor only after a page commits", async () => {
  tail();
  load();
  await respond(0, 200, olderPage());
  load();
  expect(requests[1]?.url).toContain("before=older&limit=100");
  await respond(1, 200, { ...olderPage(true), entries: [entry("root")] });
  expect(state.messages.map(message => message.id)).toEqual(["root", "older", "tail"]);
});

it.each(["open", "close"])("aborts a pending page immediately on mark%s", async lifecycle => {
  tail();
  load();
  act(() => {
    if (lifecycle === "open") handlers.onOpen?.();
    else handlers.onClose?.(1006);
  });
  expect(requests[0]?.signal?.aborted).toBe(true);
  await respond(0, 200, olderPage());
  expect(state.messages.map(message => message.id)).toEqual(["tail"]);
});

it("aborts on reconnect and ignores its late response without clearing a newer request", async () => {
  tail();
  load();
  act(() => { handlers.onClose?.(1006); handlers.onOpen?.(); });
  expect(requests[0]?.signal?.aborted).toBe(true);
  ready();
  tail();
  load();
  await respond(0, 200, olderPage(true));
  expect(state.messages.map(message => message.id)).toEqual(["tail"]);
  expect(state.olderHistory.state).toBe("loading");
  await respond(1, 200, olderPage());
  expect(state.messages.map(message => message.id)).toEqual(["older", "tail"]);
});

it("discards a response when durable history identity changes on the same connection", async () => {
  tail();
  load();
  tail("replacement");
  await respond(0, 200, olderPage(true));
  expect(state.messages.map(message => message.id)).toEqual(["tail"]);
  expect(state.historyRootKnown).toBe(false);
});

it("discards an old branch page and completion after same-socket replacement", async () => {
  tail();
  load();
  deliver({
    type: "entries", sessionId: session.id, historySessionId: "durable",
    entries: [entry("new-tail")], final: true, historyComplete: false,
  });
  expect(state.messages.map(message => message.id)).toEqual(["new-tail"]);
  await respond(0, 200, {
    sessionId: "durable", entries: [entry("root"), entry("old-parent")], historyComplete: true,
  });
  expect(state.messages.map(message => message.id)).toEqual(["new-tail"]);
  expect(state.historyRootKnown).toBe(false);
  expect(state.olderHistory.state).toBe("idle");
  expect(requests[0]?.signal?.aborted).toBe(true);
  load();
  expect(requests[1]?.url).toContain("before=new-tail");
  await respond(1, 200, { ...olderPage(true), entries: [entry("new-parent")] });
  expect(state.messages.map(message => message.id)).toEqual(["new-parent", "new-tail"]);
});

it("discards a page requested before a new replay generation on the same socket", async () => {
  tail();
  load();
  ready();
  await respond(0, 200, olderPage(true));
  expect(state.messages.map(message => message.id)).toEqual(["tail"]);
  expect(state.historyRootKnown).toBe(false);
  expect(state.olderHistory.state).toBe("idle");
});

it("discards a page whose before boundary has already advanced", async () => {
  tail();
  load();
  deliver({
    type: "entries", sessionId: session.id, historySessionId: "durable",
    segment: "head", entries: [entry("current-parent")], historyComplete: false,
  });
  await respond(0, 200, olderPage(true));
  expect(state.messages.map(message => message.id)).toEqual(["current-parent", "tail"]);
  expect(state.historyRootKnown).toBe(false);
  expect(state.olderHistory.state).toBe("idle");
});

it("aborts older history on explicit resync and does not commit a late page", async () => {
  tail();
  load();
  act(() => state.resync());
  expect(requests[0]?.signal?.aborted).toBe(true);
  await respond(0, 200, olderPage(true));
  expect(state.messages.map(message => message.id)).toEqual(["tail"]);
});

it("aborts older history on unmount", () => {
  tail();
  load();
  act(() => root.render(null));
  expect(requests[0]?.signal?.aborted).toBe(true);
});

it("resyncs a stale cursor once and exposes a second stale result as retryable error", async () => {
  tail();
  deliver({ type: "state", sessionId: session.id, isStreaming: true, isCompacting: false });
  load();
  const creates = () => sent.filter(frame => frame.type === "chat.create").length;
  const initialCreates = creates();
  await respond(0, 409);
  expect(creates()).toBe(initialCreates + 1);
  ready();
  tail();
  load();
  await respond(1, 409);
  expect(creates()).toBe(initialCreates + 1);
  expect(state.olderHistory.state).toBe("error");
  load();
  await respond(2, 200, olderPage(true));
  expect(state.olderHistory.state).toBe("complete");
});

it("marks gone history unavailable without resyncing or issuing further requests", async () => {
  tail();
  load();
  const frames = sent.length;
  await respond(0, 404);
  expect(sent).toHaveLength(frames);
  expect(state.olderHistory.state).toBe("unavailable");
  load();
  expect(requests).toHaveLength(1);
});

it.each([503, 500])("permits retry after history HTTP %s", async status => {
  tail();
  load();
  await respond(0, status);
  expect(state.olderHistory.state).toBe("error");
  load();
  await respond(1, 200, olderPage());
  expect(state.olderHistory.state).toBe("idle");
});

it.each([false, true])("retries failed empty history while running (compacting=%s)", compacting => {
  deliver({ type: "state", sessionId: session.id, isStreaming: true, isCompacting: compacting });
  deliver({ type: "error", sessionId: session.id, code: "incomplete_history", message: "broken branch" });
  expect(state.historyFailedEmpty).toBe(true);
  act(() => state.retryHistory());
  expect(sent.slice(-2).map(frame => frame.type)).toEqual(["chat.close", "chat.create"]);
  expect(state.historyStatus).toBe("loading");
  expect(state.running).toBe(true);
});

it.each([false, true])("retries from live reconnect state before the loading render commits, once only (retained=%s)", retained => {
  if (retained) tail();
  deliver({ type: "error", sessionId: session.id, code: "incomplete_history", message: "broken branch" });
  act(() => { handlers.onClose?.(1006); handlers.onOpen?.(); });
  expect(state.resyncDisabled).toBe(true);
  const before = sent.length;
  act(() => {
    handlers.onFrame({ type: "ready", sessionId: session.id, piSessionId: "durable", resumed: true });
    handlers.onFrame({ type: "error", sessionId: session.id, code: "incomplete_history", message: "broken branch" });
    state.retryHistory();
    state.retryHistory();
  });
  expect(sent.slice(before).map(frame => frame.type)).toEqual(["chat.close", "chat.create"]);
  expect(state.historyStatus).toBe("loading");
});

it("shows failed empty history only while connected and never over committed messages", () => {
  deliver({ type: "error", sessionId: session.id, code: "incomplete_history", message: "broken branch" });
  expect(state.historyFailedEmpty).toBe(true);
  act(() => handlers.onClose?.(1006));
  expect(state.historyFailedEmpty).toBe(false);
  act(() => handlers.onOpen?.());
  ready();
  tail();
  act(() => state.resync());
  deliver({ type: "error", sessionId: session.id, code: "incomplete_history", message: "broken branch" });
  expect(state.historyFailedEmpty).toBe(false);
});
