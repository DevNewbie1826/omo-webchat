import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatFrameState } from "./useChatFrameState";
import { parseChatServerFrame } from "../../lib/chatWsParse";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("retains structured questions in pane state when a question frame arrives", () => {
  // Given
  const raw = { type: "approval", sessionId: "s", id: "ask", method: "question", questions: [{ id: "q1", options: [{ label: "Go", description: "Backend" }] }] };
  const frame = parseChatServerFrame(raw);
  const captured: { current?: ReturnType<typeof useChatFrameState> } = {};
  function Probe() { captured.current = useChatFrameState(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Probe />));
    // When
    if (frame === null) throw new Error("question frame rejected");
    act(() => captured.current?.handleFrame(frame));
    // Then
    expect(captured.current).toMatchObject({ pendingQuestion: raw, pendingApproval: null });
  } finally {
    act(() => root.unmount());
  }
});
