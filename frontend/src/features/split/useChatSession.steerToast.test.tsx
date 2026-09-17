import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatComposer } from "./ChatComposer";
import { SessionDraftProvider } from "./sessionDraft";
import { useChatSession } from "./useChatSession";

const session = { id: "steer-toast", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
const sessions = new Map([[session.id, session]]);
type Send = Extract<ChatClientFrame, { type: "chat.send" }>;
const state = (isStreaming = false): ChatServerFrame => ({ type: "state", sessionId: session.id, isStreaming, isCompacting: false });

// The steer summary is a send CONFIRMATION, not the durable record of a parked
// steer: the engine queue mirror owns that. It therefore self-retires shortly
// after the send instead of living until the engine consumes the steer.
describe("useChatSession steer confirmation lifetime", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession>;
  let handlers: Parameters<ChatConnector>[0];
  let sent: ChatClientFrame[];
  let connect: ChatConnector;
  function Probe() {
    current = useChatSession(session, connect);
    return <ChatComposer session={session} commands={[]} running={current.running}
      isCompacting={current.isCompacting} retryDraft={current.retryDraft} onSubmit={current.submit}
      onSteer={current.steer} onStop={current.stop} provider="omo" cwd="/work" />;
  }
  const render = () => act(() => root.render(<SessionDraftProvider sessions={sessions}><Probe /></SessionDraftProvider>));
  const emit = (frame: ChatServerFrame) => act(() => handlers.onFrame(frame));
  const sends = () => sent.filter((frame): frame is Send => frame.type === "chat.send");
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    sent = [];
    connect = callbacks => {
      handlers = callbacks; callbacks.onOpen?.();
      return { send: frame => { sent.push(frame); return true; }, close: () => undefined };
    };
    render(); emit(state());
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function steer(text: string): string {
    emit({ type: "run.started", sessionId: session.id });
    act(() => { current.steer(text); });
    const requestId = sends().at(-1)?.requestId;
    if (!requestId) throw new Error("missing steer request identity");
    return requestId;
  }

  it("keeps the confirmation briefly, then retires it while the run continues", () => {
    const requestId = steer("toast redirect");
    expect(current.steerPending).toEqual([{ requestId, text: "toast redirect" }]);

    advance(2_900);
    expect(current.steerPending).toEqual([{ requestId, text: "toast redirect" }]);

    advance(200);
    expect(current.steerPending).toEqual([]);
    // The confirmation expiring never ends the run or touches the request.
    expect(current.running).toBe(true);
  });

  it("survives a completed ACK inside the confirmation window", () => {
    const requestId = steer("acked redirect");
    emit({ type: "ack", sessionId: session.id, command: "chat.send", requestId, phase: "completed" });
    expect(current.steerPending).toEqual([{ requestId, text: "acked redirect" }]);

    advance(3_100);
    expect(current.steerPending).toEqual([]);
  });

  it("gives each steer its own window instead of one shared timer", () => {
    const first = steer("first redirect");
    advance(2_000);
    const second = steer("second redirect");
    expect(current.steerPending.map((item) => item.requestId)).toEqual([first, second]);

    advance(1_100);
    expect(current.steerPending.map((item) => item.requestId)).toEqual([second]);

    advance(2_000);
    expect(current.steerPending).toEqual([]);
  });
});
