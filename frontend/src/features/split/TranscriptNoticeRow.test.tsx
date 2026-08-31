import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import type { ChatNotice } from "./useChatFrameState";
import { TranscriptNoticeRow } from "./TranscriptNoticeRow";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key) => key,
};

function payload(values: Record<string, unknown>): ChatNotice["payload"] {
  return values as ChatNotice["payload"];
}

function notice(id: number, kind: string, values?: Record<string, unknown>): ChatNotice {
  return { id, kind, payload: values ? payload(values) : null, at: 1_000 + id };
}

describe("TranscriptNoticeRow", () => {
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

  const renderRow = (notice: ChatNotice, onDismiss: (id: number) => void = () => undefined): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <TranscriptNoticeRow notice={notice} onDismiss={onDismiss} />
        </I18nContext.Provider>,
      );
    });
  };

  const renderRows = (notices: readonly ChatNotice[], onDismiss: (id: number) => void): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          {notices.map((notice) => (
            <TranscriptNoticeRow key={notice.id} notice={notice} onDismiss={onDismiss} />
          ))}
        </I18nContext.Provider>,
      );
    });
  };

  it("labels the block as a system row", () => {
    renderRow(notice(1, "auto_retry_start", { message: "first" }));
    expect(container.textContent).toContain("notice.system");
  });

  it("renders the rich fallback-applied line with from, to, and reason as a warning", () => {
    renderRow(notice(1, "retry_fallback_applied", {
      from: "zai/glm",
      to: "moonshot/kimi",
      chainKey: "main",
      reason: "rate_limited",
    }));
    expect(container.textContent).toContain("notice.fallbackApplied");
    expect(container.textContent).toContain("zai/glm");
    expect(container.textContent).toContain("moonshot/kimi");
    expect(container.textContent).toContain("notice.fallbackReason");
    expect(container.textContent).toContain("rate_limited");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    expect(container.querySelector(".th-alert--info")).toBeNull();
  });

  it("renders the fallback-reverted line with from and to", () => {
    renderRow(notice(1, "retry_fallback_reverted", { from: "moonshot/kimi", to: "zai/glm" }));
    expect(container.textContent).toContain("notice.fallbackReverted");
    expect(container.textContent).toContain("moonshot/kimi");
    expect(container.textContent).toContain("zai/glm");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("renders the high-reasoning warning with provider/model, thinking level, and guidance", () => {
    renderRow(notice(1, "high_reasoning_warning", {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "high",
    }));
    expect(container.textContent).toContain("notice.highReasoningWarning");
    expect(container.textContent).toContain("zai/glm-5.2");
    expect(container.textContent).toContain("high");
    expect(container.textContent).toContain("notice.highReasoningGuidance");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("renders the server fallback-aborted line with from and to", () => {
    renderRow(notice(1, "server_fallback_aborted", { from: "a/one", to: "b/two", chainConfigured: true }));
    expect(container.textContent).toContain("notice.fallbackAborted");
    expect(container.textContent).toContain("a/one");
    expect(container.textContent).toContain("b/two");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("renders extension_notify as info with title and message", () => {
    renderRow(notice(1, "extension_notify", { id: "n1", message: "Disk almost full", title: "Storage" }));
    expect(container.textContent).toContain("Storage");
    expect(container.textContent).toContain("Disk almost full");
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
    expect(container.querySelector(".th-alert--warning")).toBeNull();
  });

  it("renders an unknown kind generically without crashing", () => {
    renderRow(notice(1, "brand_new_unknown_kind", { message: "hello there" }));
    expect(container.textContent).toContain("brand_new_unknown_kind");
    expect(container.textContent).toContain("hello there");
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
  });

  it("localizes fallback success instead of rendering its wire kind", () => {
    renderRow(notice(1, "retry_fallback_succeeded", { to: "zai/glm" }));
    expect(container.textContent).toContain("notice.fallbackSucceeded");
    expect(container.textContent).toContain("zai/glm");
    expect(container.textContent).not.toContain("retry_fallback_succeeded");
  });

  it("localizes fallback exhaustion with a warning tone", () => {
    renderRow(notice(1, "retry_fallback_exhausted", { chainKey: "main" }));
    expect(container.textContent).toContain("notice.fallbackExhausted");
    expect(container.textContent).toContain("main");
    expect(container.textContent).not.toContain("retry_fallback_exhausted");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("dismiss reports only the dismissed row's id to the pane", () => {
    const dismissed: number[] = [];
    renderRows(
      [notice(1, "auto_retry_start", { message: "first" }), notice(2, "auto_retry_end")],
      (id) => dismissed.push(id),
    );
    const row = [...container.querySelectorAll(".th-chat-notice")].find((block) =>
      block.textContent?.includes("first"),
    );
    const dismiss = row?.querySelector("button[aria-label='notice.dismiss']");
    expect(dismiss).not.toBeNull();
    act(() => {
      (dismiss as HTMLButtonElement).click();
    });
    expect(dismissed).toEqual([1]);
    // Hiding is the pane's decision: the row itself keeps rendering its notice.
    expect(container.querySelectorAll(".th-chat-notice").length).toBe(2);
  });
});
