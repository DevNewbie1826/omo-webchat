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

const ROW_COUNT = 40;

function makeItems(): TranscriptItem[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    kind: "message",
    message: { id: `m-${index}`, role: "user", blocks: [{ kind: "text", text: `row ${index}` }] },
  }));
}

interface Harness {
  readonly container: HTMLDivElement;
  readonly root: Root;
  readonly body: HTMLDivElement;
  readonly instance: Virtualizer<Element, Element>;
  getTop: () => number;
  setTop: (value: number) => void;
  rerender: (focused: boolean, restoreVersion: number) => void;
}

function mountTranscript(focused: boolean, restoreVersion: number): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const items = makeItems();
  const render = (nextFocused: boolean, nextRestoreVersion: number): void => {
    act(() => root.render(<ChatTranscript items={items} streaming="" thinking="" toolCalls={{}}
      doneReason={null} error="" restoreVersion={nextRestoreVersion} focused={nextFocused} historyLoaded />));
  };
  render(focused, restoreVersion);
  const body = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!body) throw new Error("missing transcript scroll owner");
  const instance = observed.current;
  if (!instance) throw new Error("missing virtualizer instance");
  let top = 0;
  Object.defineProperties(body, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
    scrollHeight: { configurable: true, value: 20000 },
    clientHeight: { configurable: true, value: 400 },
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
    getTop: () => top,
    setTop: (value: number) => { top = value; },
    rerender: render,
  };
}

function unmount(h: Harness): void {
  act(() => h.root.unmount());
  h.container.remove();
  delete observed.current;
}

/** Park the reader at a settled offset away from the bottom. */
function park(h: Harness, offset: number): void {
  h.setTop(offset);
  act(() => {
    h.body.dispatchEvent(new Event("scroll"));
  });
  act(() => {
    h.body.dispatchEvent(new Event("scrollend"));
  });
  expect(h.instance.isScrolling).toBe(false);
  expect(h.getTop()).toBe(offset);
}

it("preserves the parked position when focus is lost", () => {
  const h = mountTranscript(true, 0);
  try {
    park(h, 300);
    const pinSpy = vi.spyOn(h.instance, "scrollToIndex");
    h.rerender(false, 0);
    // Losing focus must not move the viewport: no pin, position untouched.
    expect(pinSpy).not.toHaveBeenCalled();
    expect(h.getTop()).toBe(300);
  } finally {
    unmount(h);
  }
});

it("pins to the end when focus is gained", () => {
  const h = mountTranscript(false, 0);
  try {
    park(h, 300);
    const pinSpy = vi.spyOn(h.instance, "scrollToIndex");
    h.rerender(true, 0);
    expect(pinSpy).toHaveBeenCalledWith(ROW_COUNT - 1, { align: "end" });
    expect(h.getTop()).not.toBe(300);
  } finally {
    unmount(h);
  }
});

it("pins to the end when restoreVersion changes while unfocused", () => {
  const h = mountTranscript(false, 0);
  try {
    park(h, 300);
    const pinSpy = vi.spyOn(h.instance, "scrollToIndex");
    h.rerender(false, 1);
    expect(pinSpy).toHaveBeenCalledWith(ROW_COUNT - 1, { align: "end" });
    expect(h.getTop()).not.toBe(300);
  } finally {
    unmount(h);
  }
});
