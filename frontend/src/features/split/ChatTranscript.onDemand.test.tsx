import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import { ChatTranscript } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

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

class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  readonly targets: Element[] = [];

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    ControlledIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }

  disconnect(): void {
    this.targets.length = 0;
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      this.targets.map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
      }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key) => key,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
  vi.spyOn(performance, "now").mockReturnValue(100);
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
  ControlledIntersectionObserver.instances.length = 0;
  observed.current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function message(id: string): TranscriptItem {
  return { kind: "message", message: { id, role: "user", blocks: [{ kind: "text", text: id }] } };
}
const tail = [message("tail-0"), message("tail-1"), message("tail-2")];

interface OlderHandle {
  readonly state: "idle" | "loading" | "error" | "complete" | "unavailable";
  readonly loadOlder: () => void;
}

function render(
  items: readonly TranscriptItem[],
  extra: { readonly olderHistory?: OlderHandle; readonly historyFailedEmpty?: boolean; readonly onRetryHistory?: () => void; readonly historyLoaded?: boolean } = {},
): void {
  act(() => root.render(
    <I18nContext.Provider value={i18n}>
      <ChatTranscript items={items} streaming="" thinking="" toolCalls={{}}
        doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded={extra.historyLoaded ?? true}
        {...(extra.olderHistory !== undefined ? { olderHistory: extra.olderHistory } : {})}
        {...(extra.historyFailedEmpty !== undefined ? { historyFailedEmpty: extra.historyFailedEmpty } : {})}
        {...(extra.onRetryHistory !== undefined ? { onRetryHistory: extra.onRetryHistory } : {})} />
    </I18nContext.Provider>,
  ));
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

async function mount(renderFn: () => void): Promise<HTMLDivElement> {
  await act(async () => renderFn());
  const element = body();
  let top = instance().getTotalSize() - 400;
  Object.defineProperties(element, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => {
      top = Math.max(0, Math.min(value, instance().getTotalSize() - 400));
    } },
    scrollHeight: { configurable: true, get: () => instance().getTotalSize() },
    clientHeight: { configurable: true, value: 400 },
    scrollTo: { configurable: true, value: (options: ScrollToOptions) => { element.scrollTop = options.top ?? top; } },
  });
  act(() => element.dispatchEvent(new Event("scroll")));
  return element;
}

function releaseFollow(element: HTMLDivElement): void {
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
  element.scrollTop -= 100;
  act(() => element.dispatchEvent(new Event("scroll")));
}

it("calls loadOlder once when the sentinel becomes visible and the reader is not following", async () => {
  const loadOlder = vi.fn();
  const element = await mount(() => render(tail, { olderHistory: { state: "idle", loadOlder } }));
  const observer = ControlledIntersectionObserver.instances.at(-1);
  if (!observer) throw new Error("missing sentinel observer");
  expect(observer.options?.root).toBe(element);
  expect(String(observer.options?.rootMargin)).toContain("600px");
  // Visible while bottom-following: no load.
  act(() => observer.trigger(true));
  expect(loadOlder).not.toHaveBeenCalled();
  // Reader scrolls up out of follow; the scroll handler re-checks the sentinel.
  releaseFollow(element);
  expect(loadOlder).toHaveBeenCalledTimes(1);
  // In flight: repeat intersections and scrolls do not retrigger.
  render(tail, { olderHistory: { state: "loading", loadOlder } });
  act(() => observer.trigger(true));
  releaseFollow(element);
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("keeps paging while the reader parks inside the margin as pages land", async () => {
  const loadOlder = vi.fn();
  const element = await mount(() => render(tail, { olderHistory: { state: "idle", loadOlder } }));
  const observer = ControlledIntersectionObserver.instances.at(-1);
  if (!observer) throw new Error("missing sentinel observer");
  act(() => observer.trigger(true));
  releaseFollow(element);
  expect(loadOlder).toHaveBeenCalledTimes(1);
  // The page lands but the observer fires no new crossing: the idle
  // re-check continues the load until the margin is satisfied.
  render(tail, { olderHistory: { state: "loading", loadOlder } });
  render(tail, { olderHistory: { state: "idle", loadOlder } });
  expect(loadOlder).toHaveBeenCalledTimes(2);
});

it("loads a short tail one page per upward intent", async () => {
  const loadOlder = vi.fn();
  const element = await mount(() => render([message("short")], { olderHistory: { state: "loading", loadOlder } }));
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 200 },
    clientHeight: { configurable: true, value: 400 },
  });

  render([message("short")], { olderHistory: { state: "idle", loadOlder } });
  expect(loadOlder).not.toHaveBeenCalled();
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(1);
  render([message("short")], { olderHistory: { state: "loading", loadOlder } });
  act(() => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
  });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  render([message("short")], { olderHistory: { state: "loading", loadOlder } });
  render([message("older"), message("short")], { olderHistory: { state: "idle", loadOlder } });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(2);
});

