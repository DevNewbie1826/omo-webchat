import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatTranscript, transcriptItemKeys } from "./ChatTranscript";
import { parseEntries } from "./chatEntries";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => ({
  current: undefined as Virtualizer<Element, Element> | undefined,
  outsideWindow: "",
}));
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
      const [options] = args;
      const instance = actual.useVirtualizer({
        ...options,
        rangeExtractor: (range) => (options.rangeExtractor ?? actual.defaultRangeExtractor)(range)
          .filter((index) => options.getItemKey?.(index) !== observed.outsideWindow),
      });
      observed.current = instance;
      return instance;
    },
  };
});

let container: HTMLDivElement;
let root: Root;
let originalScrollTo: typeof Element.prototype.scrollTo;
let heights: Map<string, number>;
let observers: Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>;
let scrollCeiling: number;

function instance() {
  if (!observed.current) throw new Error("missing virtualizer");
  return observed.current;
}

function body() {
  const element = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!element) throw new Error("missing scrollport");
  return element;
}

function rows(prefix: string, count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "message",
    message: { id: `${prefix}-${index}`, role: "user", blocks: [{ kind: "text", text: `${prefix}-${index}` }] },
  }));
}

async function render(items: readonly TranscriptItem[], loading: boolean | "error" = false) {
  await act(async () => {
    root.render(<ChatTranscript items={items} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded
      olderHistory={{ state: loading === "error" ? "error" : loading ? "loading" : "idle", loadOlder: () => undefined }} />);
  });
}

function row(key: string) {
  const element = [...container.querySelectorAll<HTMLElement>(".th-chat-row")]
    .find((node) => node.dataset["entryKey"] === key);
  if (!element) throw new Error(`missing row ${key}`);
  return element;
}

function offset(element: HTMLElement): number {
  const origin = container.querySelector<HTMLElement>(".th-chat-history")?.offsetTop ?? 0;
  return origin + Number(/translateY\((-?[\d.]+)px\)/.exec(element.style.transform)?.[1] ?? 0) - body().scrollTop;
}

function firstVisible(): HTMLElement {
  const element = [...container.querySelectorAll<HTMLElement>(".th-chat-row")]
    .find((node) => offset(node) + node.offsetHeight > 0 && offset(node) < 400);
  if (!element) throw new Error(`missing visible row: top=${body().scrollTop}, offset=${instance().scrollOffset}, rows=${[...container.querySelectorAll<HTMLElement>(".th-chat-row")].map((node) => `${node.dataset["entryKey"]}:${offset(node)}`).join(",")}`);
  return element;
}

function park(top: number) {
  act(() => {
    body().dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    body().scrollTop = top;
    body().dispatchEvent(new Event("scroll"));
    body().dispatchEvent(new Event("scrollend"));
  });
}

async function grow(element: HTMLElement, delta: number) {
  const key = instance().options.getItemKey(Number(element.dataset["index"]));
  heights.set(String(key), element.offsetHeight + delta);
  await act(async () => {
    for (const [observer, { callback, targets }] of observers) {
      if (!targets.has(element)) continue;
      callback([{
        target: element,
        contentRect: new DOMRect(0, 0, 800, element.offsetHeight),
        borderBoxSize: [{ inlineSize: 800, blockSize: element.offsetHeight }],
        contentBoxSize: [{ inlineSize: 800, blockSize: element.offsetHeight }],
        devicePixelContentBoxSize: [],
      }], observer);
    }
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
  vi.spyOn(performance, "now").mockReturnValue(100);
  heights = new Map();
  scrollCeiling = Infinity;
  observed.outsideWindow = "";
  observers = new Map();
  const tops = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  // Unlike a cache-derived scrollHeight, this sizer lags until React commits.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number.parseFloat(this.querySelector<HTMLElement>(".th-chat-history")?.style.height ?? "0");
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return tops.get(this) ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) {
    tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight, scrollCeiling)));
  });
  originalScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    this.scrollTop = typeof options === "number" ? options : options?.top ?? this.scrollTop;
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.matches(".th-chat-row")) return 400;
    const index = Number(this.dataset["index"]);
    return heights.get(String(instance().options.getItemKey(index))) ?? instance().options.estimateSize(index) * 3;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.matches(".th-chat-row") ? offset(this) : 0, 800, this.offsetHeight);
  });
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observers.set(this, { callback, targets: new Set() }); }
    observe(target: Element) { observers.get(this)?.targets.add(target); }
    unobserve(target: Element) { observers.get(this)?.targets.delete(target); }
    disconnect() { observers.delete(this); }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Element.prototype.scrollTo = originalScrollTo;
  observed.current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps client row identity when idless rows are prepended", () => {
  const live: TranscriptItem = { kind: "message", message: { role: "assistant", blocks: [{ kind: "text", text: "live" }] } };
  const earlier: TranscriptItem = { kind: "message", message: { role: "user", blocks: [{ kind: "text", text: "earlier" }] } };
  expect(transcriptItemKeys([earlier, live])[1]).toBe(transcriptItemKeys([live])[0]);
});

