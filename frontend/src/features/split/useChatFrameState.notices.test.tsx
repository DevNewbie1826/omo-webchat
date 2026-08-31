import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { useChatFrameState, type ChatNotice } from "./useChatFrameState";

interface ProbeState {
  readonly notices: readonly ChatNotice[];
  readonly handleFrame: (frame: ChatServerFrame) => void;
}

let captured: ProbeState | null = null;

function Probe(): null {
  const state = useChatFrameState();
  captured = { notices: state.notices, handleFrame: state.handleFrame };
  return null;
}

function noticeWire(seq: number, at?: unknown): Record<string, unknown> {
  return {
    type: "notice",
    sessionId: "chat-1",
    kind: "auto_retry_start",
    payload: { message: `n${seq}` },
    ...(at !== undefined ? { at } : {}),
  };
}

function deliver(frame: unknown): void {
  const parsed = parseChatServerFrame(frame);
  if (parsed) captured?.handleFrame(parsed);
}

function messageOf(notice: ChatNotice | undefined): string | undefined {
  const text = notice?.payload?.["message"];
  return typeof text === "string" ? text : undefined;
}

describe("useChatFrameState notice durability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    captured = null;
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
    vi.restoreAllMocks();
  });

  const renderProbe = (): void => {
    act(() => {
      root.render(<Probe />);
    });
  };

  it("keeps the newest 50 of 51 delivered notices", () => {
    renderProbe();
    act(() => {
      for (let seq = 1; seq <= 51; seq += 1) deliver(noticeWire(seq));
    });
    expect(captured?.notices.length).toBe(50);
    expect(messageOf(captured?.notices[0])).toBe("n51");
    expect(messageOf(captured?.notices[49])).toBe("n2");
    expect(captured?.notices.some((notice) => messageOf(notice) === "n1")).toBe(false);
  });

  it("reconciles a durable reconnect replay by server notice id", () => {
    renderProbe();
    const replay = {
      type: "notice",
      sessionId: "chat-1",
      kind: "retry_fallback_succeeded",
      payload: { to: "provider/model" },
      at: "2026-01-02T03:04:05.123456789Z",
      nid: "session-a:1",
    };
    act(() => {
      deliver(replay);
      deliver(replay);
    });
    expect(captured?.notices).toHaveLength(1);
    expect(captured?.notices[0]?.nid).toBe("session-a:1");
  });

  it("renders identical durable notices when their server ids differ", () => {
    renderProbe();
    const notice = {
      type: "notice",
      sessionId: "chat-1",
      kind: "high_reasoning_warning",
      payload: { modelId: "same" },
      at: "2026-01-02T03:04:05.123456789Z",
    };
    act(() => {
      deliver({ ...notice, nid: "session-a:1" });
      deliver({ ...notice, nid: "session-a:2" });
    });
    expect(captured?.notices).toHaveLength(2);
  });

  it("uses the server at stamp, parsed to epoch milliseconds", () => {
    renderProbe();
    const at = "2026-01-02T03:04:05.123456789Z";
    act(() => {
      deliver(noticeWire(1, at));
    });
    expect(captured?.notices[0]?.at).toBe(Date.parse(at));
  });

  it("stamps the client clock when the server at is absent or invalid", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567_890);
    renderProbe();
    act(() => {
      deliver(noticeWire(1));
      deliver(noticeWire(2, "not-a-timestamp"));
      deliver(noticeWire(3, 5));
      deliver(noticeWire(4, ""));
    });
    for (const notice of captured?.notices ?? []) {
      expect(notice.at).toBe(1_234_567_890);
    }
    expect(captured?.notices.length).toBe(4);
  });
});
