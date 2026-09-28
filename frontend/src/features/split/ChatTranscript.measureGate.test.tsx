import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "./useChatFrameState";
import { ChatTranscript } from "./ChatTranscript";

// Measurement-gated paint contract: rows measure much taller than their
// frozen estimates (markdown and tool cards in a real session), which used to
// re-flow the window right after the first paint (live QA: rendered/visible
// rows 19/10 -> 12/4 at open, 10 -> 6 on prepends). The history layer must
// stay visually hidden until the rendered window reports real measurements
// and the tail pin / prepend anchor has been applied, so the first COMMITTED
// VISIBLE frame is already the measured layout: the last row sits at the
// bottom at open, no visible frame shows unmeasured (estimated) rows, and a
// prepend keeps the reader's anchor while doing the same.
//
// jsdom observation limits: the Probe parent's layout effect re-runs only on
// Probe's own renders, while the settle gate's verification/reveal commits
// re-render ChatTranscript alone — those transitions are captured by a
// MutationObserver on the history layer's class (oldValue per mutation), and
// the post-act() DOM is exactly the reveal commit's paint: the gate reveals
// once, with no further internal setState pending.
const observed = vi.hoisted(() => ({ current: undefined as Virtualizer<Element, Element> | undefined }));
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

// Real rows render three times taller than the estimator predicts — the
// open-time correction the gate must hide.
const REAL_HEIGHT_FACTOR = 3;

interface FrameSample {
  readonly settling: boolean;
  readonly distance: number;
  readonly rendered: number;
  readonly tailInWindow: boolean;
  readonly unmeasured: number;
}

let container: HTMLDivElement;
let root: Root;
let samples: FrameSample[];
let settleRecords: Array<{ readonly hadClass: boolean }>;
let observer: MutationObserver | undefined;
let viewport: { width: number; height: number };
let originalScrollTo: typeof Element.prototype.scrollTo;

function message(id: string, prefix = "row"): TranscriptItem {
  return { kind: "message", message: { id, role: "user", blocks: [{ kind: "text", text: `${prefix} ${id}` }] } };
}

