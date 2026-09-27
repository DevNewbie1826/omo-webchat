import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { parseChatServerFrame, type ChatClientFrame, type ChatConnector, type ChatServerFrame } from "../../lib/chatWs";
import type { ChatSessionRef } from "../workspace/workspace";
import { ChatPane } from "./ChatPane";
import { i18n, renderChatPane } from "./chatPaneTestHarness";

const NANO_AT = (ms: number): string => new Date(ms).toISOString();

function wireNoticeFrame(seq: number, at: number): Record<string, unknown> {
  return {
    type: "notice",
    sessionId: "chat-1",
    kind: "auto_retry_start",
    payload: { message: `n${seq}` },
    at: NANO_AT(at),
  };
}

function deliverWire(deliver: (frame: ChatServerFrame) => void, wire: Record<string, unknown>): void {
  const parsed = parseChatServerFrame(wire);
  if (parsed) deliver(parsed);
}

const entry = (id: string, ts: number): Record<string, unknown> => ({
  type: "message",
  id,
  message: { role: "user", content: id, timestamp: ts },
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

it("hides notices stamped before the first loaded message until their range is loaded", () => {
  const { deliver } = renderChatPane(root);

  act(() => {
    deliver({
      type: "entries",
      sessionId: "chat-1",
      historySessionId: "durable",
      entries: [entry("tail", 3000)],
      historyComplete: false,
      final: true,
    } as unknown as ChatServerFrame);
    deliverWire(deliver, wireNoticeFrame(1, 1000));
    deliverWire(deliver, wireNoticeFrame(2, 3500));
  });

  expect(container.textContent).toContain("n2");
  expect(container.textContent).not.toContain("n1");

  act(() => {
    deliver({
      type: "entries",
      sessionId: "chat-1",
      segment: "head",
      historySessionId: "durable",
      entries: [entry("root", 500)],
      historyComplete: true,
      final: true,
    } as unknown as ChatServerFrame);
  });

  expect(container.textContent).toContain("n1");
  expect(container.querySelectorAll(".th-chat-history .th-chat-row")).toHaveLength(4);
});

it("renders every notice once the history root is known, even before the oldest range loads", () => {
  const { deliver } = renderChatPane(root);

  act(() => {
    deliver({
      type: "entries",
      sessionId: "chat-1",
      historySessionId: "durable",
      entries: [entry("tail", 3000)],
      historyComplete: true,
      final: true,
    } as unknown as ChatServerFrame);
    deliverWire(deliver, wireNoticeFrame(1, 1000));
  });

  expect(container.textContent).toContain("n1");
});

it("renders the failed-empty row at the top with notices below it and a working retry", () => {
  const { deliver, sent } = renderChatPane(root);

  act(() => {
    deliverWire(deliver, wireNoticeFrame(1, 1000));
    deliver({
      type: "error",
      sessionId: "chat-1",
      code: "incomplete_history",
      message: "broken branch",
    });
  });

  const failed = container.querySelector(".th-chat-history-failed");
  expect(failed?.getAttribute("role")).toBe("status");
  expect(failed?.textContent).toContain("chat.historyFailedEmpty");
  expect(container.textContent).toContain("n1");
  const failedTop = failed?.compareDocumentPosition(container.querySelector(".th-chat-history")!)!;
  expect(failedTop & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const framesBefore = sent.length;
  const retry = failed?.querySelector("button");
  if (!(retry instanceof HTMLButtonElement)) throw new Error("missing retry button");
  act(() => retry.click());
  expect(sent.length).toBeGreaterThan(framesBefore);
  expect(sent.slice(-2).map((frame) => frame.type)).toEqual(["chat.close", "chat.create"]);
});

it("hides the failed-empty row while disconnected", () => {
  let onClose: ((code: number) => void) | undefined;
  let deliver: ((frame: ChatServerFrame) => void) | undefined;
  const sent: ChatClientFrame[] = [];
  const connect: ChatConnector = (next) => {
    onClose = next.onClose;
    deliver = next.onFrame;
    next.onOpen?.();
    return { send: (frame) => { sent.push(frame); return true; }, close: vi.fn() };
  };
  const session: ChatSessionRef = { id: "chat-1", name: "Chat 1", wsId: "workspace-1", cwd: "/work", provider: "omo" };
  act(() => {
    root.render(
      <I18nContext.Provider value={i18n}>
        <ChatPane chatSession={session} focused splitEnabled={false}
          onFocus={() => undefined} onSplit={() => undefined} onClose={() => undefined}
          onOpenSidebar={() => undefined} connect={connect} notify={() => undefined} />
      </I18nContext.Provider>,
    );
  });

  act(() => {
    deliver?.({
      type: "error",
      sessionId: "chat-1",
      code: "incomplete_history",
      message: "broken branch",
    });
  });
  expect(container.querySelector(".th-chat-history-failed")).not.toBeNull();

  act(() => onClose?.(1006));
  expect(container.querySelector(".th-chat-history-failed")).toBeNull();
});
