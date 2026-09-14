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

/** The always-visible payload JSON (no disclosure interaction required). */
function payloadJson(container: HTMLElement): Record<string, unknown> {
  const text = container.querySelector(".th-notice-payload")?.textContent;
  expect(text, "expected always-visible payload JSON").toBeTruthy();
  return JSON.parse(text ?? "") as Record<string, unknown>;
}

/** The original payload object inside the `{ type, payload }` wrapper. */
function innerPayload(container: HTMLElement): Record<string, unknown> {
  return payloadJson(container)["payload"] as Record<string, unknown>;
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

  it("renders every payload field fully expanded without any interaction", () => {
    renderRow(notice(1, "auto_retry_start", { message: "m1", reason: "r1", chainKey: "c1" }));
    expect(container.textContent).toContain("m1");
    expect(container.textContent).toContain("r1");
    expect(container.textContent).toContain("c1");
    expect(container.querySelector("details")).toBeNull();
    const json = payloadJson(container);
    const inner = innerPayload(container);
    expect(inner["message"]).toBe("m1");
    expect(inner["reason"]).toBe("r1");
    expect(inner["chainKey"]).toBe("c1");
    expect(json["type"]).toBe("auto_retry_start");
  });

  it("renders a receipt-time element with a stable hook", () => {
    renderRow(notice(1, "auto_retry_start", { message: "m1" }));
    const time = container.querySelector(".th-notice-time");
    expect(time).not.toBeNull();
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("renders warning-kind and unknown-kind rows with the same uniform structure", () => {
    renderRows([
      notice(1, "retry_fallback_applied", { message: "warn" }),
      notice(2, "brand_new_unknown_kind", { message: "info" }),
    ]);
    const rows = [...container.querySelectorAll(".th-chat-notice")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector(".th-alert--warning")).toBeNull();
      expect(row.querySelector("details")).toBeNull();
      expect(row.querySelector(".th-notice-payload")).not.toBeNull();
      expect(row.querySelector(".th-notice-time")).not.toBeNull();
    }
    expect(rows.map((row) => row.className)).toEqual([
      "th-chat-notice th-alert th-alert--info",
      "th-chat-notice th-alert th-alert--info",
    ]);
  });

  it("renders the fallback-applied payload fully expanded with the kind as type", () => {
    renderRow(notice(1, "retry_fallback_applied", {
      from: "zai/glm",
      to: "moonshot/kimi",
      chainKey: "main",
      reason: "rate_limited",
    }));
    expect(container.textContent).not.toContain("notice.fallbackApplied");
    expect(container.textContent).not.toContain("notice.fallbackReason");
    const json = payloadJson(container);
    const inner = innerPayload(container);
    expect(inner["from"]).toBe("zai/glm");
    expect(inner["to"]).toBe("moonshot/kimi");
    expect(inner["chainKey"]).toBe("main");
    expect(inner["reason"]).toBe("rate_limited");
    expect(json["type"]).toBe("retry_fallback_applied");
  });

  it("renders the fallback-reverted payload fully expanded", () => {
    renderRow(notice(1, "retry_fallback_reverted", { from: "moonshot/kimi", to: "zai/glm" }));
    expect(container.textContent).not.toContain("notice.fallbackReverted");
    const json = payloadJson(container);
    const inner = innerPayload(container);
    expect(inner["from"]).toBe("moonshot/kimi");
    expect(inner["to"]).toBe("zai/glm");
    expect(json["type"]).toBe("retry_fallback_reverted");
  });

  it("renders the high-reasoning payload fully expanded with no guidance copy", () => {
    renderRow(notice(1, "high_reasoning_warning", {
      provider: "zai",
      modelId: "glm-5.2",
      thinkingLevel: "high",
    }));
    expect(container.textContent).not.toContain("notice.highReasoningWarning");
    expect(container.textContent).not.toContain("notice.highReasoningGuidance");
    const inner = innerPayload(container);
    expect(inner["provider"]).toBe("zai");
    expect(inner["modelId"]).toBe("glm-5.2");
    expect(inner["thinkingLevel"]).toBe("high");
  });

  it("renders the server fallback-aborted payload fully expanded", () => {
    renderRow(notice(1, "server_fallback_aborted", { from: "a/one", to: "b/two", chainConfigured: true }));
    expect(container.textContent).not.toContain("notice.fallbackAborted");
    const inner = innerPayload(container);
    expect(inner["from"]).toBe("a/one");
    expect(inner["to"]).toBe("b/two");
    expect(inner["chainConfigured"]).toBe(true);
  });

  it("renders extension_notify fully expanded with id, message, and title", () => {
    renderRow(notice(1, "extension_notify", { id: "n1", message: "Disk almost full", title: "Storage" }));
    expect(container.textContent).toContain("Disk almost full");
    const json = payloadJson(container);
    const inner = innerPayload(container);
    expect(inner["id"]).toBe("n1");
    expect(inner["message"]).toBe("Disk almost full");
    expect(inner["title"]).toBe("Storage");
    expect(json["type"]).toBe("extension_notify");
  });

  it("renders an unknown kind generically without crashing", () => {
    renderRow(notice(1, "brand_new_unknown_kind", { message: "hello there" }));
    expect(container.textContent).toContain("hello there");
    expect(container.querySelector("details")).toBeNull();
    expect(payloadJson(container)).toEqual({
      type: "brand_new_unknown_kind",
      payload: { message: "hello there" },
    });
  });

  it("renders fallback success fully expanded", () => {
    renderRow(notice(1, "retry_fallback_succeeded", { to: "zai/glm" }));
    expect(container.textContent).not.toContain("notice.fallbackSucceeded");
    const json = payloadJson(container);
    const inner = innerPayload(container);
    expect(inner["to"]).toBe("zai/glm");
    expect(json["type"]).toBe("retry_fallback_succeeded");
  });

  it("renders fallback exhaustion fully expanded", () => {
    renderRow(notice(1, "retry_fallback_exhausted", { chainKey: "main" }));
    expect(container.textContent).not.toContain("notice.fallbackExhausted");
    const inner = innerPayload(container);
    expect(inner["chainKey"]).toBe("main");
  });

  it.each<[Lang, string]>([
    ["en", "Auto retry started"],
    ["ko", "자동 재시도 시작"],
  ])("shows the auto-retry start payload expanded without translated prose (%s)", (lang, started) => {
    renderRow(notice(1, "auto_retry_start", { message: "attempt 2" }), lang);
    expect(container.textContent).toContain("attempt 2");
    expect(container.textContent).not.toContain(started);
    expect(container.querySelector("details")).toBeNull();
    expect(payloadJson(container)).toEqual({
      type: "auto_retry_start",
      payload: { message: "attempt 2" },
    });
  });

  it.each<[Lang, string]>([
    ["en", "Auto retry ended"],
    ["ko", "자동 재시도 종료"],
  ])("renders a null payload as the kind-only JSON object (%s)", (lang, ended) => {
    renderRow(notice(1, "auto_retry_end"), lang);
    expect(container.textContent).not.toContain(ended);
    expect(container.querySelector("details")).toBeNull();
    expect(payloadJson(container)).toEqual({ type: "auto_retry_end", payload: null });
  });

  it("preserves a payload's own type field alongside the wire kind", () => {
    renderRow(notice(1, "auto_retry_start", { type: "QA_ORIGINAL_TYPE", message: "m1" }));
    const json = payloadJson(container);
    expect(json["type"]).toBe("auto_retry_start");
    const inner = json["payload"] as Record<string, unknown>;
    expect(inner["type"]).toBe("QA_ORIGINAL_TYPE");
    expect(inner["message"]).toBe("m1");
  });

  it("renders no dismiss button", () => {
    renderRows([notice(1, "auto_retry_start", { message: "first" }), notice(2, "auto_retry_end")]);
    const row = [...container.querySelectorAll(".th-chat-notice")].find((block) =>
      block.textContent?.includes("first"),
    );
    expect(row?.querySelectorAll("button").length).toBe(0);
  });
});
