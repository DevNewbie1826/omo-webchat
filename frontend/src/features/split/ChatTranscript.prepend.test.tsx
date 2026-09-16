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
let notifyContentResize: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockReturnValue(100);
  notifyContentResize = undefined;
  const OriginalResizeObserver = ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends OriginalResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) { super(callback); }
    override observe(target: Element, options?: ResizeObserverOptions): void {
      if (target.matches(".th-chat-content")) notifyContentResize = () => this.callback([], this);
      super.observe(target, options);
    }
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Same geometry as the scroll-adjust harness: the test ResizeObserver measures
// every rendered row at 768px, so 15 tail rows total 11520. Unlike that
// harness, scrollHeight tracks the real content height — a prepend grows it,
// which is exactly what the reader's distance from the bottom is measured
// against.
const ROW_HEIGHT = 768;
const TAIL_ROWS = 15;
const TAIL_HEIGHT = ROW_HEIGHT * TAIL_ROWS;
const CLIENT_HEIGHT = 400;

function rows(prefix: string, count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "message",
    message: { id: `${prefix}-${index}`, role: "user", blocks: [{ kind: "text", text: `${prefix} row ${index}` }] },
  }));
}

interface Harness {
  readonly container: HTMLDivElement;
  readonly root: Root;
  readonly body: HTMLDivElement;
  readonly instance: Virtualizer<Element, Element>;
  render: (items: readonly TranscriptItem[]) => void;
  getTop: () => number;
  setTop: (value: number) => void;
}

function mountTranscript(items: readonly TranscriptItem[]): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: readonly TranscriptItem[]): void => {
    act(() => root.render(<ChatTranscript items={next} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />));
  };
  render(items);
  const body = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!body) throw new Error("missing transcript scroll owner");
  const instance = observed.current;
  if (!instance) throw new Error("missing virtualizer instance");
  let top = 0;
  Object.defineProperties(body, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => {
      top = Math.max(0, Math.min(value, Math.round(instance.getTotalSize()) - CLIENT_HEIGHT));
    } },
    // The scrollport's content is the virtualized row area: it grows with the
    // list, exactly like a real scroll container's scrollHeight.
    scrollHeight: { configurable: true, get: () => Math.round(instance.getTotalSize()) },
    clientHeight: { configurable: true, value: CLIENT_HEIGHT },
    scrollTo: {
      configurable: true,
      value: (options?: { top?: number }) => {
        if (options && typeof options.top === "number") body.scrollTop = options.top;
      },
    },
  });
  return {
    container,
    root,
    body,
    instance,
    render,
    getTop: () => top,
    setTop: (value: number) => { top = value; },
  };
}

function unmount(h: Harness): void {
  act(() => h.root.unmount());
  h.container.remove();
  delete observed.current;
}

/** Park the reader at a settled offset: scroll there, gesture ends. */
function park(h: Harness, offset: number): void {
  h.setTop(offset);
  act(() => h.body.dispatchEvent(new Event("scroll")));
  act(() => h.body.dispatchEvent(new Event("scrollend")));
  expect(h.instance.isScrolling).toBe(false);
}

/** The reader's distance from the end of the content — the invariant a warm
 * chunk landing above them must not change. */
function distanceFromBottom(h: Harness): number {
  return h.body.scrollHeight - h.body.scrollTop - h.body.clientHeight;
}

/** Where a rendered row sits inside the viewport right now. */
function viewportOffset(h: Harness, text: string): number {
  const row = [...h.container.querySelectorAll<HTMLDivElement>(".th-chat-row")]
    .find((node) => node.textContent === text);
  if (!row) throw new Error(`row "${text}" is not rendered`);
  const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
  if (!match) throw new Error(`row "${text}" carries no offset`);
  return Number(match[1]) - h.getTop();
}

it("keeps the reader's distance from the bottom when a warm chunk prepends", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const parkedDistance = distanceFromBottom(h);
    const parkedRow = viewportOffset(h, "tail row 1");
    expect(h.body.scrollHeight).toBe(TAIL_HEIGHT);

    h.render([...rows("head", 3), ...tail]);

    // The warm chunk added three measured rows above the reader...
    expect(h.body.scrollHeight).toBe(TAIL_HEIGHT + 3 * ROW_HEIGHT);
    // ...so the viewport moved down with them, and nothing under the reader
    // moved: same distance from the end, same row in the same place.
    expect(distanceFromBottom(h)).toBe(parkedDistance);
    expect(viewportOffset(h, "tail row 1")).toBe(parkedRow);
    expect(h.getTop()).toBe(1000 + 3 * ROW_HEIGHT);
  } finally {
    unmount(h);
  }
});

