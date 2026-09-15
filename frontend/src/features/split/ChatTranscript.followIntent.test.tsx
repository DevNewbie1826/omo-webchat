import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChatTranscript } from "./ChatTranscript";
import type { ToolEntry } from "./chatSessionTypes";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => {
  const wrapped = new WeakSet<object>();
  const state: {
    readonly wrapped: WeakSet<object>;
    current?: Virtualizer<Element, Element>;
    scrollToIndexCalls: Array<readonly [number, unknown]>;
  } = { wrapped, scrollToIndexCalls: [] };
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
      if (!observed.wrapped.has(instance)) {
        observed.wrapped.add(instance);
        const original = instance.scrollToIndex.bind(instance);
        instance.scrollToIndex = ((index, options) => {
          observed.scrollToIndexCalls.push([index, options]);
          return original(index, options);
        }) as typeof instance.scrollToIndex;
      }
      return instance;
    },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const idle = {
  streaming: "",
  thinking: "",
  toolCalls: {} as Readonly<Record<string, ToolEntry>>,
  doneReason: null,
  error: "",
  historyLoaded: true,
};

function transcriptRows(count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "message" as const,
    message: {
      id: `row-${index}`,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: `row ${index}` }],
    },
  }));
}

function installScroll(
  element: HTMLDivElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  let top = metrics.scrollTop;
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Number(value);
      },
    },
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    scrollTo: {
      configurable: true,
      value: (options?: ScrollToOptions | number) => {
        if (typeof options === "number") top = options;
        else if (options && typeof options.top === "number") top = options.top;
      },
    },
  });
}

function requireBody(container: HTMLElement): HTMLDivElement {
  const body = container.querySelector<HTMLDivElement>(".th-chat-body");
  if (!body) throw new Error("missing transcript scroll owner");
  return body;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  observed.scrollToIndexCalls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete observed.current;
  observed.scrollToIndexCalls = [];
});

it("does not jump to the last row when a row is appended after the reader scrolled up", () => {
  const items = transcriptRows(40);
  act(() =>
    root.render(
      <ChatTranscript {...idle} items={items} restoreVersion={0} focused />,
    ),
  );
  const body = requireBody(container);
  installScroll(body, { scrollTop: 300, scrollHeight: 6000, clientHeight: 400 });
  // Mount/restore writes are marked programmatic; consume that, then record the
  // deliberate upward scroll so follow intent drops (button visible).
  act(() => body.dispatchEvent(new Event("scroll")));
  body.scrollTop = 300;
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  const parked = body.scrollTop;
  observed.scrollToIndexCalls = [];

  act(() =>
    root.render(
      <ChatTranscript {...idle} items={transcriptRows(41)} restoreVersion={0} focused />,
    ),
  );

  expect(body.scrollTop).toBe(parked);
  expect(observed.scrollToIndexCalls).toEqual([]);
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});

it("keeps the view pinned to the last row when a row is appended while following", () => {
  act(() =>
    root.render(
      <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={0} focused />,
    ),
  );
  const body = requireBody(container);
  installScroll(body, { scrollTop: 5600, scrollHeight: 6000, clientHeight: 400 });
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
  observed.scrollToIndexCalls = [];

  act(() =>
    root.render(
      <ChatTranscript {...idle} items={transcriptRows(41)} restoreVersion={0} focused />,
    ),
  );

  expect(observed.scrollToIndexCalls.some(([index, options]) => {
    return index === 40 && (options as { align?: string } | undefined)?.align === "end";
  })).toBe(true);
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
});

it("scrolls to the end on restoreVersion even when the reader is not following", () => {
  act(() =>
    root.render(
      <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={0} focused />,
    ),
  );
  const body = requireBody(container);
  installScroll(body, { scrollTop: 300, scrollHeight: 6000, clientHeight: 400 });
  act(() => body.dispatchEvent(new Event("scroll")));
  body.scrollTop = 300;
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
  observed.scrollToIndexCalls = [];

  act(() =>
    root.render(
      <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={1} focused />,
    ),
  );

  expect(observed.scrollToIndexCalls.some(([index, options]) => {
    return index === 39 && (options as { align?: string } | undefined)?.align === "end";
  })).toBe(true);
  expect(body.scrollTop).not.toBe(300);
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
});
