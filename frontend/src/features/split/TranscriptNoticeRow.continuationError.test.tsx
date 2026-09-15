import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatNotice } from "./useChatFrameState";
import { TranscriptNoticeRow } from "./TranscriptNoticeRow";

describe("TranscriptNoticeRow continuation_error", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  const renderRow = (notice: ChatNotice): void => {
    act(() => {
      root.render(<TranscriptNoticeRow notice={notice} />);
    });
  };

  it("renders the continuation failure text visibly, never dropping it", () => {
    renderRow({
      id: 1,
      kind: "continuation_error",
      payload: { message: "provider stream ended mid-turn" } as ChatNotice["payload"],
      at: 1_000,
    });
    const row = container.querySelector(".th-chat-notice");
    expect(row, "notice box for continuation_error").not.toBeNull();
    expect(row?.textContent).toContain("provider stream ended mid-turn");
  });

  it("keeps the kind visible when the payload carries no text fields", () => {
    renderRow({ id: 2, kind: "continuation_error", payload: null, at: 2_000 });
    expect(container.textContent).toContain("continuation_error");
  });
});
