import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatTranscript } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";

// Observe the real virtualizer, as in the prepend/follow-intent harnesses:
// list admission, React keys, measurements and scroll ownership stay integrated.
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

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockReturnValue(100);
  // Reconciliation frames are explicitly retained, never raced against assertions.
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { frames.delete(key); });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  observed.current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function message(id: string): TranscriptItem {
  return { kind: "message", message: { id, role: "user", blocks: [{ kind: "text", text: id }] } };
}
const tail = [message("tail-0"), message("tail-1"), message("tail-2")];
const chunk = [message("head-0"), message("head-1"), ...tail];
function render(items: readonly TranscriptItem[], historyWarming = true): void {
  act(() => root.render(<ChatTranscript items={items} streaming="" thinking="" toolCalls={{}}
    doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded historyWarming={historyWarming} />));
}
function instance(): Virtualizer<Element, Element> {
  if (!observed.current) throw new Error("missing virtualizer");
  return observed.current;
}
function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".th-chat-row")];
}
async function mount(): Promise<HTMLDivElement> {
  // Flush the transcript's queued metrics read inside act before installing geometry.
  await act(async () => render(tail));
  const body = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!body) throw new Error("missing scrollport");
  let top = instance().getTotalSize() - 400;
  Object.defineProperties(body, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => {
      top = Math.max(0, Math.min(value, instance().getTotalSize() - 400));
    } },
    scrollHeight: { configurable: true, get: () => instance().getTotalSize() },
    clientHeight: { configurable: true, value: 400 },
    scrollTo: { configurable: true, value: (options: ScrollToOptions) => { body.scrollTop = options.top ?? top; } },
  });
  act(() => body.dispatchEvent(new Event("scroll")));
  return body;
}
function expectHeld(): void {
  expect(rows().map((row) => row.textContent)).toEqual(["tail-0", "tail-1", "tail-2"]);
  expect(instance().options.count).toBe(3);
}

it("holds the leading row, mounted rows above the viewport and height across earlier chunks", async () => {
  const body = await mount();
  const original = rows();
  const height = body.scrollHeight;
  const above = () => rows().filter((row) => Number(/translateY\(([\d.]+)px\)/.exec(row.style.transform)?.[1]) < body.scrollTop).length;
  const countAbove = above();
  for (const items of [chunk, [message("older"), ...chunk]]) {
    render(items);
    expectHeld();
    expect(rows()[0]).toBe(original[0]);
    expect(above()).toBe(countAbove);
    expect(body.scrollHeight).toBe(height);
  }
});

it("releases every item in order on fill completion without remounting retained keys", async () => {
  await mount();
  const original = rows();
  render(chunk);
  expectHeld();
  render(chunk, false);
  expect(rows().map((row) => row.textContent)).toEqual(["head-0", "head-1", "tail-0", "tail-1", "tail-2"]);
  expect(instance().getVirtualItems().map((row) => row.key)).toEqual(["message:head-0", "message:head-1", "message:tail-0", "message:tail-1", "message:tail-2"]);
  original.forEach((row, index) => expect(rows()[index + 2]).toBe(row));
});

it.each(["wheel", "touchmove", "keydown"])("releases on reader %s scrolling mid-fill and preserves the viewed row position", async (input) => {
  const body = await mount();
  render(chunk);
  expectHeld();
  act(() => body.dispatchEvent(input === "wheel" ? new WheelEvent(input, { deltaY: -100 })
    : input === "keydown" ? new KeyboardEvent(input, { key: "ArrowUp" }) : new Event(input)));
  body.scrollTop -= 100;
  const viewportOffset = 2 * 768 - body.scrollTop;
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(instance().options.count).toBe(5);
  expect(rows().map((row) => row.textContent)).toEqual(["head-0", "head-1", "tail-0", "tail-1", "tail-2"]);
  expect(4 * 768 - body.scrollTop).toBe(viewportOffset);
  render([message("older"), ...chunk]);
  expect(instance().options.count).toBe(6);
});

it("releases hidden history when the held seam disappears", async () => {
  await mount();
  render(chunk);
  expectHeld();
  render([message("head-0"), message("head-1"), ...tail.slice(1)]);
  expect(rows().map((row) => row.textContent)).toEqual(["head-0", "head-1", "tail-1", "tail-2"]);
  expect(instance().options.count).toBe(4);
});
