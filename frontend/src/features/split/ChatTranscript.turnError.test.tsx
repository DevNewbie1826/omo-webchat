import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./ChatTranscript";
import type { UiMessage } from "./chatEntries";
import type { ToolEntry } from "./chatSessionTypes";
import { mergeTranscriptItems } from "./useChatFrameState";

const baseProps = {
  streaming: "",
  thinking: "",
  toolCalls: {} as Readonly<Record<string, ToolEntry>>,
  doneReason: null,
  error: "",
  restoreVersion: 0,
  focused: true,
  historyLoaded: true,
};

describe("ChatTranscript failed-turn error rendering", () => {
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

  const renderMessages = (messages: readonly UiMessage[]): void => {
    act(() => {
      root.render(<ChatTranscript {...baseProps} items={mergeTranscriptItems(messages, [])} />);
    });
  };

  it("renders the failure text attached to its assistant message, styled as an error", () => {
    renderMessages([
      { id: "u1", role: "user", blocks: [{ kind: "text", text: "hi" }], ts: 1 },
      {
        id: "a1",
        role: "assistant",
        blocks: [{ kind: "text", text: "partial answer" }],
        ts: 2,
        errorMessage: "provider overloaded",
        stopReason: "error",
      },
    ]);
    const row = container.querySelector(".th-chat-row--assistant");
    const error = row?.querySelector(".th-chat-error");
    expect(error, "error row inside the assistant message row").not.toBeNull();
    expect(error?.textContent).toBe("provider overloaded");
    // The partial content still renders above the failure text.
    expect(row?.textContent).toContain("partial answer");
  });

  it("falls back to a generic label when the failed turn carries no text", () => {
    renderMessages([
      { id: "a1", role: "assistant", blocks: [], ts: 2, errorMessage: "", stopReason: "error" },
    ]);
    const error = container.querySelector(".th-chat-row--assistant .th-chat-error");
    expect(error, "generic label for an empty failure text").not.toBeNull();
    expect(error?.textContent).toBe("chat.turnFailed");
  });

  it("shows the generic label when stopReason reports failure and errorMessage is absent", () => {
    renderMessages([
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "cut off" }], ts: 2, stopReason: "error" },
    ]);
    const error = container.querySelector(".th-chat-row--assistant .th-chat-error");
    expect(error?.textContent).toBe("chat.turnFailed");
  });

  it("renders no error row for a user-cancelled turn (stopReason aborted, no errorMessage)", () => {
    // Observed engine contract: the user-stop path stamps stopReason
    // "aborted" together with ordinary text. A cancel is not a failure and
    // must produce no error row (C5: no false alarm).
    renderMessages([
      {
        id: "a1",
        role: "assistant",
        blocks: [{ kind: "text", text: "partial answer before cancel" }],
        ts: 2,
        stopReason: "aborted",
      },
    ]);
    expect(container.querySelector(".th-chat-error")).toBeNull();
    // The partial text itself still renders.
    expect(container.querySelector(".th-chat-row--assistant")?.textContent).toContain("partial answer before cancel");
  });

  it("renders no error row for a successful assistant message", () => {
    renderMessages([
      { id: "a1", role: "assistant", blocks: [{ kind: "text", text: "fine" }], ts: 2, stopReason: "stop" },
    ]);
    expect(container.querySelector(".th-chat-error")).toBeNull();
  });
});
