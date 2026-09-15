import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChatTranscript, transcriptItemKeys } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => {
  Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
  return { current: undefined as Virtualizer<Element, Element> | undefined };
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
vi.mock("./chatRowEstimate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatRowEstimate")>();
  // Real browsers reuse the metrics object for an unchanged lane/font. jsdom
  // cannot lay out the font probe, so supply that same cache-hit behavior.
  const metrics = actual.readRowMetrics(null);
  return {
    ...actual,
    readRowMetrics: (element: HTMLElement | null) =>
      element === null ? actual.readRowMetrics(null) : metrics,
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("keeps total size unchanged when a never-mounted ordinal row gains an image after metrics settle", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0);
  const observers = new Map<ResizeObserver, { callback: ResizeObserverCallback; targets: Set<Element> }>();
  const OriginalObserver = ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends OriginalObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.set(this, { callback, targets: new Set() });
    }
    override observe(target: Element): void {
      observers.get(this)!.targets.add(target);
      super.observe(target);
    }
    override disconnect(): void {
      observers.delete(this);
      super.disconnect();
    }
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const items: TranscriptItem[] = Array.from({ length: 300 }, (_, index) => ({
    kind: "message",
    message: { role: "assistant", blocks: [{ kind: "text", text: `row ${index}` }] },
  }));
  const render = async (next: readonly TranscriptItem[]): Promise<void> => {
    await act(async () => {
      root.render(<ChatTranscript items={next} streaming="" thinking="" toolCalls={{}}
        doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />);
    });
  };
  try {
    await render(items);
    // Deliver the lane-width observation after the initial metrics commit,
    // as the browser does. The second metrics read hits the same cached object.
    const body = container.querySelector<HTMLElement>(".th-chat-body");
    if (!body) throw new Error("missing scrollport");
    await act(async () => {
      width.mockReturnValue(390);
      for (const [observer, { callback, targets }] of observers) {
        if (!targets.has(body)) continue;
        callback([{
          target: body,
          contentRect: new DOMRect(0, 0, 390, 768),
          borderBoxSize: [{ inlineSize: 390, blockSize: 768 }],
          contentBoxSize: [{ inlineSize: 390, blockSize: 768 }],
          devicePixelContentBoxSize: [{ inlineSize: 390, blockSize: 768 }],
        }], observer);
      }
    });
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer");
    const key = instance.options.getItemKey(41);
    expect(key).toBe("message-ordinal:41");
    expect(container.querySelectorAll(".th-chat-row[data-index]").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-index="41"]')).toBeNull();
    expect(instance.itemSizeCache.has(key)).toBe(false);
    const total = instance.getTotalSize();
    const history = container.querySelector<HTMLElement>(".th-chat-history");
    expect(history?.style.height).toBe(`${total}px`);

    const changed = items.map((item, index): TranscriptItem => index === 41 ? {
      kind: "message",
      message: { role: "assistant", blocks: [{ kind: "image", data: "QUJD", mimeType: "image/png" }] },
    } : item);
    expect(transcriptItemKeys(changed)).toEqual(transcriptItemKeys(items));
    await render(changed);

    expect(container.querySelector('[data-index="41"]')).toBeNull();
    expect(instance.itemSizeCache.has(key)).toBe(false);
    expect(instance.getTotalSize()).toBe(total);
    expect(history?.style.height).toBe(`${total}px`);
  } finally {
    act(() => root.unmount());
    container.remove();
    width.mockRestore();
    vi.stubGlobal("ResizeObserver", OriginalObserver);
    observed.current = undefined;
  }
});
