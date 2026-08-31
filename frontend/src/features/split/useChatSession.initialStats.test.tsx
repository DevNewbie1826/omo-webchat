import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

describe("useChatSession initial stats gating", () => {
  let root: Root;
  let container: HTMLDivElement;

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

  // Regression: on a cold server the socket binding is published only after
  // the provider session opens (internal/api chat_lifecycle.go). A stats frame
  // sent before the ready frame arrives is rejected with session_mismatch.
  it("sends chat.stats only after the ready frame binds the socket", async () => {
    let deliver: ((frame: ChatServerFrame) => void) | undefined;
    const sent: ChatClientFrame[] = [];
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      handlers.onOpen?.();
      return {
        send: (frame) => {
          sent.push(frame);
          return true;
        },
        close: () => undefined,
      };
    };
    function Probe() {
      useChatSession(session, connect);
      return null;
    }

    act(() => root.render(<Probe />));

    // chat.create goes out immediately; stats must NOT.
    expect(sent).toEqual([{ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" }]);

    act(() => {
      deliver?.({ type: "ready", sessionId: "chat-1" } as ChatServerFrame);
    });

    expect(sent.filter((frame) => frame.type === "chat.stats")).toEqual([
      { type: "chat.stats", sessionId: "chat-1" },
    ]);
  });

  it("sends stats once per connect: not at open, once after ready, and not again for a later ready", async () => {
    const connectors: Array<{
      deliver?: (frame: ChatServerFrame) => void;
      sent: ChatClientFrame[];
    }> = [];
    const connect: ChatConnector = (handlers) => {
      const entry: { deliver?: (frame: ChatServerFrame) => void; sent: ChatClientFrame[] } = { sent: [] };
      connectors.push(entry);
      entry.deliver = handlers.onFrame;
      handlers.onOpen?.();
      return {
        send: (frame) => {
          entry.sent.push(frame);
          return true;
        },
        close: () => undefined,
      };
    };
    function Probe() {
      useChatSession(session, connect);
      return null;
    }

    act(() => root.render(<Probe />));
    const first = connectors[0];
    expect(first?.sent.filter((frame) => frame.type === "chat.stats")).toHaveLength(0);

    act(() => {
      first?.deliver?.({ type: "ready", sessionId: "chat-1" } as ChatServerFrame);
    });
    expect(first?.sent.filter((frame) => frame.type === "chat.stats")).toHaveLength(1);

    // A duplicate ready must not queue a second initial stats request.
    act(() => {
      first?.deliver?.({ type: "ready", sessionId: "chat-1" } as ChatServerFrame);
    });
    expect(first?.sent.filter((frame) => frame.type === "chat.stats")).toHaveLength(1);
  });
});
