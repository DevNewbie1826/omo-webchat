import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue, type Lang } from "../../i18n";
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

/** Real app translation tables, so assertions can check rendered labels. */
function realI18n(lang: Lang): I18nValue {
  return { ...i18n, lang, t: (key) => translate(lang, key) };
}

function payload(values: Record<string, unknown>): ChatNotice["payload"] {
  return values as ChatNotice["payload"];
}

function notice(id: number, kind: string, values?: Record<string, unknown>): ChatNotice {
  return { id, kind, payload: values ? payload(values) : null, at: 1_000 + id };
}

function payloadDetails(container: HTMLElement): Record<string, unknown> {
  const text = container.querySelector("details pre")?.textContent;
  expect(text, "expected collapsed payload JSON").toBeTruthy();
  return JSON.parse(text ?? "") as Record<string, unknown>;
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

  const renderRow = (notice: ChatNotice, lang?: Lang): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={lang === undefined ? i18n : realI18n(lang)}>
          <TranscriptNoticeRow notice={notice} />
        </I18nContext.Provider>,
      );
    });
  };

  const renderRows = (notices: readonly ChatNotice[]): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          {notices.map((entry) => (
            <TranscriptNoticeRow key={entry.id} notice={entry} />
          ))}
        </I18nContext.Provider>,
      );
    });
  };

  it("labels the block as a system row", () => {
    renderRow(notice(1, "auto_retry_start", { message: "first" }));
    expect(container.textContent).toContain("notice.system");
  });

  it("renders the fallback-applied kind raw with payload fields in collapsed JSON as a warning", () => {
    renderRow(notice(1, "retry_fallback_applied", {
      from: "zai/glm",
      to: "moonshot/kimi",
      chainKey: "main",
      reason: "rate_limited",
    }));
    expect(container.textContent).toContain("retry_fallback_applied");
    expect(container.textContent).not.toContain("notice.fallbackApplied");
    expect(container.textContent).not.toContain("notice.fallbackReason");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    expect(container.querySelector(".th-alert--info")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    const json = payloadDetails(container);
    expect(json["from"]).toBe("zai/glm");
    expect(json["to"]).toBe("moonshot/kimi");
    expect(json["chainKey"]).toBe("main");
    expect(json["reason"]).toBe("rate_limited");
  });

  it("renders the fallback-reverted kind raw with from and to in payload JSON", () => {
    renderRow(notice(1, "retry_fallback_reverted", { from: "moonshot/kimi", to: "zai/glm" }));
    expect(container.textContent).toContain("retry_fallback_reverted");
    expect(container.textContent).not.toContain("notice.fallbackReverted");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    const json = payloadDetails(container);
    expect(json["from"]).toBe("moonshot/kimi");
    expect(json["to"]).toBe("zai/glm");
  });

  it("renders the high-reasoning kind raw with payload JSON and no guidance copy", () => {
    renderRow(notice(1, "high_reasoning_warning", {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "high",
    }));
    expect(container.textContent).toContain("high_reasoning_warning");
    expect(container.textContent).not.toContain("notice.highReasoningWarning");
    expect(container.textContent).not.toContain("notice.highReasoningGuidance");
    expect(container.textContent).not.toContain("zai/glm-5.2");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    const json = payloadDetails(container);
    expect(json["provider"]).toBe("zai");
    expect(json["modelId"]).toBe("glm-5.2");
    expect(json["thinkingLevel"]).toBe("high");
  });

  it("renders the server fallback-aborted kind raw with from and to in payload JSON", () => {
    renderRow(notice(1, "server_fallback_aborted", { from: "a/one", to: "b/two", chainConfigured: true }));
    expect(container.textContent).toContain("server_fallback_aborted");
    expect(container.textContent).not.toContain("notice.fallbackAborted");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    const json = payloadDetails(container);
    expect(json["from"]).toBe("a/one");
    expect(json["to"]).toBe("b/two");
    expect(json["chainConfigured"]).toBe(true);
  });

  it("renders extension_notify as info with the raw kind, message, and payload JSON", () => {
    renderRow(notice(1, "extension_notify", { id: "n1", message: "Disk almost full", title: "Storage" }));
    expect(container.textContent).toContain("extension_notify");
    expect(container.textContent).toContain("Disk almost full");
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
    expect(container.querySelector(".th-alert--warning")).toBeNull();
    const json = payloadDetails(container);
    expect(json["id"]).toBe("n1");
    expect(json["message"]).toBe("Disk almost full");
    expect(json["title"]).toBe("Storage");
  });

  it("renders an unknown kind generically without crashing", () => {
    renderRow(notice(1, "brand_new_unknown_kind", { message: "hello there" }));
    expect(container.textContent).toContain("brand_new_unknown_kind");
    expect(container.textContent).toContain("hello there");
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(payloadDetails(container)).toEqual({ message: "hello there" });
  });

  it("renders fallback success as the wire kind with payload JSON", () => {
    renderRow(notice(1, "retry_fallback_succeeded", { to: "zai/glm" }));
    expect(container.textContent).toContain("retry_fallback_succeeded");
    expect(container.textContent).not.toContain("notice.fallbackSucceeded");
    const json = payloadDetails(container);
    expect(json["to"]).toBe("zai/glm");
  });

  it("renders fallback exhaustion as the wire kind with a warning tone", () => {
    renderRow(notice(1, "retry_fallback_exhausted", { chainKey: "main" }));
    expect(container.textContent).toContain("retry_fallback_exhausted");
    expect(container.textContent).not.toContain("notice.fallbackExhausted");
    expect(container.querySelector(".th-alert--warning")).not.toBeNull();
    const json = payloadDetails(container);
    expect(json["chainKey"]).toBe("main");
  });

  it.each<[Lang, string]>([
    ["en", "Auto retry started"],
    ["ko", "자동 재시도 시작"],
  ])("shows the raw auto-retry start kind with its message as an info line (%s)", (lang, started) => {
    renderRow(notice(1, "auto_retry_start", { message: "attempt 2" }), lang);
    expect(container.textContent).toContain("auto_retry_start");
    expect(container.textContent).toContain("attempt 2");
    expect(container.textContent).not.toContain(started);
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
    expect(container.querySelector(".th-alert--warning")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(payloadDetails(container)).toEqual({ message: "attempt 2" });
  });

  it.each<[Lang, string]>([
    ["en", "Auto retry ended"],
    ["ko", "자동 재시도 종료"],
  ])("shows the raw auto-retry end kind as an info line (%s)", (lang, ended) => {
    renderRow(notice(1, "auto_retry_end"), lang);
    expect(container.textContent).toContain("auto_retry_end");
    expect(container.textContent).not.toContain(ended);
    expect(container.querySelector(".th-alert--info")).not.toBeNull();
    expect(container.querySelector(".th-alert--warning")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("renders no dismiss button", () => {
    renderRows([notice(1, "auto_retry_start", { message: "first" }), notice(2, "auto_retry_end")]);
    const row = [...container.querySelectorAll(".th-chat-notice")].find((block) =>
      block.textContent?.includes("first"),
    );
    expect(row?.querySelectorAll("button").length).toBe(0);
  });
});
