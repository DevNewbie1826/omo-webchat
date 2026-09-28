import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatConnector, type ChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";
import { useChatFrameState } from "./useChatFrameState";
import { useChatSession } from "./useChatSession";

const session = { id: "preview-chat", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
const entry = (id: string) => ({ type: "message", id, message: { role: "user", content: id } });
const entries = [entry("one"), entry("two")];
const preview = {
  type: "entries", sessionId: session.id, historySessionId: "durable",
  segment: "preview", entries, final: false, historyComplete: true,
} as const;
const terminal = {
  type: "entries", sessionId: session.id, historySessionId: "durable",
  entries, final: true, historyComplete: false,
} as const;
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useChatSession>;
let handlers: Parameters<ChatConnector>[0];
let rowCounts: number[];
const deliver = (frame: ChatServerFrame) => act(() => handlers.onFrame(frame));
const ready = () => deliver({ type: "ready", sessionId: session.id, piSessionId: "durable", resumed: true });
const cursor = () => handlers.getHistoryResume?.();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
  rowCounts = [];
  const connect: ChatConnector = next => {
    handlers = next;
    next.onOpen?.();
    return { send: () => true, close: () => undefined };
  };
  function Probe() {
    state = useChatSession(session, connect);
    rowCounts.push(state.messages.length);
    return <>{state.messages.map(message => <p key={message.id} data-id={message.id}>{messageText(message)}</p>)}</>;
  }
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("renders parsed preview rows before ready without committing history or a resume cursor", () => {
  const frame = parseChatServerFrame(preview);
  if (!frame) throw new Error("preview was rejected by the wire parser");
  deliver(frame);
  expect(Array.from(container.querySelectorAll("p"), row => row.textContent)).toEqual(["one", "two"]);
  expect(state.historyStatus).toBe("loading");
  expect(state.historyLoaded).toBe(false);
  expect(state.historyRootKnown).toBe(false);
  expect(state.historyFailedEmpty).toBe(false);
  expect(state.restoreVersion).toBe(0);
  expect(cursor()).toBeUndefined();
});

it("keeps row keys and DOM nodes through ready, partial pages, and the terminal commit", () => {
  deliver(preview);
  const rows = Array.from(container.querySelectorAll("p"));
  rowCounts = [];
  ready();
  deliver({ ...terminal, entries: [entry("one")], final: false });
  expect(cursor()).toBeUndefined();
  expect(state.messages.map(message => message.id)).toEqual(["one", "two"]);
  deliver({ ...terminal, entries: [entry("two"), entry("three")] });
  expect(state.messages.map(message => message.id)).toEqual(["one", "two", "three"]);
  expect(container.querySelectorAll("p")[0]).toBe(rows[0]);
  expect(container.querySelectorAll("p")[1]).toBe(rows[1]);
  expect(rowCounts.every(count => count >= 2)).toBe(true);
  expect(state.historyStatus).toBe("loaded");
  expect(cursor()).toEqual({
    sessionId: "durable", firstEntryId: "one", lastEntryId: "three", historyComplete: false,
  });
});

it("replaces preview-only entries instead of adding them to the terminal or its cursor", () => {
  deliver({ ...preview, entries: [entry("stale")] });
  ready();
  deliver(terminal);
  expect(state.messages.map(message => message.id)).toEqual(["one", "two"]);
  expect(cursor()).toEqual({
    sessionId: "durable", firstEntryId: "one", lastEntryId: "two", historyComplete: false,
  });
});

it.each([false, true])("ignores preview after a committed terminal (empty=%s)", empty => {
  ready();
  deliver({ ...terminal, entries: empty ? [] : entries });
  const committed = state.messages;
  const committedCursor = cursor();
  deliver({ ...preview, entries: [entry("ignored")] });
  expect(state.messages).toBe(committed);
  expect(cursor()).toBe(committedCursor);
  expect(state.historyStatus).toBe("loaded");
});

it("ignores preview after reconnect while retaining committed resume coverage", () => {
  ready();
  deliver(terminal);
  const committed = state.messages;
  const committedCursor = cursor();
  act(() => { handlers.onClose?.(1006); handlers.onOpen?.(); });
  deliver({ ...preview, entries: [entry("ignored")] });
  expect(state.messages).toBe(committed);
  expect(state.historyStatus).toBe("loading");
  expect(cursor()).toBe(committedCursor);
});

it.each(["open", "close"])("discards uncommitted preview on mark%s", lifecycle => {
  deliver(preview);
  act(() => {
    if (lifecycle === "open") handlers.onOpen?.();
    else handlers.onClose?.(1006);
  });
  expect(state.messages).toEqual([]);
  expect(container.querySelectorAll("p")).toHaveLength(0);
  expect(cursor()).toBeUndefined();
  expect(state.historyFailedEmpty).toBe(false);
});

it("discards preview on beginResync without promoting it to committed messages", () => {
  let frameState: ReturnType<typeof useChatFrameState> | undefined;
  function FrameProbe() { frameState = useChatFrameState(); return null; }
  act(() => root.render(<FrameProbe />));
  const current = () => {
    if (!frameState) throw new Error("frame probe never rendered");
    return frameState;
  };
  let generation = 0;
  act(() => { generation = current().markOpen(); });
  act(() => current().handleFrame(preview, generation));
  expect(current().messages.map(message => message.id)).toEqual(["one", "two"]);
  act(() => current().beginResync());
  expect(current().messages).toEqual([]);
  expect(current().historyStatus).toBe("loading");
  expect(current().getHistoryResume()).toBeUndefined();
});

it.each([
  { code: "incomplete_history" },
  { code: "initialize_failed" },
  { code: "start_failed" },
  { code: "provider_timeout" },
  { code: "provider_error", command: "get_entries" },
  { code: "session-active" },
  { code: "external-write-detected" },
])("clears preview and exposes failed empty history on $code $command", error => {
  deliver(preview);
  deliver({ type: "error", sessionId: session.id, message: "history failed", ...error });
  expect(state.messages).toEqual([]);
  expect(container.querySelectorAll("p")).toHaveLength(0);
  expect(state.historyFailedEmpty).toBe(true);
  expect(state.historyStatus).toBe("failed");
  expect(cursor()).toBeUndefined();
  deliver(preview);
  expect(state.messages).toEqual([]);
});

it("ignores orphan head pages during preview so they cannot become committed history", () => {
  deliver(preview);
  deliver({ ...terminal, segment: "head", final: false, entries: [entry("orphan")] });
  expect(state.messages.map(message => message.id)).toEqual(["one", "two"]);
  expect(cursor()).toBeUndefined();
  deliver({ ...terminal, entries: [entry("authoritative")] });
  expect(state.messages.map(message => message.id)).toEqual(["authoritative"]);
});

it("retries terminal preview failure even while running and compacting", () => {
  deliver(preview);
  deliver({ type: "state", sessionId: session.id, isStreaming: true, isCompacting: true });
  deliver({ type: "error", sessionId: session.id, code: "incomplete_history", message: "history failed" });
  act(() => state.retryHistory());
  expect(state.historyStatus).toBe("loading");
  expect(state.resyncBusy).toBe(true);
  expect(state.messages).toEqual([]);
  expect(cursor()).toBeUndefined();
});
