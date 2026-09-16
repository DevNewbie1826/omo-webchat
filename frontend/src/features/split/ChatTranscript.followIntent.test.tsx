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
  vi.spyOn(performance, "now").mockReturnValue(100);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  observed.scrollToIndexCalls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
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

function prepareWarmFollow(grownHeight = 11000): HTMLDivElement {
  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={0} focused />,
  ));
  const body = requireBody(container);
  const metrics = { scrollTop: 5000, scrollHeight: 6000, clientHeight: 400 };
  installScroll(body, metrics);
  // Install browser clamping before asking the app to write its bottom position.
  let top = metrics.scrollTop;
  Object.defineProperties(body, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight)); },
    },
    scrollTo: {
      configurable: true,
      value: (options?: ScrollToOptions | number) => {
        if (typeof options === "number") body.scrollTop = options;
        else if (typeof options?.top === "number") body.scrollTop = options.top;
      },
    },
  });
  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={1} focused />,
  ));
  expect(body.scrollTop).toBe(5600);
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
  observed.scrollToIndexCalls = [];
  metrics.scrollHeight = grownHeight;
  return body;
}

it("keeps bottom follow when a late scroll echo of the app's own write arrives after content grows", () => {
  const body = prepareWarmFollow();
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();

  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(41)} restoreVersion={1} focused />,
  ));
  expect(observed.scrollToIndexCalls).toContainEqual([40, { align: "end" }]);
});

it("drops follow when the reader wheels back to a previously written bottom", () => {
  const body = prepareWarmFollow(7000);
  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={2} focused />,
  ));
  expect(body.scrollTop).toBe(6600);
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();

  act(() => {
    body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
    body.scrollTop = 5600;
    body.dispatchEvent(new Event("scroll"));
  });
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});

it("drops follow when a held pointer returns to an earlier written bottom after 400ms", async () => {
  const body = prepareWarmFollow(7000);
  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={2} focused />,
  ));
  expect(body.scrollTop).toBe(6600);
  act(() => body.dispatchEvent(new Event("scroll")));
  act(() => body.dispatchEvent(new PointerEvent("pointerdown", { buttons: 1 })));
  for (const now of [450, 501]) {
    vi.mocked(performance.now).mockReturnValue(now);
    act(() => body.dispatchEvent(new PointerEvent("pointermove", { buttons: 1 })));
  }
  body.scrollTop = 5600;
  await act(async () => { body.dispatchEvent(new Event("scroll")); });
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});

it.each([6050, 6055])("drops follow when continuing touch momentum crosses the bottom threshold after 400ms (height %s)", async (height) => {
  const body = prepareWarmFollow(height);
  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={2} focused />,
  ));
  expect(body.scrollTop).toBe(height - 400);
  act(() => body.dispatchEvent(new Event("scroll")));
  act(() => {
    body.dispatchEvent(new TouchEvent("touchstart"));
    body.dispatchEvent(new TouchEvent("touchmove"));
  });
  vi.mocked(performance.now).mockReturnValue(101);
  act(() => body.dispatchEvent(new TouchEvent("touchend")));
  for (const [now, offset] of [[200, 20], [350, 30]] as const) {
    vi.mocked(performance.now).mockReturnValue(now);
    body.scrollTop = height - 400 - offset;
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
  }
  vi.mocked(performance.now).mockReturnValue(501);
  // 5600 is a cached write; 5605 is an unwritten momentum coordinate.
  body.scrollTop = height - 450;
  await act(async () => { body.dispatchEvent(new Event("scroll")); });
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});

it("does not renew reader ownership from quiet app echoes or pointer hover", () => {
  const body = prepareWarmFollow();
  vi.mocked(performance.now).mockReturnValue(450);
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
  vi.mocked(performance.now).mockReturnValue(600);
  act(() => {
    body.dispatchEvent(new PointerEvent("pointermove"));
    body.dispatchEvent(new Event("scroll"));
  });
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
});

it("keeps an unreleased stationary contact active beyond the grace period", () => {
  const body = prepareWarmFollow(7000);
  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={2} focused />,
  ));
  expect(body.scrollTop).toBe(6600);
  act(() => body.dispatchEvent(new Event("scroll")));
  act(() => body.dispatchEvent(new PointerEvent("pointerdown", { buttons: 1 })));
  vi.mocked(performance.now).mockReturnValue(501);
  body.scrollTop = 5600;
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();
});

it("retains momentum ownership through three cached app coordinates", () => {
  const body = prepareWarmFollow(6020);
  let height = 6020;
  Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => height });
  // Clamp each real app write against the current content height.
  let top = body.scrollTop;
  Object.defineProperty(body, "scrollTop", {
    configurable: true, get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, height - 400)); },
  });
  for (const version of [2, 3, 4]) {
    height = 5980 + version * 20;
    act(() => root.render(
      <ChatTranscript {...idle} items={transcriptRows(40)} restoreVersion={version} focused />,
    ));
    expect(body.scrollTop).toBe(height - 400);
    act(() => body.dispatchEvent(new Event("scroll")));
  }
  act(() => body.dispatchEvent(new TouchEvent("touchstart")));
  vi.mocked(performance.now).mockReturnValue(101);
  act(() => body.dispatchEvent(new TouchEvent("touchend")));
  for (const [now, position] of [[200, 5650], [300, 5640], [450, 5620], [550, 5600]] as const) {
    vi.mocked(performance.now).mockReturnValue(now);
    body.scrollTop = position;
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(container.querySelector(".th-chat-scroll-bottom") !== null).toBe(now === 550);
  }
});

it.each(["pointerup", "pointercancel"])("ends contact on outside %s so hover cannot own a quiet echo", (release) => {
  const body = prepareWarmFollow();
  act(() => body.dispatchEvent(new PointerEvent("pointerdown", { buttons: 1, bubbles: true })));
  vi.mocked(performance.now).mockReturnValue(110);
  act(() => document.body.dispatchEvent(new PointerEvent(release, { buttons: 0, bubbles: true })));
  vi.mocked(performance.now).mockReturnValue(450);
  act(() => {
    body.dispatchEvent(new PointerEvent("pointermove", { buttons: 0 }));
    body.dispatchEvent(new Event("scroll"));
  });
  expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
});

it("still drops follow when the reader genuinely scrolls up while history warms", () => {
  const body = prepareWarmFollow();
  body.scrollTop = 9000;
  act(() => body.dispatchEvent(new Event("scroll")));
  expect(container.querySelector(".th-chat-scroll-bottom")).not.toBeNull();

  act(() => root.render(
    <ChatTranscript {...idle} items={transcriptRows(41)} restoreVersion={1} focused />,
  ));
  expect(observed.scrollToIndexCalls).toEqual([]);
  expect(body.scrollTop).toBe(9000);
});
