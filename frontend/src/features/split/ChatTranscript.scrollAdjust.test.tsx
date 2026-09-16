import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChatTranscript } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => {
  const state: { current?: Virtualizer<Element, Element> } = {};
  // JSDOM needs the browser capability which Chromium supplies in the real-App test.
  Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
  return state;
});
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
      const instance = actual.useVirtualizer(...args);
      observed.current = instance;
      return instance;
    },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(100);
});
afterEach(() => vi.restoreAllMocks());

// 15 rows: the test ResizeObserver polyfill measures every rendered row at
// 768px and the whole list fits the initial window plus overscan, so every
// row is measured at mount and no later render can produce surprise
// first-measurement corrections. Row 0 starts at 0 with a measured size of
// 768 and stays entirely above the fold for every parked offset used below —
// its re-measurement therefore drives virtual-core's real
// resizeItem -> applyScrollAdjustment -> scrollToFn correction path, exactly
// as a genuine DOM measurement would. Total size: 15 * 768 = 11520.
const ROW_COUNT = 15;
const SCROLL_HEIGHT = 11520;
const CLIENT_HEIGHT = 400;

function makeItems(): TranscriptItem[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    kind: "message",
    message: { id: `m-${index}`, role: "user", blocks: [{ kind: "text", text: `row ${index}` }] },
  }));
}

interface Harness {
  readonly container: HTMLDivElement;
  readonly root: Root;
  readonly body: HTMLDivElement;
  readonly instance: Virtualizer<Element, Element>;
  getTop: () => number;
  setTop: (value: number) => void;
}

function mountTranscript(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ChatTranscript items={makeItems()} streaming="" thinking="" toolCalls={{}}
    doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />));
  const body = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!body) throw new Error("missing transcript scroll owner");
  const instance = observed.current;
  if (!instance) throw new Error("missing virtualizer instance");
  let top = 0;
  Object.defineProperties(body, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
    scrollHeight: { configurable: true, value: SCROLL_HEIGHT },
    clientHeight: { configurable: true, value: CLIENT_HEIGHT },
    scrollTo: {
      configurable: true,
      value: (options?: { top?: number }) => {
        if (options && typeof options.top === "number") top = options.top;
      },
    },
  });
  return {
    container,
    root,
    body,
    instance,
    getTop: () => top,
    setTop: (value: number) => { top = value; },
  };
}

function unmount(h: Harness): void {
  act(() => h.root.unmount());
  h.container.remove();
  delete observed.current;
}

function dispatchScroll(h: Harness): void {
  act(() => {
    h.body.dispatchEvent(new Event("scroll"));
  });
}

function dispatchScrollend(h: Harness): void {
  act(() => {
    h.body.dispatchEvent(new Event("scrollend"));
  });
}

/** Park the reader at a settled offset: scroll there, gesture ends. */
function park(h: Harness, offset: number): void {
  h.setTop(offset);
  dispatchScroll(h);
  dispatchScrollend(h);
  expect(h.instance.isScrolling).toBe(false);
}

/** Begin a user gesture that lands on `offset` and stays in flight. */
function beginGesture(h: Harness, offset: number): void {
  h.setTop(offset);
  dispatchScroll(h);
  expect(h.instance.isScrolling).toBe(true);
}

/** A real measurement: resize row `index` by `delta` through virtual-core. */
function resizeBy(h: Harness, index: number, delta: number): void {
  const measurement = h.instance.measurementsCache[index];
  if (!measurement) throw new Error(`missing measurement for row ${index}`);
  act(() => {
    h.instance.resizeItem(index, measurement.size + delta);
  });
}

it("keeps follow after explicit row positioning and growth before its notification", () => {
  const h = mountTranscript();
  try {
    Object.defineProperty(h.body, "scrollHeight", {
      configurable: true,
      get: () => Math.round(h.instance.getTotalSize()),
    });
    h.setTop(5000);
    act(() => h.instance.scrollToIndex(ROW_COUNT - 1, { align: "end" }));
    expect(h.getTop()).toBe(SCROLL_HEIGHT - CLIENT_HEIGHT);
    resizeBy(h, ROW_COUNT - 1, 100);
    expect(h.body.scrollHeight).toBe(SCROLL_HEIGHT + 100);
    expect(h.getTop()).toBe(SCROLL_HEIGHT - CLIENT_HEIGHT);
    dispatchScroll(h);
    expect(h.container.querySelector(".th-chat-scroll-bottom")).toBeNull();
  } finally {
    unmount(h);
  }
});