it("waits for initial history before requesting an older short-tail page", async () => {
  const loadOlder = vi.fn();
  const element = await mount(() => render([message("preview")], {
    olderHistory: { state: "idle", loadOlder }, historyLoaded: false,
  }));
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 200 },
    clientHeight: { configurable: true, value: 400 },
  });
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
  expect(loadOlder).not.toHaveBeenCalled();

  render([message("preview")], { olderHistory: { state: "idle", loadOlder }, historyLoaded: true });
  expect(loadOlder).not.toHaveBeenCalled();
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("loads older history on upward input when hidden entries leave no visible rows", async () => {
  const loadOlder = vi.fn();
  const hidden = Array.from({ length: 59 }, (_, index): TranscriptItem => ({
    kind: "message",
    message: { id: `hidden-${index}`, role: "assistant", blocks: [] },
  }));
  const element = await mount(() => render([message("last"), ...hidden], { olderHistory: { state: "loading", loadOlder } }));
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 400 },
  });
  render([message("last"), ...hidden], { olderHistory: { state: "idle", loadOlder } });
  expect(container.querySelectorAll(".th-chat-history .th-chat-row")).toHaveLength(1);
  expect(loadOlder).not.toHaveBeenCalled();
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(1);
  render([message("last"), ...hidden], { olderHistory: { state: "loading", loadOlder } });
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("requests an older page when every loaded entry hides its row", async () => {
  const loadOlder = vi.fn();
  const hidden = Array.from({ length: 60 }, (_, index): TranscriptItem => ({
    kind: "message",
    message: { id: `blank-${index}`, role: "assistant", blocks: [] },
  }));
  const element = await mount(() => render(hidden, { olderHistory: { state: "loading", loadOlder } }));
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 400 },
  });
  render(hidden, { olderHistory: { state: "idle", loadOlder } });
  expect(container.querySelectorAll(".th-chat-history .th-chat-row")).toHaveLength(0);
  expect(loadOlder).not.toHaveBeenCalled();
  act(() => element.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it.each(["PageUp", "Home", "ArrowUp"])("requests history for %s at a non-scrollable focused viewport", async (key) => {
  const loadOlder = vi.fn();
  const element = await mount(() => render(tail, { olderHistory: { state: "idle", loadOlder } }));
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 400 },
  });
  element.focus();
  act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("requests history on a downward touch drag without scroll overflow", async () => {
  const loadOlder = vi.fn();
  const element = await mount(() => render(tail, { olderHistory: { state: "idle", loadOlder } }));
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 400 },
  });
  act(() => {
    element.dispatchEvent(new TouchEvent("touchstart", { touches: [{ identifier: 1, clientY: 80 } as Touch] }));
    element.dispatchEvent(new TouchEvent("touchmove", { touches: [{ identifier: 1, clientY: 120 } as Touch] }));
  });
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("renders a spinner row while loading and nothing once complete or unavailable", async () => {
  const loadOlder = vi.fn();
  await mount(() => render(tail, { olderHistory: { state: "loading", loadOlder } }));
  const spinnerRow = container.querySelector(".th-chat-history-loading");
  expect(spinnerRow?.getAttribute("role")).toBe("status");
  expect(spinnerRow?.textContent).toContain("chat.loadingOlder");
  render(tail, { olderHistory: { state: "complete", loadOlder } });
  expect(container.querySelector(".th-chat-history-sentinel")).toBeNull();
  render(tail, { olderHistory: { state: "unavailable", loadOlder } });
  expect(container.querySelector(".th-chat-history-sentinel")).toBeNull();
  expect(container.querySelector(".th-chat-history-loading")).toBeNull();
});

it("renders an inline retry row on error and retries via loadOlder", async () => {
  const loadOlder = vi.fn();
  await mount(() => render(tail, { olderHistory: { state: "error", loadOlder } }));
  const row = container.querySelector(".th-chat-history-error");
  expect(row?.getAttribute("role")).toBe("status");
  expect(row?.textContent).toContain("chat.historyOlderFailed");
  const retry = row?.querySelector("button");
  if (!(retry instanceof HTMLButtonElement)) throw new Error("missing retry button");
  act(() => retry.click());
  expect(loadOlder).toHaveBeenCalledTimes(1);
});

it("renders the failed-empty status row with a working retry", async () => {
  const onRetryHistory = vi.fn();
  await mount(() => render([], { historyFailedEmpty: true, onRetryHistory }));
  const row = container.querySelector(".th-chat-history-failed");
  expect(row?.getAttribute("role")).toBe("status");
  expect(row?.textContent).toContain("chat.historyFailedEmpty");
  const retry = row?.querySelector("button");
  if (!(retry instanceof HTMLButtonElement)) throw new Error("missing retry button");
  act(() => retry.click());
  expect(onRetryHistory).toHaveBeenCalledTimes(1);
});

