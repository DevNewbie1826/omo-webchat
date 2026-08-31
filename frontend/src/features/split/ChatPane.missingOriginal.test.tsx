import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import { ControlledResizeObserver, renderChatPane } from "./chatPaneTestHarness";

type ResumeCandidate = {
  readonly id: string;
  readonly name: string;
  readonly hostPath?: string;
};

function parsedFrame(raw: Record<string, unknown>): ChatServerFrame {
  const frame = parseChatServerFrame(raw);
  if (frame === null) throw new Error("expected a valid chat server frame");
  return frame;
}

function resumeFailedFrame(
  branchCandidates: readonly ResumeCandidate[],
): ChatServerFrame {
  return parsedFrame({
    type: "error",
    sessionId: "chat-1",
    code: "resume_failed",
    dangling: true,
    message: "boom /path.jsonl",
    branchCandidates,
  });
}

describe("ChatPane missing-original banner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    ControlledResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    ControlledResizeObserver.instances = [];
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the missing-original banner and candidate name, not the raw resume error", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(
        resumeFailedFrame([{ id: "c1", name: "부모세션", hostPath: "/x.jsonl" }]),
      );
      deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    });

    expect(container.textContent).toContain("chat.missingOriginalElsewhere");
    expect(container.textContent).toContain("부모세션");
    expect(container.textContent).not.toContain("boom /path.jsonl");
    expect(container.querySelector(".th-chat-loading")).toBeNull();
    expect(container.querySelector(".th-chat-input")).not.toBeNull();
  });

  it("shows the empty-candidate copy when resume_failed carries no branches", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(resumeFailedFrame([]));
      deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    });

    expect(container.textContent).toContain("chat.missingOriginalNone");
    expect(container.querySelector(".th-chat-input")).not.toBeNull();
  });

  it("keeps the missing-original banner after a later run.started frame", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver(
        resumeFailedFrame([{ id: "c1", name: "부모세션", hostPath: "/x.jsonl" }]),
      );
      deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    });
    expect(container.textContent).toContain("chat.missingOriginalElsewhere");

    act(() => {
      deliver({ type: "run.started", sessionId: "chat-1" });
    });
    expect(container.textContent).toContain("chat.missingOriginalElsewhere");
    expect(container.textContent).toContain("부모세션");
  });

  it.each([undefined, false] as const)(
    "leaves resume_failed with dangling %s as raw text with no missing-original banner",
    (dangling) => {
      const { deliver } = renderChatPane(root);

      act(() => {
        deliver(parsedFrame({
          type: "error",
          code: "resume_failed",
          ...(dangling !== undefined ? { dangling } : {}),
          message: "boom",
        }));
      });

      expect(container.textContent).not.toContain("chat.missingOriginal");
      expect(container.textContent).not.toContain("chat.missingOriginalElsewhere");
      expect(container.textContent).not.toContain("chat.missingOriginalNone");
      expect(container.textContent).toContain("boom");
    },
  );

  it("leaves ordinary errors as raw text with no missing-original banner", () => {
    const { deliver } = renderChatPane(root);

    act(() => {
      deliver({ type: "error", message: "boom" });
    });

    expect(container.textContent).not.toContain("chat.missingOriginal");
    expect(container.textContent).not.toContain("chat.missingOriginalNone");
    expect(container.textContent).toContain("boom");
  });
});
