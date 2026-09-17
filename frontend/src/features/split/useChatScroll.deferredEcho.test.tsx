import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatScroll, type ChatScrollState } from "./useChatScroll";

let container: HTMLDivElement;
let root: Root;
let state: ChatScrollState;
let body: HTMLDivElement;
let height: number;
let notifyResize: () => void;

function Harness() {
  state = useChatScroll(0, false);
  return <div ref={state.scrollRef} onScroll={state.onScroll}>
    <div ref={state.contentRef} />
    {state.showScrollToBottom && <button onClick={() => state.scrollToBottom()}>jump</button>}
  </div>;
}

function scrollTo(top: number, now: number): void {
  vi.mocked(performance.now).mockReturnValue(now);
  act(() => {
    body.scrollTop = top;
    body.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockReturnValue(100);
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
  const element = state.scrollRef.current;
  if (!element) throw new Error("missing hook scrollport");
  body = element;
  let top = 0;
  height = 6000;
  Object.defineProperties(body, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => {
      top = Math.max(0, Math.min(value, height - 400));
    } },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 400 },
  });
  act(() => notifyResize());
  expect(body.scrollTop).toBe(5600);
  scrollTo(5600, 100);
  height = 11000;
  act(() => notifyResize());
  expect(body.scrollTop).toBe(10600);
  expect(state.isRecentProgrammaticWrite(10600)).toBe(true);
  expect(state.isReaderInputActive()).toBe(false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("T1: keeps follow after an unowned deferred echo above the bottom", () => {
  expect(state.isRecentProgrammaticWrite(9000)).toBe(false);
  scrollTo(9000, 116);
  expect.soft(state.isFollowing()).toBe(true);
  expect.soft(container.querySelector("button")).toBeNull();
  expect.soft(state.isReaderInputActive()).toBe(false);
  height += 1000;
  act(() => notifyResize());
  expect(body.scrollTop).toBe(11600);
});

it("T2: two unowned deferred echoes cannot acquire reader ownership", () => {
  for (const [top, now] of [[9000, 116], [8800, 132]] as const) {
    expect(state.isRecentProgrammaticWrite(top)).toBe(false);
    scrollTo(top, now);
    expect.soft(state.isFollowing()).toBe(true);
    expect.soft(container.querySelector("button")).toBeNull();
    expect.soft(state.isReaderInputActive()).toBe(false);
  }
});

it("T4: reader momentum releases follow after physical grace expires", () => {
  scrollTo(10600, 100);
  act(() => {
    body.dispatchEvent(new TouchEvent("touchstart"));
    body.dispatchEvent(new TouchEvent("touchmove"));
  });
  vi.mocked(performance.now).mockReturnValue(101);
  act(() => body.dispatchEvent(new TouchEvent("touchend")));
  for (const [top, now] of [[10580, 200], [10570, 350]] as const) {
    scrollTo(top, now);
    expect(state.isFollowing()).toBe(true);
    expect(container.querySelector("button")).toBeNull();
  }
  scrollTo(10550, 501);
  // Attributed momentum renews grace beyond the original physical signal.
  expect(state.isReaderInputActive()).toBe(true);
  expect(state.isFollowing()).toBe(false);
  expect(container.querySelector("button")).not.toBeNull();
  height += 1000;
  act(() => notifyResize());
  expect(body.scrollTop).toBe(10550);
});

it("T5: a whole unowned motion chain never releases follow", () => {
  for (const [top, now] of [[9000, 116], [8800, 200], [8600, 350], [8400, 501], [8200, 700]] as const) {
    scrollTo(top, now);
    expect(state.isReaderInputActive()).toBe(false);
    expect(state.isFollowing()).toBe(true);
    expect(container.querySelector("button")).toBeNull();
  }
  height += 1000;
  act(() => notifyResize());
  expect(body.scrollTop).toBe(11600);
});

it("T3: active pointer scroll-up still revokes follow and exposes the jump control", () => {
  act(() => body.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 1, pointerType: "touch", buttons: 1, bubbles: true,
  })));
  for (const [top, now] of [[9000, 116], [8800, 132]] as const) {
    scrollTo(top, now);
    expect(state.isReaderInputActive()).toBe(true);
    expect(state.isFollowing()).toBe(false);
    expect(container.querySelector("button")).not.toBeNull();
  }
  height += 1000;
  act(() => notifyResize());
  expect(body.scrollTop).toBe(8800);
});
