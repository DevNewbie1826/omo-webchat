import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { useChatFrameState } from "./useChatFrameState";
import { useChatScroll, type ChatScrollState } from "./useChatScroll";

let root: Root;
let state: ReturnType<typeof useChatFrameState>;
let generation: number;
let scroll: ChatScrollState;
let container: HTMLDivElement;
const entry = (id: string) => ({ type: "message", id, message: { role: "user", content: id } });
const deliver = (frame: ChatServerFrame) => act(() => state.handleFrame(frame, generation));
const page = (extra: Partial<Extract<ChatServerFrame, { type: "entries" }>> = {}) => deliver({
  type: "entries", sessionId: "s", historySessionId: "durable", entries: [entry("tail")],
  final: true, historyComplete: false, ...extra,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  container = document.createElement("div");
  root = createRoot(container);
  function Probe() {
    state = useChatFrameState();
    scroll = useChatScroll(state.restoreVersion, false, undefined, state.historyWarming);
    return <div ref={scroll.scrollRef} onScroll={scroll.onScroll}>
      <div ref={scroll.contentRef} />
      {scroll.showScrollToBottom && <button onClick={() => scroll.scrollToBottom()}>jump</button>}
    </div>;
  }
  act(() => root.render(<Probe />));
  act(() => { generation = state.markOpen(); });
  deliver({ type: "ready", sessionId: "s", resumed: true, piSessionId: "durable" });
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("warms from fresh attach through committed root, not merely the terminal tail", () => {
  expect(state.historyWarming).toBe(true);
  page({ final: false });
  expect(state.historyWarming).toBe(true);
  page();
  const restore = state.restoreVersion;
  expect(state.historyStatus).toBe("loaded");
  expect(state.historyWarming).toBe(true);
  page({ segment: "head", final: false, entries: [entry("middle")] });
  expect(state.historyWarming).toBe(true);
  page({ segment: "head", final: false, historyComplete: true, entries: [entry("root")] });
  expect(state.historyWarming).toBe(false);
  expect(state.restoreVersion).toBe(restore);
});

it.each([true, undefined])("ends warming on full/legacy terminal history (%s)", (historyComplete) => {
  const frame: Extract<ChatServerFrame, { type: "entries" }> = {
    type: "entries", sessionId: "s", entries: [], final: true,
    ...(historyComplete === undefined ? {} : { historyComplete }),
  };
  deliver(frame);
  expect(state.historyWarming).toBe(false);
});

it("does not re-arm on a resumed stream, even when more head history remains", () => {
  page();
  const resume = state.getHistoryResume()!;
  const restore = state.restoreVersion;
  act(() => { state.markClose(); generation = state.markOpen(); });
  expect(state.historyWarming).toBe(false);
  page({ resume, final: false, entries: [entry("suffix")] });
  expect(state.historyWarming).toBe(false);
  page({ resume, entries: [] });
  expect(state.historyWarming).toBe(false);
  expect(state.restoreVersion).toBe(restore);
  page({ segment: "head", final: false, entries: [entry("root")], historyComplete: true });
  expect(state.historyWarming).toBe(false);
});

it("re-arms when a resume falls back to fresh history", () => {
  page({ historyComplete: true });
  act(() => { state.markClose(); generation = state.markOpen(); });
  expect(state.historyWarming).toBe(false);
  page({ final: false, historySessionId: "replacement" });
  expect(state.historyWarming).toBe(true);
  page({ historySessionId: "replacement" });
  expect(state.historyWarming).toBe(true);
});

it.each(["incomplete_history", "provider_disconnected", "session_unloaded", "session-active", "external-write-detected"])(
  "ends the tail fill on %s", (code) => {
    page();
    deliver({ type: "error", sessionId: "s", code, message: "failed" });
    expect(state.historyWarming).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("ends warming on close and explicit recovery failures", () => {
  page();
  act(() => state.markClose());
  expect(state.historyWarming).toBe(false);
  act(() => state.beginResync());
  expect(state.historyWarming).toBe(true);
  act(() => state.failResync());
  expect(state.historyWarming).toBe(false);
  act(() => state.beginExternalWriteRecovery());
  expect(state.historyWarming).toBe(true);
  act(() => state.failExternalWriteRecovery());
  expect(state.historyWarming).toBe(false);
});

it("ends resync warming at its ready boundary and uses the committed tail for subsequent fill", () => {
  page({ historyComplete: true });
  act(() => state.beginResync());
  expect(state.historyWarming).toBe(true);
  deliver({ type: "ready", sessionId: "s", resumed: true, piSessionId: "durable" });
  expect(state.historyWarming).toBe(false);
  page();
  expect(state.historyWarming).toBe(true);
  page({ segment: "head", historyComplete: true, entries: [entry("root")] });
  expect(state.historyWarming).toBe(false);
});

it("quietly releases the post-tail hold when no head pages arrive", () => {
  const port = scroll.scrollRef.current!;
  Object.defineProperties(port, {
    scrollHeight: { value: 6000 },
    clientHeight: { value: 400 },
  });
  page();
  const messages = state.messages;
  const restore = state.restoreVersion;
  const navigate = () => act(() => {
    port.scrollTop = 3000;
    port.dispatchEvent(new Event("scroll"));
  });
  expect(state.historyWarming).toBe(true);
  expect(scroll.isReaderInputActive()).toBe(false);
  expect(scroll.isRecentProgrammaticWrite(3000)).toBe(false);
  navigate();
  expect(scroll.isFollowing()).toBe(true);
  expect(container.querySelector("button")).toBeNull();

  act(() => vi.advanceTimersByTime(30_001));
  expect.soft(state.historyWarming).toBe(false);
  expect(state.historyStatus).toBe("loaded");
  expect(state.messages).toBe(messages);
  expect(state.restoreVersion).toBe(restore);
  expect(state.error).toBe("");
  expect(state.notices).toEqual([]);
  navigate();
  expect.soft(scroll.isFollowing()).toBe(false);
  expect.soft(container.querySelector("button")).not.toBeNull();
});

it("refreshes the stall window on every accepted head page", () => {
  page();
  for (const id of ["middle", "earlier"]) {
    act(() => vi.advanceTimersByTime(19_000));
    page({ segment: "head", final: false, entries: [entry(id)] });
    act(() => vi.advanceTimersByTime(10_001));
    expect(state.historyWarming).toBe(true);
  }
  act(() => vi.advanceTimersByTime(20_000));
  expect(state.historyWarming).toBe(false);
  expect(state.historyStatus).toBe("loaded");
});

it("retires the pending head watchdog immediately at branch root", () => {
  page();
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(20_000));
  page({ segment: "head", historyComplete: true, entries: [entry("root")] });
  expect(state.historyWarming).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces the deadline on connection generation change without a close", () => {
  page();
  act(() => vi.advanceTimersByTime(20_000));
  act(() => { generation = state.markOpen(); });
  page({ historySessionId: "replacement" });
  act(() => vi.advanceTimersByTime(10_001));
  expect(state.historyWarming).toBe(true);
  act(() => vi.advanceTimersByTime(20_000));
  expect(state.historyWarming).toBe(false);
});

it("does not refresh on an orphan head before the terminal tail", () => {
  act(() => vi.advanceTimersByTime(20_000));
  page({ segment: "head", entries: [entry("orphan")] });
  act(() => vi.advanceTimersByTime(10_001));
  expect(state.historyWarming).toBe(false);
  expect(state.historyStatus).toBe("failed");
});

it("keeps late head progress from re-arming an expired hold", () => {
  page();
  act(() => vi.advanceTimersByTime(30_001));
  page({ segment: "head", entries: [entry("late")] });
  expect(state.historyWarming).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("retires the post-tail deadline on unmount", () => {
  page();
  act(() => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});

it("ends warming when history stalls", () => {
  act(() => vi.advanceTimersByTime(30_000));
  expect(state.historyStatus).toBe("failed");
  expect(state.historyWarming).toBe(false);
});
