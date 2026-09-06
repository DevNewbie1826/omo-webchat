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

it("ends virtualizer scroll intent at native scrollend before another owner receives input", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ChatTranscript items={[]} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />));
    const body = container.querySelector<HTMLDivElement>(".th-chat-body");
    if (!body) throw new Error("missing transcript scroll owner");
    Object.defineProperties(body, {
      scrollTop: { configurable: true, writable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 400 },
    });
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(observed.current?.isScrolling).toBe(true);
    act(() => body.dispatchEvent(new Event("scrollend")));
    expect(observed.current?.isScrolling).toBe(false);
    expect(body.scrollTop).toBe(300);
  } finally {
    act(() => root.unmount()); container.remove(); delete observed.current;
  }
});
