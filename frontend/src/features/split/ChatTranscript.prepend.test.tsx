import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
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
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
    // The scrollport's content is the virtualized row area: it grows with the
    // list, exactly like a real scroll container's scrollHeight.
    scrollHeight: { configurable: true, get: () => Math.round(instance.getTotalSize()) },
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
