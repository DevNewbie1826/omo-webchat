import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { recordSteerMark, steerMarks } from "./chatSteerMarks";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

/** One persisted branch entry, in the shape the history stream carries. */
function entry(id: string, role: string, text: string, ts: number): unknown {
  return { id, type: "message", message: { role, content: text, timestamp: ts } };
}

/** Sixty-two user turns in branch order, e-1 (root) through e-62 (leaf). */
function branch62(): unknown[] {
  return Array.from({ length: 62 }, (_, index) =>
    entry(`e-${index + 1}`, "user", `turn ${index + 1}`, (index + 1) * 10));
}

describe("useChatSession progressive steer marks", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession> | undefined;
  let sent: ChatClientFrame[];
  let deliver: (frame: ChatServerFrame) => void;

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    const connect: ChatConnector = (handlers) => {
      handlers.onOpen?.();
      deliver = handlers.onFrame;
      return { send: (frame) => { sent.push(frame); return true; }, close: () => undefined };
    };
    function Probe() {
      current = useChatSession(session, connect);
      return null;
    }
    act(() => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  function steerRequestId(): string {
    const frame = sent.find((candidate) => candidate.type === "chat.send" && candidate.run.kind === "steer");
    if (frame?.type !== "chat.send" || !frame.requestId) throw new Error("missing steer request identity");
    return frame.requestId;
  }

  it("keeps a saved mark addressed past the loaded tail when run.done arrives mid-warm", () => {
    // The mark names the 62nd user turn from the branch root; only the last
    // 60 entries are loaded when the run settles, so a loaded-count prune
    // would destroy a valid mark.
    recordSteerMark(session.id, { requestId: "req-old", text: "turn 62", ordinal: 62 });
    const branch = branch62();

    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(2),
      final: true,
      historyComplete: false,
    }));
    act(() => deliver({ type: "run.done", sessionId: session.id, reason: "stop" }));

    expect(steerMarks(session.id)).toContainEqual({ requestId: "req-old", text: "turn 62", ordinal: 62 });

    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(0, 2),
      final: false,
      segment: "head",
      historyComplete: true,
    }));

    expect(steerMarks(session.id)).toContainEqual({ requestId: "req-old", text: "turn 62", ordinal: 62 });
    expect(current?.messages.find((message) => message.id === "e-62")?.customType).toBe("steer");
  });

  it("resolves a steer sent while warming to its root-relative ordinal once history completes", () => {
    // 62 user turns on the branch; the tail holds the last 60. A same-text
    // decoy at root-relative ordinal 61 must NOT absorb the mark: the steer
    // becomes the 63rd user message.
    const branch = branch62();
    branch[60] = entry("e-61", "user", "warm steer", 610);

    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(2),
      final: true,
      historyComplete: false,
    }));
    act(() => deliver({ type: "run.started", sessionId: session.id }));
    act(() => current?.steer("warm steer"));
    const requestId = steerRequestId();

    // The bounded tail cannot resolve a root-relative ordinal yet.
    expect(steerMarks(session.id)).toEqual([]);

    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(0, 2),
      final: false,
      segment: "head",
      historyComplete: true,
    }));

    expect(steerMarks(session.id)).toContainEqual({ requestId, text: "warm steer", ordinal: 63 });

    act(() => deliver({
      type: "message",
      sessionId: session.id,
      message: { role: "user", blocks: [{ kind: "text", text: "warm steer" }], ts: 9999 },
    }));

    const echo = current?.messages.at(-1);
    expect(echo?.customType).toBe("steer");
    expect(current?.messages.find((message) => message.id === "e-61")?.customType).toBeUndefined();
  });

  it("records a steer immediately when the terminal page already reaches the root", () => {
    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "one", 10), entry("e-2", "user", "two", 20)],
      final: true,
    }));
    act(() => deliver({ type: "run.started", sessionId: session.id }));
    act(() => current?.steer("root steer"));

    expect(steerMarks(session.id)).toContainEqual({
      requestId: steerRequestId(),
      text: "root steer",
      ordinal: 3,
    });
  });

  it("still prunes a stale mark at run.done once the branch root is held", () => {
    recordSteerMark(session.id, { requestId: "req-stale", text: "gone", ordinal: 5 });
    act(() => deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "one", 10), entry("e-2", "user", "two", 20)],
      final: true,
    }));
    act(() => deliver({ type: "run.done", sessionId: session.id, reason: "stop" }));

    expect(steerMarks(session.id)).toEqual([]);
  });
});
