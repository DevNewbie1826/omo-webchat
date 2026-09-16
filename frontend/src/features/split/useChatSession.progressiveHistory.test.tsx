import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { messageText, type UiMessage } from "./chatEntries";
import { recordSteerMark } from "./chatSteerMarks";
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

interface Probe {
  readonly deliver: (frame: ChatServerFrame) => void;
  readonly state: () => ReturnType<typeof useChatSession>;
}

describe("useChatSession progressive history", () => {
  const mounted: Root[] = [];
  const containers: HTMLDivElement[] = [];

  function mount(): Probe {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    containers.push(container);
    mounted.push(root);
    let deliver: ((frame: ChatServerFrame) => void) | undefined;
    let current: ReturnType<typeof useChatSession> | undefined;
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      handlers.onOpen?.();
      return { send: () => true, close: () => undefined };
    };
    function Harness() {
      current = useChatSession(session, connect);
      return null;
    }
    act(() => root.render(<Harness />));
    return {
      deliver: (frame) => {
        if (!deliver) throw new Error("connector never bound a frame handler");
        deliver(frame);
      },
      state: () => {
        if (!current) throw new Error("probe never rendered");
        return current;
      },
    };
  }

  beforeEach(() => {
    window.sessionStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of mounted.splice(0)) root.unmount();
    });
    for (const container of containers.splice(0)) container.remove();
    vi.unstubAllGlobals();
  });

  it("opens the pane on a terminal tail page and clears the loading state", () => {
    const probe = mount();
    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-5", "user", "tail question", 50), entry("e-6", "assistant", "tail answer", 60)],
      final: true,
      historyComplete: false,
    }));

    expect(probe.state().messages.map(messageText)).toEqual(["tail question", "tail answer"]);
    expect(probe.state().historyStatus).toBe("loaded");
    expect(probe.state().historyLoaded).toBe(true);
  });

  it("prepends a following head page without re-pinning the viewport", () => {
    const probe = mount();
    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-3", "user", "three", 30), entry("e-4", "assistant", "four", 40)],
      final: true,
      historyComplete: false,
    }));
    const openedAt = probe.state().restoreVersion;

    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "one", 10), entry("e-2", "assistant", "two", 20)],
      final: false,
      segment: "head",
      historyComplete: true,
    }));

    expect(probe.state().messages.map(messageText)).toEqual(["one", "two", "three", "four"]);
    expect(probe.state().messages.map((message) => message.id)).toEqual(["e-1", "e-2", "e-3", "e-4"]);
    // A warm chunk lands behind the reader: it must not restore the viewport.
    expect(probe.state().restoreVersion).toBe(openedAt);
  });

  it("matches a single legacy full stream after two ordered head pages", () => {
    const branch = [
      entry("e-1", "user", "one", 10),
      entry("e-2", "assistant", "two", 20),
      entry("e-3", "user", "three", 30),
      entry("e-4", "assistant", "four", 40),
      entry("e-5", "user", "five", 50),
      entry("e-6", "assistant", "six", 60),
    ];

    const progressive = mount();
    act(() => progressive.deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(4),
      final: true,
      historyComplete: false,
    }));
    act(() => progressive.deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(2, 4),
      final: false,
      segment: "head",
    }));
    act(() => progressive.deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch.slice(0, 2),
      final: false,
      segment: "head",
      historyComplete: true,
    }));

    const legacy = mount();
    act(() => legacy.deliver({
      type: "entries",
      sessionId: session.id,
      entries: branch,
      final: true,
    }));

    const expected: readonly UiMessage[] = legacy.state().messages;
    expect(expected.map(messageText)).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(progressive.state().messages).toEqual(expected);
  });

  it("applies steer marks on a terminal page that already reaches the root", () => {
    // historyComplete true on the terminal page: the tail IS the whole branch,
    // so root-counted ordinals resolve at once and no head chunk follows.
    recordSteerMark(session.id, { requestId: "req-1", text: "do it", ordinal: 1 });
    const probe = mount();

    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "do it", 10), entry("e-2", "assistant", "answer", 20)],
      final: true,
      historyComplete: true,
    }));

    expect(probe.state().messages
      .filter((message) => message.customType === "steer")
      .map((message) => message.id)).toEqual(["e-1"]);
  });

  it("applies steer marks on a legacy terminal page carrying neither field", () => {
    // Absent segment and historyComplete keep today's meaning: the terminal
    // page is the whole branch, exactly as an older server streams it.
    recordSteerMark(session.id, { requestId: "req-1", text: "do it", ordinal: 1 });
    const probe = mount();

    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "do it", 10), entry("e-2", "assistant", "answer", 20)],
      final: true,
    }));

    expect(probe.state().messages
      .filter((message) => message.customType === "steer")
      .map((message) => message.id)).toEqual(["e-1"]);
  });

  it("applies steer marks only once historyComplete has arrived", () => {
    // The mark's ordinal counts user messages from the branch root: the first
    // user message of the whole branch lives in the head chunk, and the tail
    // carries a later user turn with identical text.
    recordSteerMark(session.id, { requestId: "req-1", text: "do it", ordinal: 1 });
    const probe = mount();

    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-3", "user", "do it", 30), entry("e-4", "assistant", "tail answer", 40)],
      final: true,
      historyComplete: false,
    }));
    expect(probe.state().messages.map((message) => message.customType)).toEqual([undefined, undefined]);

    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "do it", 10), entry("e-2", "assistant", "head answer", 20)],
      final: false,
      segment: "head",
      historyComplete: true,
    }));

    expect(probe.state().messages
      .filter((message) => message.customType === "steer")
      .map((message) => message.id)).toEqual(["e-1"]);
  });

  it("ignores a head chunk that arrives before its tail", () => {
    const probe = mount();
    act(() => probe.deliver({
      type: "entries",
      sessionId: session.id,
      entries: [entry("e-1", "user", "orphan head", 10)],
      final: false,
      segment: "head",
      historyComplete: true,
    }));

    expect(probe.state().messages).toEqual([]);
    expect(probe.state().historyStatus).toBe("loading");
  });
});