it("measures a prepend at three times its estimate without moving or remounting retained rows", async () => {
  const tail = rows("tail", 60);
  await render(tail);
  park(2000);
  const anchor = firstVisible();
  const before = offset(anchor);
  const retained = [...container.querySelectorAll<HTMLElement>(".th-chat-row")];
  await render([...rows("head", 20), ...tail]);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
  for (const element of retained) {
    expect(row(element.dataset["entryKey"] ?? "")).toBe(element);
  }
  expect(container.querySelector(".th-chat-history--settling")).toBeNull();
  for (let index = 0; index < 20; index += 1) {
    expect(instance().itemSizeCache.get(`message:head-${index}`)).toBe(instance().options.estimateSize(index) * 3);
  }
});

it("keeps the following tail pinned after late row growth", async () => {
  await render(rows("tail", 60));
  const aboveTail = firstVisible();
  await grow(aboveTail, 350);
  expect(body().scrollHeight - body().clientHeight - body().scrollTop).toBeLessThan(4);
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
});

it("keeps the parked visible anchor fixed after late growth above it", async () => {
  await render(rows("tail", 60));
  park(2000);
  const anchor = firstVisible();
  const before = offset(anchor);
  const above = [...container.querySelectorAll<HTMLElement>(".th-chat-row")]
    .find((node) => offset(node) + node.offsetHeight <= 0);
  if (!above) throw new Error("missing row above anchor");
  await grow(above, 350);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
  expect(anchor.isConnected).toBe(true);
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});

it("preserves preview DOM nodes when terminal entries carry the same ids", async () => {
  const items = rows("tail", 12);
  await render(items);
  const retained = [...container.querySelectorAll<HTMLElement>(".th-chat-row")];
  await render(rows("tail", 12));
  for (const element of retained) expect(row(element.dataset["entryKey"] ?? "")).toBe(element);
});

it("measures a second prepend while the previous measured anchor remains armed", async () => {
  const tail = rows("tail", 60);
  await render(tail);
  park(2000);
  const anchor = firstVisible();
  const before = offset(anchor);
  const first = [...rows("head", 20), ...tail];
  await render(first);
  await render([...rows("earlier", 20), ...first]);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
  expect(row(anchor.dataset["entryKey"] ?? "")).toBe(anchor);
  for (let index = 0; index < 20; index += 1) {
    expect(instance().itemSizeCache.get(`message:earlier-${index}`)).toBe(instance().options.estimateSize(index) * 3);
  }
});

it.each([true, "error"] as const)("preserves the anchor when older chrome appears and disappears (%s)", async (status) => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/styles/chat-transcript.css", "utf8");
  document.head.append(style);
  // JSDOM has no layout engine. Model normal-flow displacement from the
  // shipped positioning rule, not from the expected result of this test.
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.matches(".th-chat-history")) return 0;
    const indicator = container.querySelector(".th-chat-history-loading, .th-chat-history-error");
    if (!indicator) return 0;
    const position = getComputedStyle(indicator).position;
    return position === "absolute" || position === "fixed" ? 0 : 31;
  });
  try {
    const tail = rows("tail", 60);
    await render(tail);
    park(2000);
    const anchor = firstVisible();
    const before = offset(anchor);
    await render(tail, status);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(offset(anchor)).toBe(before);
    await render(tail);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(offset(anchor)).toBe(before);
  } finally {
    style.remove();
  }
});

it("preserves the anchor when loading chrome disappears with the measured page", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".th-chat-history") && container.querySelector(".th-chat-history-loading") ? 40 : 0;
  });
  const tail = rows("tail", 60);
  await render(tail, true);
  park(2000);
  const anchor = firstVisible();
  const before = offset(anchor);
  await render([...rows("head", 20), ...tail]);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
  expect(row(anchor.dataset["entryKey"] ?? "")).toBe(anchor);
});

