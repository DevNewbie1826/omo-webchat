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

describe("useChatSession activity freshness wiring", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession> | undefined;
  let deliver: (frame: ChatServerFrame) => void;
  let reopen: () => void;
  let sent: ChatClientFrame[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      reopen = () => handlers.onOpen?.();
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
      current = useChatSession(session, connect);
      return null;
    }
    act(() => root.render(<Probe />));
    // Drop the initial chat.create so assertions see only new outbound frames.
    sent = [];
  });

  afterEach(async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("marks a run in flight on run.started and clears it on run.done", () => {
    expect(current?.activities.runInFlight ?? false).toBe(false);

    act(() => {
      deliver({ type: "run.started", sessionId: session.id });
    });
    expect(current?.activities.runInFlight).toBe(true);

    act(() => {
      deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
    });
    expect(current?.activities.runInFlight ?? false).toBe(false);
  });

  it("synchronizes freshness from attach state and terminal cleanup", () => {
    act(() => {
      deliver({ type: "state", sessionId: session.id, isStreaming: true, isCompacting: false });
    });
    expect(current?.activities.runInFlight).toBe(true);

    act(() => {
      deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
    });
    expect(current?.activities.runInFlight).toBe(false);

    act(() => {
      deliver({ type: "run.started", sessionId: session.id });
      deliver({ type: "error", sessionId: session.id, code: "send_failed", message: "failed" });
    });
    // An uncorrelated send failure is display-only and cannot settle the run.
    expect(current?.activities.runInFlight).toBe(true);
  });

  it("sends activity.refresh when the websocket reconnects, not on the initial open", () => {
    expect(sent).toEqual([]);

    act(() => reopen());

    expect(sent).toContainEqual({ type: "activity.refresh", sessionId: session.id });
  });

  it("sends activity.refresh when the document returns to visible, not when hidden", () => {
    expect(document.visibilityState).toBe("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sent).toContainEqual({ type: "activity.refresh", sessionId: session.id });

    const before = sent.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(sent.length).toBe(before);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });
});