it("keeps that distance across successive warm chunks", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const parkedDistance = distanceFromBottom(h);
    const parkedRow = viewportOffset(h, "tail row 1");

    const first = [...rows("chunk-a", 2), ...tail];
    h.render(first);
    expect(distanceFromBottom(h)).toBe(parkedDistance);

    h.render([...rows("chunk-b", 4), ...first]);
    expect(distanceFromBottom(h)).toBe(parkedDistance);
    expect(viewportOffset(h, "tail row 1")).toBe(parkedRow);
    expect(h.getTop()).toBe(1000 + 6 * ROW_HEIGHT);
  } finally {
    unmount(h);
  }
});

it("holds the position the reader moved to between two warm chunks", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const first = [...rows("chunk-a", 2), ...tail];
    h.render(first);

    // The reader scrolls somewhere else: from here their own position is what
    // the next chunk has to hold.
    park(h, 4000);
    const movedDistance = distanceFromBottom(h);
    const movedRow = viewportOffset(h, "tail row 4");

    h.render([...rows("chunk-b", 3), ...first]);

    expect(distanceFromBottom(h)).toBe(movedDistance);
    expect(viewportOffset(h, "tail row 4")).toBe(movedRow);
    expect(h.getTop()).toBe(4000 + 3 * ROW_HEIGHT);
  } finally {
    unmount(h);
  }
});

it("leaves the viewport alone once the reader has scrolled into the warm history", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    h.render([...rows("head", 3), ...tail]);

    // The reader scrolls up into the warm chunk itself. The rows that settle
    // now are BELOW them, so nothing about the viewport may change — the
    // pre-chunk anchor, which sits further down, is no longer theirs.
    park(h, 0);
    const measurement = h.instance.measurementsCache[2];
    if (!measurement) throw new Error("missing measurement for the warm row");
    act(() => h.instance.resizeItem(2, measurement.size + 20));

    expect(h.getTop()).toBe(0);
  } finally {
    unmount(h);
  }
});

it("keeps compensating later warm chunks when a late echo of a programmatic write arrives between chunks", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const first = [...rows("chunk-a", 2), ...tail];
    h.render(first);
    expect(h.getTop()).toBe(1000 + 2 * ROW_HEIGHT);

    // A compensation echo starts the observed scroll interval. A tail-row
    // measurement queues a separate write, applied when that interval ends.
    act(() => h.body.dispatchEvent(new Event("scroll")));
    const tailRow = h.instance.measurementsCache[2];
    if (!tailRow) throw new Error("missing tail measurement");
    act(() => h.instance.resizeItem(2, tailRow.size + 20));
    act(() => h.body.dispatchEvent(new Event("scrollend")));
    const flushedTop = 1000 + 2 * ROW_HEIGHT + 20;
    expect(h.getTop()).toBe(flushedTop);

    // The flush's late echo differs from the anchor compensation's write.
    // Earlier warm rows can still settle while the next chunk arrives.
    act(() => h.body.dispatchEvent(new Event("scroll")));
    const warmRow = h.instance.measurementsCache[0];
    if (!warmRow) throw new Error("missing warm measurement");
    act(() => h.instance.resizeItem(0, warmRow.size + 30));
    expect(h.getTop()).toBe(flushedTop + 30);

    h.render([...rows("chunk-b", 3), ...first]);
    expect(h.getTop()).toBe(flushedTop + 30 + 3 * ROW_HEIGHT);
  } finally {
    unmount(h);
  }
});

it("retires the warm anchor when the reader wheels back to the initial top", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const first = [...rows("head", 3), ...tail];
    h.render(first);
    expect(h.getTop()).toBe(3304);

    act(() => h.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -3304 })));
    park(h, 0);
    const warmRow = h.instance.measurementsCache[2];
    if (!warmRow) throw new Error("missing warm measurement");
    act(() => h.instance.resizeItem(2, warmRow.size + 20));
    expect(h.getTop()).toBe(0);

    const visibleRow = viewportOffset(h, "head row 0");
    h.render([...rows("next", 2), ...first]);
    expect(h.getTop()).toBe(2 * ROW_HEIGHT);
    expect(viewportOffset(h, "head row 0")).toBe(visibleRow);
    expect(h.container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  } finally {
    unmount(h);
  }
});