it("keeps the visible orphan result's key and DOM when its invocation arrives outside the window", async () => {
  const result = {
    type: "message", id: "result",
    message: { role: "toolResult", toolCallId: "lookup-1", toolName: "read", content: "kept output" },
  };
  const invocation = {
    type: "message", id: "invocation",
    message: { role: "assistant", content: [{ type: "toolCall", id: "lookup-1", name: "read" }] },
  };
  const tail = rows("tail", 60);
  const parsed = (entries: readonly unknown[]): TranscriptItem[] =>
    parseEntries(entries).map((message) => ({ kind: "message", message }));
  await render([...parsed([result]), ...tail]);
  park(0);
  const anchor = firstVisible();
  const before = offset(anchor);
  const key = anchor.dataset["entryKey"] ?? "";
  // A hundred mixed-height rows put the seam far outside the old window.
  const head = rows("head", 100);
  for (let index = 0; index < 100; index += 1) {
    heights.set(`message:head-${index}`, index % 3 === 0 ? 900 : 70);
  }
  const merged = [...head, ...parsed([invocation, result]), ...tail];
  await render(merged);
  expect(row(key)).toBe(anchor);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
  expect(anchor.textContent).toContain("read");
  expect(Number(anchor.dataset["index"])).toBe(100);
  expect(container.querySelector(".th-chat-history--settling")).toBeNull();
  // Re-parsing fresh entries must not revert the inherited presentation key.
  await render([...head, ...parsed(structuredClone([invocation, result])), ...tail]);
  expect(row(key)).toBe(anchor);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
});

it("restores the first visible row when the old seam is outside the mounted window", async () => {
  const tail = rows("tail", 100);
  await render(tail);
  park(4000);
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  expect(container.querySelector('[data-entry-key="message:tail-0"]')).toBeNull();
  const anchor = firstVisible();
  const key = anchor.dataset["entryKey"] ?? "";
  const before = offset(anchor);
  const retained = [...container.querySelectorAll<HTMLElement>(".th-chat-row")];
  const head = rows("head", 100);
  for (let index = 0; index < 100; index += 1) heights.set(`message:head-${index}`, index % 2 ? 70 : 900);
  await render([...head, ...tail]);
  expect(row(key)).toBe(anchor);
  expect(Math.abs(offset(anchor) - before)).toBeLessThan(4);
  for (const element of retained) expect(row(element.dataset["entryKey"] ?? "")).toBe(element);
});

it.each([true, false])("holds an out-of-window prepend until convergence or its frame budget (converges=%s)", async (converges) => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.mocked(window.cancelAnimationFrame).mockImplementation((id) => { frames.delete(id); });
  const tail = rows("tail", 100);
  await render(tail);
  park(4000);
  const anchor = firstVisible();
  const key = anchor.dataset["entryKey"] ?? "";
  const before = offset(anchor);
  // Model a window re-entry whose first scroll is clamped against the old
  // DOM sizer. The real virtualizer must remount and measure the anchor.
  observed.outsideWindow = key;
  scrollCeiling = body().scrollTop + 100;
  const prepended = [...rows("head", 100), ...tail];
  await render(prepended);
  expect(anchor.isConnected).toBe(false);
  expect(container.querySelector(".th-chat-history--settling")).not.toBeNull();

  let revealed = false;
  for (let frame = 1; frame <= 6; frame += 1) {
    if (converges && frame === 1) observed.outsideWindow = "";
    if (converges && frame === 2) {
      scrollCeiling = Infinity;
    }
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(100 + frame * 16);
    });
    const hidden = container.querySelector(".th-chat-history--settling") !== null;
    if (converges && frame === 1) {
      expect(row(key).isConnected).toBe(true);
      expect(Math.abs(offset(row(key)) - before)).toBeGreaterThan(1);
      expect(hidden).toBe(true);
    }
    if (!hidden) {
      revealed = true;
      if (converges) {
        expect(row(key).isConnected).toBe(true);
        expect(Math.abs(offset(row(key)) - before)).toBeLessThanOrEqual(1);
      } else {
        expect(frame).toBe(6);
      }
      break;
    }
  }
  expect(revealed).toBe(true);
});
