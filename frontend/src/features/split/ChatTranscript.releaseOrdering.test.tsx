import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "./useChatFrameState";

import { ChatTranscript } from "./ChatTranscript";
const observed = vi.hoisted(() => ({ current: undefined as Virtualizer<Element, Element> | undefined }));
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return { ...actual, useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
    const instance = actual.useVirtualizer(...args);
    observed.current = instance;
    return instance;
  } };
});

let container: HTMLDivElement;
let root: Root;
let releaseSamples: number[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockReturnValue(100);
  // Keep ResizeObserver delivery separate from observe(), like the browser.
  // This scenario uses accurate row estimates, so no later resize is needed.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".th-chat-row") ? instance().options.estimateSize(Number(this.dataset["index"])) : 400;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(key => { frames.delete(key); });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  releaseSamples = [];
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
const tail = Array.from({ length: 12 }, (_, index) => message(`tail-${index}`));
const chunk = [message("head-0"), message("head-1"), ...tail];
function instance(): Virtualizer<Element, Element> {
  if (!observed.current) throw new Error("missing virtualizer");
  return observed.current;
}
function body(): HTMLDivElement {
  const element = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!element) throw new Error("missing scrollport");
  return element;
}
// Child layout effects precede the parent's. Record the actual viewport in
// that phase, before passive effects; act may flush both phases afterwards.
// No React hook is mocked and no source/hook name is asserted.
function Probe({ items, historyWarming }: { items: readonly TranscriptItem[]; historyWarming: boolean }) {
  useLayoutEffect(() => {
    if (!historyWarming) releaseSamples.push(body().scrollHeight - body().clientHeight - body().scrollTop);
  }, [items, historyWarming]);
  return <ChatTranscript items={items} streaming="" thinking="" toolCalls={{}}
    doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded historyWarming={historyWarming} />;
}
function render(items: readonly TranscriptItem[], historyWarming = true): void {
  act(() => root.render(<Probe items={items} historyWarming={historyWarming} />));
}

it("pins before the release commit ends when held history and a new final message arrive together", async () => {
  await act(async () => render(tail));
  const element = body();
  const committedHeight = () => Math.max(400, Number.parseFloat(container.querySelector<HTMLElement>(".th-chat-history")!.style.height));
  let top = committedHeight() - 400;
  Object.defineProperties(element, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => {
      top = Math.max(0, Math.min(value, committedHeight() - 400));
    } },
    scrollHeight: { configurable: true, get: committedHeight },
    clientHeight: { configurable: true, value: 400 },
    scrollTo: { configurable: true, value: (options: ScrollToOptions) => { element.scrollTop = options.top ?? top; } },
  });
  act(() => element.dispatchEvent(new Event("scroll")));
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  render(chunk);
  expect(instance().options.count).toBe(12);
  expect([...container.querySelectorAll(".th-chat-row")].every(row => row.textContent?.startsWith("tail-"))).toBe(true);
  render([...chunk, message("latest")], false);
  expect(instance().options.count).toBe(15);
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  console.log("release commit distance from bottom", releaseSamples);
  expect(releaseSamples).toEqual([0]);
});
