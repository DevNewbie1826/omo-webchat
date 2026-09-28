import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "./useChatFrameState";
import { ChatTranscript } from "./ChatTranscript";

// Open-time flicker contract: the first committed paint of a mounted history
// is already the tail window — the rendered virtual window contains the last
// row, the DOM rows include it, and the viewport sits at the bottom — and the
// rendered/visible row counts never decrease across mount frames. Restores the
// pin-before-paint assertions of the deleted ChatTranscript.releaseOrdering
// test: that test's historyWarming prop died with the fill-hold machinery, but
// the ordering contract (the viewport is already at the bottom in the layout
// phase of the admission commit) is behavior that still exists.
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

interface FrameSample {
  readonly distance: number;
  readonly rendered: number;
  readonly visible: number;
  readonly tailInWindow: boolean;
}

let container: HTMLDivElement;
let root: Root;
let samples: FrameSample[];
let viewport: { width: number; height: number };
let originalScrollTo: typeof Element.prototype.scrollTo;

function message(id: string): TranscriptItem {
  return { kind: "message", message: { id, role: "user", blocks: [{ kind: "text", text: id }] } };
}

function history(count: number, prefix = "row"): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`));
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

// The parent layout effect runs after every ChatTranscript layout effect, so
// each sample observes exactly what the current commit would paint: the
// virtual window, the DOM rows, and the viewport position, all before the
// browser can paint the frame.
function Probe({ items }: { readonly items: readonly TranscriptItem[] }) {
  useLayoutEffect(() => {
    const scrollport = body();
    const virtualItems = instance().getVirtualItems();
    const top = scrollport.scrollTop;
    const viewportBottom = top + scrollport.clientHeight;
    const last = items[items.length - 1];
    samples.push({
      distance: Math.max(0, scrollport.scrollHeight - scrollport.clientHeight - top),
      rendered: virtualItems.length,
      visible: virtualItems.filter((item) => item.start < viewportBottom && item.end > top).length,
      tailInWindow: last !== undefined && virtualItems.some((item) => item.index === items.length - 1),
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
// (same discipline as the prepend/follow-intent harnesses).
async function render(items: readonly TranscriptItem[]): Promise<void> {
  await act(async () => { root.render(<Probe items={items} />); });
}

function firstPopulatedSample(): FrameSample {
  const sample = samples.find((entry) => entry.rendered > 0);
  if (!sample) throw new Error("no populated frame sample");
  return sample;
}

function expectMonotonicWindow(): void {
  const populated = samples.filter((entry) => entry.rendered > 0);
  for (let index = 1; index < populated.length; index += 1) {
    expect(populated[index]!.rendered).toBeGreaterThanOrEqual(populated[index - 1]!.rendered);
    expect(populated[index]!.visible).toBeGreaterThanOrEqual(populated[index - 1]!.visible);
  }
}

// act() has flushed every paint-bound update, so the DOM now holds exactly
// what the browser would have painted.
function expectLastRowPainted(items: readonly TranscriptItem[]): void {
  const last = items[items.length - 1];
  if (last === undefined) throw new Error("empty history");
  expect([...container.querySelectorAll(".th-chat-row")]
    .some((row) => row.textContent === itemText(last))).toBe(true);
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
  // Rows measure exactly their frozen estimate: geometry stays deterministic
  // and no later resize correction can perturb the window.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".th-chat-row") ? instance().options.estimateSize(Number(this.dataset["index"])) : 400;
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
  container = document.createElement("div");
  document.body.appendChild(container);
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

it("mounts a held history bottom-pinned at the first paint", async () => {
  const items = history(60);
  await render(items);
  const first = firstPopulatedSample();
  expect(first.distance).toBe(0);
  expect(first.tailInWindow).toBe(true);
  expectLastRowPainted(items);
  // The browser echoes the pin write asynchronously; the window must not move.
  act(() => { body().dispatchEvent(new Event("scroll")); });
  const settled = samples[samples.length - 1]!;
  expect(settled.distance).toBe(0);
  expect(settled.tailInWindow).toBe(true);
  expectMonotonicWindow();
});

it("never drops the window when history admits after an empty mount", async () => {
  await render([]);
  const items = history(60);
  await render(items);
  const admitted = firstPopulatedSample();
  expect(admitted.distance).toBe(0);
  expect(admitted.tailInWindow).toBe(true);
  expectLastRowPainted(items);
  act(() => { body().dispatchEvent(new Event("scroll")); });
  const settled = samples[samples.length - 1]!;
  expect(settled.distance).toBe(0);
  expect(settled.tailInWindow).toBe(true);
  expectMonotonicWindow();
});

it("pins within the admission commit and remounts no retained row", async () => {
  const tail = history(12, "tail");
  await render(tail);
  const retained = [...container.querySelectorAll(".th-chat-row")];
  // Held history and a new final message admit in ONE commit: the release
  // ordering contract — the viewport is already at the bottom in the layout
  // phase of that commit, before it can paint.
  const admittedItems = [message("head-0"), message("head-1"), ...tail, message("latest")];
  await render(admittedItems);
  const admitted = samples[samples.length - 1]!;
  expect(admitted.distance).toBe(0);
  expect(admitted.tailInWindow).toBe(true);
  expect(instance().getVirtualItems().at(-1)?.key).toBe("message:latest");
  expectLastRowPainted(admittedItems);
  const admittedRows = [...container.querySelectorAll(".th-chat-row")];
  expect(admittedRows).toContain(retained[retained.length - 1]!);
  expectMonotonicWindow();
});

it("keeps the first paint bottom-pinned at 390px phone geometry", async () => {
  viewport = { width: 390, height: 700 };
  await render([]);
  const items = history(60);
  await render(items);
  const admitted = firstPopulatedSample();
  expect(admitted.distance).toBe(0);
  expect(admitted.tailInWindow).toBe(true);
  expectLastRowPainted(items);
  act(() => { body().dispatchEvent(new Event("scroll")); });
  expectMonotonicWindow();
});

it("leaves a parked reader alone when older history admits", async () => {
  await render(history(60, "tail"));
  const scrollport = body();
  act(() => { scrollport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })); });
  scrollport.scrollTop = Math.floor(scrollport.scrollHeight * 0.25);
  act(() => { scrollport.dispatchEvent(new Event("scroll")); });
  act(() => { scrollport.dispatchEvent(new Event("scrollend")); });
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  const parkedTop = scrollport.scrollTop;
  const parkedDistance = scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight;
  expect(parkedDistance).toBeGreaterThan(0);

  await render([message("head-0"), message("head-1"), message("head-2"), ...history(60, "tail")]);

  // Not following: no pin. The anchor compensation moves the viewport down by
  // exactly the admitted block (measured == estimated), distance untouched.
  expect(scrollport.scrollTop).toBe(parkedTop + 3 * instance().options.estimateSize(0));
  expect(scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight).toBe(parkedDistance);
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});