it("keeps the warm anchor after a settled measurement correction echo", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const first = [...rows("chunk-a", 2), ...tail];
    h.render(first);
    expect(h.getTop()).toBe(2536);
    act(() => h.body.dispatchEvent(new Event("scroll")));
    act(() => h.body.dispatchEvent(new Event("scrollend")));
    expect(h.instance.isScrolling).toBe(false);

    const tailRow = h.instance.measurementsCache[2];
    if (!tailRow) throw new Error("missing tail measurement");
    act(() => h.instance.resizeItem(2, tailRow.size + 20));
    expect(h.getTop()).toBe(2556);
    act(() => h.body.dispatchEvent(new Event("scroll")));
    const warmRow = h.instance.measurementsCache[0];
    if (!warmRow) throw new Error("missing warm measurement");
    act(() => h.instance.resizeItem(0, warmRow.size + 30));
    expect(h.getTop()).toBe(2586);
    h.render([...rows("chunk-b", 3), ...first]);
    expect(h.getTop()).toBe(4890);
  } finally {
    unmount(h);
  }
});

it.each([true, false])("retires the warm anchor for an unreleased contact (pointer moves: %s)", async (moves) => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  const scroll = async (): Promise<void> => {
    await act(async () => { h.body.dispatchEvent(new Event("scroll")); });
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const callback of pending) callback(performance.now()); });
  };
  try {
    await act(async () => h.instance.scrollToIndex(TAIL_ROWS - 1, { align: "end" }));
    await scroll();
    expect(frames.size).toBe(0);
    park(h, 1000);
    const first = [...rows("head", 3), ...tail];
    h.render(first);
    expect(h.getTop()).toBe(3304);
    await scroll();
    act(() => h.body.dispatchEvent(new Event("scrollend")));
    h.render([...rows("next", 2), ...first]);
    expect(h.getTop()).toBe(4840);
    await scroll();
    act(() => h.body.dispatchEvent(new Event("scrollend")));
    act(() => h.body.dispatchEvent(new PointerEvent("pointerdown", { buttons: 1 })));
    for (const now of [450, 501]) {
      vi.mocked(performance.now).mockReturnValue(now);
      if (moves) act(() => h.body.dispatchEvent(new PointerEvent("pointermove", { buttons: 1 })));
    }
    h.body.scrollTop = 3304;
    await scroll();
    const warmRow = h.instance.measurementsCache[4];
    if (!warmRow) throw new Error("missing warm row straddling the reader");
    await act(async () => h.instance.resizeItem(4, warmRow.size + 20));
    expect(h.getTop()).toBe(3304);
    expect(h.container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  } finally {
    unmount(h);
  }
});

it.each(["outside release", "quiet resize"])("preserves a fresh warm anchor after %s", (transition) => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    if (transition === "outside release") {
      act(() => h.body.dispatchEvent(new PointerEvent("pointerdown", { buttons: 1, bubbles: true })));
      vi.mocked(performance.now).mockReturnValue(110);
      act(() => document.body.dispatchEvent(new PointerEvent("pointerup", { buttons: 0, bubbles: true })));
    }
    vi.mocked(performance.now).mockReturnValue(450);
    if (transition === "quiet resize") {
      const notify = notifyContentResize;
      if (!notify) throw new Error("missing content resize observer");
      act(() => notify());
    }
    h.render([...rows("head", 2), ...tail]);
    expect(h.getTop()).toBe(2536);
    if (transition === "outside release") {
      act(() => h.body.dispatchEvent(new PointerEvent("pointermove", { buttons: 0 })));
    }
    act(() => h.body.dispatchEvent(new Event("scroll")));
    const warmRow = h.instance.measurementsCache[0];
    if (!warmRow) throw new Error("missing warm row");
    act(() => h.instance.resizeItem(0, warmRow.size + 30));
    expect(h.getTop()).toBe(2566);
  } finally {
    unmount(h);
  }
});

