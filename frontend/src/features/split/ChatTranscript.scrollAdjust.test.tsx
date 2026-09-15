import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChatTranscript } from "./ChatTranscript";

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

it("drops measurement-driven scroll corrections while a user scroll is in flight", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ChatTranscript items={[]} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />));
    const body = container.querySelector<HTMLDivElement>(".th-chat-body");
    if (!body) throw new Error("missing transcript scroll owner");
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");
    let top = 300;
    Object.defineProperties(body, {
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTo: {
        configurable: true,
        value: (options?: { top?: number }) => {
          if (options && typeof options.top === "number") top = options.top;
        },
      },
    });
    // In-flight user gesture: a measurement correction must NOT write scroll.
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(instance.isScrolling).toBe(true);
    act(() => instance.options.scrollToFn(500, { adjustments: 20 }, instance));
    expect(body.scrollTop).toBe(300);
    // Gesture settled: the same correction applies normally.
    act(() => body.dispatchEvent(new Event("scrollend")));
    expect(instance.isScrolling).toBe(false);
    act(() => instance.options.scrollToFn(500, { adjustments: 20 }, instance));
    expect(body.scrollTop).toBe(520);
  } finally {
    act(() => root.unmount()); container.remove(); delete observed.current;
  }
});

it("replays the sum of dropped corrections once the gesture ends", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ChatTranscript items={[]} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />));
    const body = container.querySelector<HTMLDivElement>(".th-chat-body");
    if (!body) throw new Error("missing transcript scroll owner");
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");
    let top = 300;
    Object.defineProperties(body, {
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTo: {
        configurable: true,
        value: (options?: { top?: number }) => {
          if (options && typeof options.top === "number") top = options.top;
        },
      },
    });
    // In-flight user gesture: two corrections arrive, neither writes scroll.
    // `adjustments` is cumulative, so 20 then 35 means increments of 20 + 15.
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(instance.isScrolling).toBe(true);
    act(() => instance.options.scrollToFn(500, { adjustments: 20 }, instance));
    act(() => instance.options.scrollToFn(500, { adjustments: 35 }, instance));
    expect(body.scrollTop).toBe(300);
    // Gesture ends: the dropped compensation replays once, as the SUM.
    act(() => body.dispatchEvent(new Event("scrollend")));
    expect(instance.isScrolling).toBe(false);
    expect(body.scrollTop).toBe(335);
  } finally {
    act(() => root.unmount()); container.remove(); delete observed.current;
  }
});