it("does not render the failed-empty row when history committed messages", async () => {
  await mount(() => render(tail, { historyFailedEmpty: false }));
  expect(container.querySelector(".th-chat-history-failed")).toBeNull();
});

it("stays pinned to the bottom through a prepend that brings the newest message while following", async () => {
  const element = await mount(() => render(tail));
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  render([message("head-0"), message("head-1"), ...tail, message("latest")]);
  expect(instance().options.count).toBe(6);
  expect([...container.querySelectorAll(".th-chat-row")].some((row) => row.textContent === "latest")).toBe(true);
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
});

async function mountSession(hidden = false, short = false) {
  const session = { id: "older-chat", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
  let handlers: Parameters<ChatConnector>[0] | undefined;
  const sent: ChatClientFrame[] = [];
  const requests: Array<{ url: string; finish: (response: Response) => void }> = [];
  vi.stubGlobal("fetch", (url: string) => {
    if (!url.includes("/history?")) return Promise.resolve(new Response("{}", { status: 200 }));
    return new Promise<Response>((finish) => requests.push({ url, finish }));
  });
  if (short) {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  }
  const connect: ChatConnector = (next) => {
    handlers = next;
    next.onOpen?.();
    return { send: (frame) => { sent.push(frame); return true; }, close: () => undefined };
  };
  function Probe() {
    const chat = useChatSession(session, connect);
    return <ChatTranscript items={chat.messages.map((message) => ({ kind: "message", message }))} streaming={chat.streaming} thinking={chat.thinking}
      toolCalls={chat.toolCalls} doneReason={chat.doneReason} error={chat.error}
      restoreVersion={chat.restoreVersion} focused={false} historyLoaded={chat.historyLoaded}
      olderHistory={chat.olderHistory} />;
  }
  await act(async () => root.render(<I18nContext.Provider value={i18n}><Probe /></I18nContext.Provider>));
  if (!handlers) throw new Error("missing session connector");
  const socket = handlers;
  const deliver = (frame: ChatServerFrame) => act(() => socket.onFrame(frame));
  const entry = (id: string) => ({ type: "message", id, message: { role: hidden ? "assistant" : "user", content: hidden ? [] : id } });
  const ready = () => deliver({ type: "ready", sessionId: session.id, piSessionId: "durable", resumed: true });
  ready();
  deliver({ type: "entries", sessionId: session.id, historySessionId: "durable",
    entries: [entry("tail")], final: true, historyComplete: false });
  const element = body();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: short ? 400 : 2400 },
    clientHeight: { configurable: true, value: 400 },
  });
  return {
    element, requests, socket, ready,
    resume: () => {
      const create = [...sent].reverse().find((frame) => frame.type === "chat.create");
      if (create?.type !== "chat.create" || !create.resume) throw new Error("missing resume cursor");
      deliver({ type: "entries", sessionId: session.id, historySessionId: "durable",
        entries: [], final: true, historyComplete: false, resume: create.resume });
    },
    respond: async (index: number, complete: boolean) => {
      const request = requests[index];
      if (!request) throw new Error("missing older request");
      await act(async () => request.finish(new Response(JSON.stringify({
        sessionId: "durable", entries: [entry(complete ? "root" : "older")], historyComplete: complete,
      }), { status: 200 })));
    },
  };
}

it("can read upward after close, ignored input, open, ready and resume terminal", async () => {
  const h = await mountSession();
  const observer = ControlledIntersectionObserver.instances.at(-1);
  if (!observer) throw new Error("missing sentinel observer");
  act(() => observer.trigger(true));
  act(() => h.socket.onClose?.(1006));
  releaseFollow(h.element);
  expect(h.requests).toHaveLength(0);
  act(() => h.socket.onOpen?.());
  h.ready();
  h.resume();
  releaseFollow(h.element);
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.url).toContain("before=tail");
  await h.respond(0, true);
  expect(container.textContent).toContain("root");
});

it.each([false, true])("waits for upward intent and reaches root without duplicate requests (hidden=%s)", async (hidden) => {
  const h = await mountSession(hidden, true);
  expect(h.requests).toHaveLength(0);
  expect(container.querySelectorAll(".th-chat-history .th-chat-row")).toHaveLength(hidden ? 0 : 1);
  act(() => {
    h.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    h.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  });
  expect(h.requests).toHaveLength(1);
  await h.respond(0, false);
  expect(h.requests).toHaveLength(1);
  act(() => h.element.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]?.url).toContain("before=older");
  await h.respond(1, true);
  act(() => h.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })));
  expect(h.requests).toHaveLength(2);
  expect(container.querySelector(".th-chat-history-sentinel")).toBeNull();
});