it.each([[16, 1], [16, 30], [250, 30], [250.001, 30]] as const)(
  "quiet warm echoes preserve the anchor at gap=%s delta=%s", async (gap, delta) => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const tail = rows("tail", TAIL_ROWS);
    const h = mountTranscript(tail);
    const scroll = async (): Promise<void> => {
      await act(async () => { h.body.dispatchEvent(new Event("scroll")); });
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => { for (const callback of pending) callback(performance.now()); });
    };
    try {
      await act(async () => h.instance.scrollToIndex(TAIL_ROWS - 1, { align: "end" }));
      await scroll();
      expect(frames.size).toBe(0);
      park(h, 1000);
      vi.mocked(performance.now).mockReturnValue(450);
      h.render([...rows("head", 2), ...tail]);
      expect(h.getTop()).toBe(2536);
      await scroll();
      vi.mocked(performance.now).mockReturnValue(450 + gap);
      const first = h.instance.measurementsCache[0];
      if (!first) throw new Error("missing first warm row");
      await act(async () => h.instance.resizeItem(0, first.size + delta));
      expect(h.getTop()).toBe(2536 + delta);
      await scroll();
      const second = h.instance.measurementsCache[1];
      if (!second) throw new Error("missing second warm row");
      await act(async () => h.instance.resizeItem(1, second.size + 20));
      expect(h.getTop()).toBe(2556 + delta);
    } finally {
      unmount(h);
    }
  },
);

it.each([false, true])("fresh app writes cannot retire a new warm anchor (reader signal=%s)", async (seed) => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  const scroll = async (): Promise<void> => {
    await act(async () => { h.body.dispatchEvent(new Event("scroll")); });
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const callback of pending) callback(performance.now()); });
  };
  try {
    await act(async () => h.instance.scrollToIndex(TAIL_ROWS - 1, { align: "end" }));
    await scroll();
    expect(frames.size).toBe(0);
    if (seed) act(() => h.body.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 })));
    for (const at of [110, 126]) {
      vi.mocked(performance.now).mockReturnValue(at);
      const row = h.instance.measurementsCache[TAIL_ROWS - 1];
      if (!row) throw new Error("missing last tail row");
      await act(async () => h.instance.resizeItem(TAIL_ROWS - 1, row.size + 20));
      await act(async () => h.instance.scrollToIndex(TAIL_ROWS - 1, { align: "end" }));
      await scroll();
    }
    expect(h.getTop()).toBe(11160);
    vi.mocked(performance.now).mockReturnValue(400.001);
    h.render([...rows("head", 2), ...tail]);
    expect(h.getTop()).toBe(11294);
    await scroll();
    const row = h.instance.measurementsCache[0];
    if (!row) throw new Error("missing warm row");
    await act(async () => h.instance.resizeItem(0, row.size + 30));
    expect(h.getTop()).toBe(11324);
  } finally {
    unmount(h);
  }
});

it("buttonless hover repairs a missing release before a quiet 500ms warm echo", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    act(() => h.body.dispatchEvent(new PointerEvent("pointerdown", {
      pointerType: "mouse", pointerId: 1, buttons: 1, bubbles: true,
    })));
    vi.mocked(performance.now).mockReturnValue(450);
    act(() => h.body.dispatchEvent(new PointerEvent("pointermove", {
      pointerType: "mouse", pointerId: 1, buttons: 0, bubbles: true,
    })));
    act(() => h.body.dispatchEvent(new Event("scrollend")));
    h.render([...rows("head", 2), ...tail]);
    expect(h.getTop()).toBe(2536);
    vi.mocked(performance.now).mockReturnValue(950);
    act(() => h.body.dispatchEvent(new Event("scroll")));
    const row = h.instance.measurementsCache[0];
    if (!row) throw new Error("missing warm row");
    act(() => h.instance.resizeItem(0, row.size + 30));
    expect(h.getTop()).toBe(2566);
  } finally {
    unmount(h);
  }
});

it("still corrects a measured row above the reader that is not a warm chunk", () => {
  const tail = rows("tail", TAIL_ROWS);
  const h = mountTranscript(tail);
  try {
    park(h, 1000);
    const measurement = h.instance.measurementsCache[0];
    if (!measurement) throw new Error("missing measurement for the first row");
    act(() => h.instance.resizeItem(0, measurement.size + 20));
    expect(h.getTop()).toBe(1020);
  } finally {
    unmount(h);
  }
});
