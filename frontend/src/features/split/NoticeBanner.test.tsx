import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import type { ChatNotice } from "./useChatFrameState";
import { NoticeBanner } from "./NoticeBanner";

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

describe("NoticeBanner", () => {
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

  const renderNotices = (notices: readonly ChatNotice[]): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <NoticeBanner notices={notices} />
        </I18nContext.Provider>,
      );
    });
  };

  it("renders the rich fallback-applied line with from, to, and reason as a warning", () => {
    renderNotices([notice(1, "retry_fallback_applied", {
      from: "zai/glm",
      to: "moonshot/kimi",
      chainKey: "main",
      reason: "rate_limited",
    })]);
    expect(container.textContent).toContain("notice.fallbackApplied");
    expect(container.textContent).toContain("zai/glm");
    expect(container.textContent).toContain("moonshot/kimi");
    expect(container.textContent).toContain("notice.fallbackReason");
    expect(container.textContent).toContain("rate_limited");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    expect(container.querySelector(".th-alert--info")).toBeNull();
  });

  it("renders the fallback-reverted line with from and to", () => {
    renderNotices([notice(1, "retry_fallback_reverted", { from: "moonshot/kimi", to: "zai/glm" })]);
    expect(container.textContent).toContain("notice.fallbackReverted");
    expect(container.textContent).toContain("moonshot/kimi");
    expect(container.textContent).toContain("zai/glm");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("renders the high-reasoning warning with provider/model, thinking level, and guidance", () => {
    renderNotices([notice(1, "high_reasoning_warning", {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "high",
    })]);
    expect(container.textContent).toContain("notice.highReasoningWarning");
    expect(container.textContent).toContain("zai/glm-5.2");
    expect(container.textContent).toContain("high");
    expect(container.textContent).toContain("notice.highReasoningGuidance");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("renders the server fallback-aborted line with from and to", () => {
    renderNotices([notice(1, "server_fallback_aborted", { from: "a/one", to: "b/two", chainConfigured: true })]);
    expect(container.textContent).toContain("notice.fallbackAborted");
    expect(container.textContent).toContain("a/one");
    expect(container.textContent).toContain("b/two");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("renders extension_notify as info with title and message", () => {
    renderNotices([notice(1, "extension_notify", { id: "n1", message: "Disk almost full", title: "Storage" })]);
    expect(container.textContent).toContain("Storage");
    expect(container.textContent).toContain("Disk almost full");
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
    expect(container.querySelector(".th-alert--warning")).toBeNull();
  });

  it("renders an unknown kind generically without crashing", () => {
    renderNotices([notice(1, "brand_new_unknown_kind", { message: "hello there" })]);
    expect(container.textContent).toContain("brand_new_unknown_kind");
    expect(container.textContent).toContain("hello there");
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
  });

  it("renders retry_fallback_exhausted with a warning tone", () => {
    renderNotices([notice(1, "retry_fallback_exhausted", { chainKey: "main" })]);
    expect(container.textContent).toContain("retry_fallback_exhausted");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
  });

  it("dismiss removes only the dismissed banner", () => {
    renderNotices([notice(1, "auto_retry_start", { message: "first" }), notice(2, "auto_retry_end")]);
    const dismiss = container.querySelectorAll("button[aria-label='notice.dismiss']");
    expect(dismiss.length).toBe(2);
    act(() => {
      (dismiss[0] as HTMLButtonElement).click();
    });
    expect(container.textContent).not.toContain("first");
    expect(container.textContent).toContain("auto_retry_end");
    expect(container.querySelectorAll(".th-alert").length).toBe(1);
  });

  it("renders nothing without notices", () => {
    renderNotices([]);
    expect(container.querySelector(".th-notice-stack")).toBeNull();
  });
});
