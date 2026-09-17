import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatComposer } from "./ChatComposer";
import { SessionDraftProvider } from "./sessionDraft";
import { useChatSession } from "./useChatSession";

const session = { id: "steer-recovery", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
const sessions = new Map([[session.id, session]]);
type Send = Extract<ChatClientFrame, { type: "chat.send" }>;
const state = (isStreaming = false): ChatServerFrame => ({ type: "state", sessionId: session.id, isStreaming, isCompacting: false });

describe("useChatSession steer summary recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession>;
  let handlers: Parameters<ChatConnector>[0];
  let sent: ChatClientFrame[];
  let connect: ChatConnector;
  let observing: boolean;
  let observerHandlers: Parameters<ChatConnector>[0];
  let observerConnect: ChatConnector;
  function Observer() { useChatSession(session, observerConnect); return null; }
  function Probe() {
    current = useChatSession(session, connect);
    return <ChatComposer session={session} commands={[]} running={current.running}
      isCompacting={current.isCompacting} retryDraft={current.retryDraft} onSubmit={current.submit}
      onSteer={current.steer} onStop={current.stop} provider="omo" cwd="/work" />;
  }
  const render = () => act(() => root.render(<SessionDraftProvider sessions={sessions}><Probe />{observing && <Observer />}</SessionDraftProvider>));
  const emit = (frame: ChatServerFrame) => act(() => handlers.onFrame(frame));
  const sends = () => sent.filter((frame): frame is Send => frame.type === "chat.send");

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    sent = []; observing = false;
    observerConnect = callbacks => { observerHandlers = callbacks; callbacks.onOpen?.(); return { send: () => true, close: () => undefined }; };
    connect = callbacks => {
      handlers = callbacks; callbacks.onOpen?.();
      return { send: frame => { sent.push(frame); return true; }, close: () => undefined };
    };
    render(); emit(state());
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it("retires the originating pane's pending steer when the observer records the rejection first", () => {
    emit({ type: "run.started", sessionId: session.id });
    act(() => { current.steer("observer-first redirect"); });
    const requestId = sends().at(-1)?.requestId;
    if (!requestId) throw new Error("missing steer request identity");
    expect(current.steerPending).toEqual([{ requestId, text: "observer-first redirect" }]);

    observing = true; render();
    const rejection: ChatServerFrame = {
      type: "error",
      sessionId: session.id,
      command: "chat.send",
      requestId,
      code: "send_failed",
      message: "Rejected",
    };
    act(() => observerHandlers.onFrame(rejection));
    expect(current.steerPending).toEqual([{ requestId, text: "observer-first redirect" }]);
    emit(rejection);
    expect(current.steerPending).toEqual([]);
  });

  it("retires pending steers on provider_disconnected after a completed ACK, and keeps them without that error", () => {
    emit({ type: "run.started", sessionId: session.id });
    act(() => { current.steer("parked redirect"); });
    const requestId = sends().at(-1)?.requestId;
    if (!requestId) throw new Error("missing steer request identity");

    emit({ type: "ack", sessionId: session.id, command: "chat.send", requestId, phase: "completed" });
    expect(current.steerPending).toEqual([{ requestId, text: "parked redirect" }]);

    emit({ type: "error", sessionId: session.id, code: "provider_disconnected", message: "provider connection lost" });
    expect(current.steerPending).toEqual([]);
  });
});
