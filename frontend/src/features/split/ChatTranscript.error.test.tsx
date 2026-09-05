import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../../i18n";
import { ChatTranscript } from "./ChatTranscript";
import type { ToolEntry } from "./chatSessionTypes";

const OPEN_FAILED_LONG = `open_failed: QA_CONTEXT_LIMIT 311799 > 272000\n${"T".repeat(600)}\n<img src=x onerror=alert(1)>`;

const baseProps = {
  items: [],
  streaming: "",
  thinking: "",
  toolCalls: {} as Readonly<Record<string, ToolEntry>>,
  doneReason: null,
  restoreVersion: 0,
  focused: true,
  historyLoaded: true,
};

describe("ChatTranscript error text renderer", () => {
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

  it("renders heading plus exact open_failed raw text as inert selectable copy", () => {
    const heading = translate("en", "chat.startFailedHeading");
    const error = `${heading}\n${OPEN_FAILED_LONG}`;
    act(() => {
      root.render(<ChatTranscript {...baseProps} error={error} />);
    });

    const alert = container.querySelector(".th-chat-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe(error);
    expect(alert?.querySelector("img")).toBeNull();
    expect(alert?.querySelector("script")).toBeNull();
    expect(alert?.innerHTML.includes("<img")).toBe(false);
  });
});