function history(count: number, prefix = "row"): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`, prefix));
}

function itemText(item: TranscriptItem): string {
  if (item.kind !== "message") return "";
  return (item.message.blocks ?? []).map((block) => block.text ?? block.thinking ?? "").join("\n");
}

function instance(): Virtualizer<Element, Element> {
  if (!observed.current) throw new Error("missing virtualizer");
  return observed.current;
}

function body(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!element) throw new Error("missing scrollport");
  return element;
}

function historyLayer(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>(".th-chat-history");
  if (!element) throw new Error("missing history layer");
  return element;
}

function isSettling(element: Element): boolean {
  return element.classList.contains("th-chat-history--settling");
}

// The parent layout effect runs after every ChatTranscript layout effect on
// the commits Probe itself takes part in, so each sample observes what that
// commit would paint. It also attaches the MutationObserver before the gate's
// verification commits can run — those commits re-render ChatTranscript
// alone, below Probe, and only the observer sees their settling transitions.
function Probe({ items }: { readonly items: readonly TranscriptItem[] }) {
  useLayoutEffect(() => {
    const layer = historyLayer();
    if (observer === undefined) {
      observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName !== "class") continue;
          settleRecords.push({ hadClass: (record.oldValue ?? "").includes("th-chat-history--settling") });
        }
      });
      observer.observe(layer, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    }
    const scrollport = body();
    const virtualItems = instance().getVirtualItems();
    const top = scrollport.scrollTop;
    samples.push({
      settling: isSettling(layer),
      distance: Math.max(0, scrollport.scrollHeight - scrollport.clientHeight - top),
      rendered: virtualItems.length,
      tailInWindow: virtualItems.some((item) => item.index === items.length - 1),
      unmeasured: virtualItems.filter((item) => !instance().itemSizeCache.has(item.key)).length,
    });
  });
  return (
    <ChatTranscript
      items={items}
      streaming=""
      thinking=""
      toolCalls={{}}
      doneReason={null}
      error=""
      restoreVersion={0}
      focused={false}
      historyLoaded
    />
  );
}

// The async act flushes the transcript's queued row-metrics read inside act
// (same discipline as the pinBeforePaint/prepend harnesses).
async function render(items: readonly TranscriptItem[]): Promise<void> {
  await act(async () => { root.render(<Probe items={items} />); });
}

// The post-act() DOM is the reveal commit's paint: the gate reveals once and
// nothing re-renders afterwards. Settling transitions may add the class only
// while hidden (an admission arms the gate after an empty mount showed the
// layer), must remove it exactly once, and must never re-hide after the
// reveal without a new admission.
function expectRevealedOnce(): void {
  let revealed = false;
  let removals = 0;
  for (const record of settleRecords) {
    if (record.hadClass) {
      removals += 1;
      revealed = true;
    } else {
      expect(revealed).toBe(false);
    }
  }
  expect(removals).toBe(1);
  expect(isSettling(historyLayer())).toBe(false);
}

// Following-reader tail contract for the settled DOM: every rendered row is
// measured and the viewport sits at the bottom with the last row in place.
function expectTailSettled(items: readonly TranscriptItem[]): void {
  const virtualItems = instance().getVirtualItems();
  expect(virtualItems.length).toBeGreaterThan(0);
  for (const item of virtualItems) {
    expect(instance().itemSizeCache.has(item.key)).toBe(true);
  }
  const scrollport = body();
  expect(scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop).toBe(0);
  expect(virtualItems.some((item) => item.index === items.length - 1)).toBe(true);
  const last = items[items.length - 1];
  if (last === undefined) throw new Error("empty history");
  expect([...container.querySelectorAll(".th-chat-row")]
    .some((row) => row.textContent === itemText(last))).toBe(true);
}

/** Where a rendered row sits inside the viewport right now. */
function viewportOffset(text: string): number {
  const row = [...container.querySelectorAll<HTMLDivElement>(".th-chat-row")]
    .find((node) => node.textContent === text);
  if (!row) throw new Error(`row "${text}" is not rendered`);
  const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
  if (!match) throw new Error(`row "${text}" carries no offset`);
  return Number(match[1]) - body().scrollTop;
}

function distanceFromBottom(): number {
  const scrollport = body();
  return scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockReturnValue(100);
  viewport = { width: 1280, height: 400 };
  const tops = new WeakMap<Element, number>();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewport.height);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewport.width);
  // Only the scrollport scrolls: its content height tracks the virtualized
  // total, exactly like a real scroll container's scrollHeight.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".th-chat-body") ? Math.round(instance().getTotalSize()) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
    return tops.get(this) ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, value: number) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    tops.set(this, Math.max(0, Math.min(value, max)));
  });
  originalScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === "number") (this as HTMLElement).scrollTop = options;
    else if (options && typeof options.top === "number") (this as HTMLElement).scrollTop = options.top;
  };
  // Real rows render far taller than the estimator's frozen prediction.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".th-chat-row")
      ? instance().options.estimateSize(Number(this.dataset["index"])) * REAL_HEIGHT_FACTOR
      : 400;
  });
  // Reconciliation frames are explicitly retained, never raced against
  // assertions (the library would otherwise re-target on wall-clock rAF).
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { frames.delete(key); });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  samples = [];
  settleRecords = [];
  observer = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  observer?.disconnect();
  act(() => root.unmount());
  container.remove();
  Element.prototype.scrollTo = originalScrollTo;
  observed.current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("paints the first visible frame of an admitted history only after rows are measured", async () => {
  const items = history(60);
  await render(items);
  // The mount commit paints hidden: the estimate layout with rows not yet
  // measured is exactly what the gate must suppress.
  const mount = samples[0]!;
  expect(mount.settling).toBe(true);
  expect(mount.rendered).toBeGreaterThan(0);
  expect(mount.unmeasured).toBeGreaterThan(0);
  expectRevealedOnce();
  expectTailSettled(items);
  // The browser echoes the pin write asynchronously; the window must not move.
  act(() => { body().dispatchEvent(new Event("scroll")); });
  expect(distanceFromBottom()).toBe(0);
});

it("never shows estimated positions when history admits after an empty mount", async () => {
  await render([]);
  expect(samples[0]!.rendered).toBe(0);
  expect(settleRecords.length).toBe(0);
  const items = history(60);
  await render(items);
  expect(samples[1]!.settling).toBe(true);
  expectRevealedOnce();
  expectTailSettled(items);
});

it("keeps the reader's anchor across a prepend, revealed only after measurement", async () => {
  const tail = history(60);
  await render(tail);
  expectRevealedOnce();
  expectTailSettled(tail);
  settleRecords = [];

  // The reader parks mid-history: wheel up and settle the gesture.
  const scrollport = body();
  act(() => { scrollport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })); });
  scrollport.scrollTop = 2000;
  act(() => { scrollport.dispatchEvent(new Event("scroll")); });
  act(() => { scrollport.dispatchEvent(new Event("scrollend")); });
  const parkedTop = scrollport.scrollTop;
  const parkedDistance = distanceFromBottom();
  expect(parkedDistance).toBeGreaterThan(0);
  // Anchor on the rows actually rendered at the parked window: everything
  // above the measured tail still carries estimates and is not mounted.
  const parkedOffsets = new Map<string, number>();
  for (const row of container.querySelectorAll<HTMLDivElement>(".th-chat-row")) {
    if (row.textContent !== null) parkedOffsets.set(row.textContent, viewportOffset(row.textContent));
  }
  expect(parkedOffsets.size).toBeGreaterThan(0);

  const prepended = [...history(3, "head"), ...tail];
  await render(prepended);

  // The prepend admitted with the layer hidden and revealed exactly once;
  // every retained row kept its exact viewport position while the viewport
  // moved down with the measured block.
  expect(samples[samples.length - 1]!.settling).toBe(true);
  expectRevealedOnce();
  expect(scrollport.scrollTop).toBeGreaterThan(parkedTop);
  expect(distanceFromBottom()).toBe(parkedDistance);
  const retained = [...container.querySelectorAll<HTMLDivElement>(".th-chat-row")]
    .map((row) => row.textContent ?? "");
  const anchored = retained.filter((text) => parkedOffsets.has(text));
  expect(anchored.length).toBeGreaterThan(0);
  for (const text of anchored) {
    expect(viewportOffset(text)).toBe(parkedOffsets.get(text));
  }
  for (const item of instance().getVirtualItems()) {
    expect(instance().itemSizeCache.has(item.key)).toBe(true);
  }
});
