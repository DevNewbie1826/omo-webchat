import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { chatSession, ControlledResizeObserver, i18n } from "./chatPaneTestHarness";

const crash = vi.hoisted(() => ({ enabled: true }));

vi.mock("./ChatTranscript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChatTranscript")>();
  return {
    ...actual,
    ChatTranscript: (props: Parameters<typeof actual.ChatTranscript>[0]) => {
      if (crash.enabled && JSON.stringify(props.items).includes("CRASH")) throw new Error("row render failed");
      return <actual.ChatTranscript {...props} />;
    },
  };
});

let container: HTMLDivElement;
let root: Root;
let closed: string[];
let deliver: Map<string, (frame: ChatServerFrame) => void>;
let connects: Map<string, number>;

function connectFor(id: string): ChatConnector {
  return (handlers) => {
    deliver.set(id, handlers.onFrame);
    connects.set(id, (connects.get(id) ?? 0) + 1);
    handlers.onOpen?.();
    return { send: () => true, close: () => undefined };
  };
}

function hydrate(id: string, text: string): void {
  const onFrame = deliver.get(id);
  if (!onFrame) throw new Error(`pane ${id} is not connected`);
  act(() => {
    onFrame({ type: "ready", sessionId: id, piSessionId: `pi-${id}`, resumed: true });
    onFrame({ type: "entries", sessionId: id, entries: [{ type: "message", message: { role: "user", content: text, timestamp: 1 } }], final: true });
  });
}

function pane(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-pane="${id}"]`);
  if (!element) throw new Error(`missing pane ${id}`);
  return element;
}

function renderPanes(ids: readonly string[]): void {
  act(() => {
    root.render(
      <I18nContext.Provider value={i18n}>
        {ids.map((id) => (
          <div key={id} data-pane={id}>
            <ChatPane
              chatSession={{ ...chatSession, id, name: `Chat ${id}` }}
              focused
              splitEnabled
              onFocus={() => undefined}
              onSplit={() => undefined}
              onClose={() => closed.push(id)}
              onOpenSidebar={() => undefined}
              connect={connectFor(id)}
              notify={() => undefined}
            />
          </div>
        ))}
      </I18nContext.Provider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  crash.enabled = true;
  closed = [];
  deliver = new Map();
  connects = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("contains a render failure to its own pane and keeps the sibling pane working", () => {
  renderPanes(["a", "b"]);
  hydrate("a", "hello from a");
  hydrate("b", "CRASH");

  const failed = pane("b").querySelector(".th-pane-error");
  expect(failed?.textContent).toContain("chat.paneCrashed");
  expect(failed?.textContent).toContain("row render failed");
  expect(pane("a").querySelector(".th-pane-error")).toBeNull();
  expect(pane("a").querySelector(".th-chat-body")).not.toBeNull();
  expect(pane("a").querySelector("textarea")).not.toBeNull();
  expect(vi.mocked(console.error).mock.calls.flat().some((arg) => arg instanceof Error && arg.message === "row render failed")).toBe(true);
});

it("remounts the failed pane with a fresh connection on retry", () => {
  renderPanes(["b"]);
  hydrate("b", "CRASH");
  expect(connects.get("b")).toBe(1);

  crash.enabled = false;
  const retry = pane("b").querySelector<HTMLButtonElement>(".th-pane-error-retry");
  act(() => retry?.click());
  expect(pane("b").querySelector(".th-pane-error")).toBeNull();
  expect(connects.get("b")).toBe(2);
  hydrate("b", "recovered text");
  expect(pane("b").querySelector(".th-pane-error")).toBeNull();
  expect(pane("b").querySelector(".th-chat-body")).not.toBeNull();
});

it("closes the failed pane from the fallback", () => {
  renderPanes(["b"]);
  hydrate("b", "CRASH");
  act(() => pane("b").querySelector<HTMLButtonElement>(".th-pane-error-close")?.click());
  expect(closed).toEqual(["b"]);
});