it.each(["jump", "restore", "focus"])("hands ownership to explicit %s without scrollend before a growing-content echo", (transition) => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const h = mountTranscript();
  try {
    Object.defineProperties(h.body, {
      scrollHeight: { configurable: true, get: () => Math.round(h.instance.getTotalSize()) },
      scrollTop: {
        configurable: true, get: h.getTop,
        set: (value: number) => h.setTop(Math.max(0, Math.min(value, h.body.scrollHeight - CLIENT_HEIGHT))),
      },
    });
    act(() => h.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000 })));
    beginGesture(h, 1000);
    const button = h.container.querySelector<HTMLButtonElement>(".th-chat-scroll-bottom");
    if (!button) throw new Error("missing jump control");
    vi.mocked(performance.now).mockReturnValue(150);
    if (transition === "jump") act(() => button.click());
    else act(() => h.root.render(<ChatTranscript items={makeItems()} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={transition === "restore" ? 1 : 0}
      focused={transition === "focus"} historyLoaded />));
    expect(h.getTop()).toBe(11120);
    expect(h.container.querySelector(".th-chat-scroll-bottom")).toBeNull();
    resizeBy(h, ROW_COUNT - 1, 100);
    expect(h.body.scrollHeight).toBe(11620);
    expect(h.getTop()).toBe(11120);
    vi.mocked(performance.now).mockReturnValue(160);
    dispatchScroll(h);
    expect(h.container.querySelector(".th-chat-scroll-bottom")).toBeNull();
    act(() => h.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
    h.body.scrollTop = 11020;
    dispatchScroll(h);
    expect(h.container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  } finally {
    unmount(h);
  }
});

it("applies a measurement correction immediately when no gesture is in flight", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    resizeBy(h, 0, 20);
    // Settled: virtual-core hands the current offset plus the per-call delta.
    expect(h.getTop()).toBe(1020);
  } finally {
    unmount(h);
  }
});

it("replays equal corrections exactly once each when the gesture ends", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    beginGesture(h, 1050);
    resizeBy(h, 0, 20);
    resizeBy(h, 0, 20);
    // Nothing is written while the gesture is in flight.
    expect(h.getTop()).toBe(1050);
    dispatchScrollend(h);
    // 1050 + 20 + 20: each delta applies exactly once.
    expect(h.getTop()).toBe(1090);
  } finally {
    unmount(h);
  }
});

it("replays increasing corrections exactly once each when the gesture ends", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    beginGesture(h, 1050);
    resizeBy(h, 0, 20);
    resizeBy(h, 0, 35);
    expect(h.getTop()).toBe(1050);
    dispatchScrollend(h);
    // 1050 + 20 + 35: the second delta is 35, not 35 - 20.
    expect(h.getTop()).toBe(1105);
  } finally {
    unmount(h);
  }
});

it("replays mixed-sign corrections exactly once each when the gesture ends", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    beginGesture(h, 1050);
    resizeBy(h, 0, -10);
    resizeBy(h, 0, 30);
    expect(h.getTop()).toBe(1050);
    dispatchScrollend(h);
    // 1050 - 10 + 30.
    expect(h.getTop()).toBe(1070);
  } finally {
    unmount(h);
  }
});

it("keeps every delta across an intervening observed scroll", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    beginGesture(h, 1050);
    resizeBy(h, 0, 20);
    // The gesture continues: an observed scroll event lands between the two
    // corrections (virtual-core resets its internal adjustment counter here).
    h.setTop(1100);
    dispatchScroll(h);
    expect(h.instance.isScrolling).toBe(true);
    resizeBy(h, 0, 35);
    expect(h.getTop()).toBe(1100);
    dispatchScrollend(h);
    // 1100 + 20 + 35: the correction before the scroll event is not lost.
    expect(h.getTop()).toBe(1155);
  } finally {
    unmount(h);
  }
});

it("replays each gesture's corrections exactly once across successive gestures", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    beginGesture(h, 1050);
    resizeBy(h, 0, 20);
    dispatchScrollend(h);
    expect(h.getTop()).toBe(1070);
    beginGesture(h, 1120);
    resizeBy(h, 0, 35);
    dispatchScrollend(h);
    // 1120 + 35: the second gesture's delta is not diffed against the first.
    expect(h.getTop()).toBe(1155);
  } finally {
    unmount(h);
  }
});

it("leaves no queued replay after the scroll-to-bottom button is clicked", () => {
  const h = mountTranscript();
  try {
    park(h, 1000);
    beginGesture(h, 1050);
    // A negative correction (row shrank by 100) is queued mid-gesture.
    resizeBy(h, 0, -100);
    expect(h.getTop()).toBe(1050);
    const button = h.container.querySelector<HTMLButtonElement>("button.th-chat-scroll-bottom");
    if (!button) throw new Error("missing scroll-to-bottom button");
    act(() => {
      button.click();
    });
    // Explicit intent: the viewport jumps to the end...
    expect(h.getTop()).toBe(SCROLL_HEIGHT);
    dispatchScrollend(h);
    // ...and the queued -100 replay must NOT drag it back off the bottom.
    expect(h.getTop()).toBe(SCROLL_HEIGHT);
  } finally {
    unmount(h);
  }
});
