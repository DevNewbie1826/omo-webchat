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

  describe("engine_notify status rows", () => {
    it("renders the message verbatim as a single dim status line with no JSON and no tag block", () => {
      renderRow(notice(1, "engine_notify", { message: "Reconnecting to the server…" }));
      const row = container.querySelector(".th-notice-status");
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain("Reconnecting to the server…");
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector(".th-chat-notice-tag")).toBeNull();
      // No JSON artifacts: the wire kind must not appear as a quoted key.
      expect(container.textContent).not.toContain('"type"');
      expect(container.textContent).not.toContain('"message"');
      expect(container.textContent).not.toContain("{");
    });

    it("keeps the receipt time on the status row", () => {
      renderRow(notice(1, "engine_notify", { message: "m" }));
      const time = container.querySelector(".th-notice-status .th-notice-time");
      expect(time).not.toBeNull();
      expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("is permanent and non-interactive", () => {
      renderRow(notice(1, "engine_notify", { message: "m" }));
      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(container.querySelector("details")).toBeNull();
    });

    it.each([
      [undefined, "th-notice-status--info"],
      ["info", "th-notice-status--info"],
      ["warning", "th-notice-status--warning"],
      ["error", "th-notice-status--error"],
    ] as const)("maps notifyType %s to the %s tone class", (notifyType, tone) => {
      renderRow(notice(1, "engine_notify", {
        message: "m",
        ...(notifyType === undefined ? {} : { notifyType }),
      }));
      const row = container.querySelector(".th-notice-status");
      expect(row?.className).toContain(tone);
    });

    it("renders a missing message as an empty status line without crashing", () => {
      renderRow(notice(1, "engine_notify", {}));
      expect(container.querySelector(".th-notice-status")).not.toBeNull();
    });
  });

  describe("notice-box format (all other kinds)", () => {
    it("renders a bold title line, the primary line, and remaining fields as dim key: value lines", () => {
      renderRow(notice(1, "brand_new_kind", { title: "Retrying", why: "rate limited", chainKey: "c1" }));
      const title = container.querySelector(".th-notice-title");
      expect(title).not.toBeNull();
      expect(title?.textContent).toBe("Retrying");
      expect(container.textContent).toContain("rate limited");
      expect(container.textContent).toContain("chainKey: c1");
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
      // No JSON.stringify artifacts for these fields.
      expect(container.textContent).not.toContain('"chainKey"');
      expect(container.textContent).not.toContain("{");
    });

    it("keeps a numeric payload.title visible as a key: value line instead of dropping it", () => {
      renderRow(notice(1, "brand_new_kind", { title: 94731, message: "QA_NUMBER_PRIMARY" }));
      // The non-string title must not take the bold-title role…
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("brand_new_kind");
      // …but its value must stay visible as text, not be silently dropped.
      expect(container.textContent).toContain("QA_NUMBER_PRIMARY");
      expect(container.textContent).toContain("title: 94731");
    });

    it("keeps an object payload.title visible as a key: value line instead of dropping it", () => {
      renderRow(notice(1, "brand_new_kind", { title: { code: "QA_TITLE_VALUE" }, why: "QA_PRIMARY" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("brand_new_kind");
      expect(container.textContent).toContain("QA_PRIMARY");
      expect(container.textContent).toContain("QA_TITLE_VALUE");
    });

    it.each<[string, unknown, string]>([
      ["boolean false", false, "title: false"],
      ["boolean true", true, "title: true"],
      ["null", null, "title: null"],
      ["populated array", [0, false, null, { code: "QA_ARRAY_VALUE" }], 'title: 0, false, null, {"code":"QA_ARRAY_VALUE"}'],
      ["empty array", [], "title: "],
    ])("keeps a %s payload.title visible as a key: value line instead of dropping it", (_name, title, expected) => {
      renderRow(notice(1, "brand_new_kind", { title, why: "QA_PRIMARY", message: "QA_SECONDARY" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("brand_new_kind");
      expect([...container.querySelectorAll(".th-notice-line")].map((el) => el.textContent)).toEqual([
        "QA_PRIMARY",
        expected,
        "message: QA_SECONDARY",
      ]);
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    });

    it("consumes a string payload.title as the bold title exactly once", () => {
      renderRow(notice(1, "brand_new_kind", { title: "QA_STRING", message: "QA_PRIMARY" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("QA_STRING");
      expect([...container.querySelectorAll(".th-notice-line")].map((el) => el.textContent)).toEqual(["QA_PRIMARY"]);
      expect(container.textContent).not.toContain("title: QA_STRING");
    });

    it("falls back to the kind as the title when payload.title is absent", () => {
      renderRow(notice(1, "brand_new_kind", { message: "attempt 2" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("brand_new_kind");
      expect(container.textContent).toContain("attempt 2");
    });

    it("prefers why over message over reason as the primary line", () => {
      renderRow(notice(1, "k", { why: "the-why", message: "the-message", reason: "the-reason" }));
      expect(container.textContent).toContain("the-why");
      // Non-selected candidates still render, as remaining key: value lines.
      expect(container.textContent).toContain("message: the-message");
      expect(container.textContent).toContain("reason: the-reason");
      renderRow(notice(2, "k", { message: "the-message", reason: "the-reason" }));
      expect(container.textContent).toContain("the-message");
      expect(container.textContent).toContain("reason: the-reason");
      renderRow(notice(3, "k", { reason: "the-reason" }));
      expect(container.textContent).toContain("the-reason");
    });

    it("renders every remaining payload field as a key: value line, nested values compact", () => {
      renderRow(notice(1, "retry_fallback_applied", {
        from: "zai/glm",
        to: "moonshot/kimi",
        chainKey: "main",
        reason: "rate_limited",
        attempts: [1, 2, 3],
        detail: { code: 429, ok: false },
      }));
      const text = container.textContent ?? "";
      expect(text).toContain("rate_limited");
      expect(text).toContain("from: zai/glm");
      expect(text).toContain("to: moonshot/kimi");
      expect(text).toContain("chainKey: main");
      expect(text).toContain("attempts: 1, 2, 3");
      expect(text).toContain('detail: {"code":429,"ok":false}');
      expect(container.querySelector("pre")).toBeNull();
    });

    it("keeps the receipt time row", () => {
      renderRow(notice(1, "brand_new_kind", { message: "m1" }));
      const time = container.querySelector(".th-notice-time");
      expect(time).not.toBeNull();
      expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("renders a null payload as the kind title with no field lines", () => {
      renderRow(notice(1, "brand_new_kind"));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("brand_new_kind");
      expect(container.querySelectorAll(".th-notice-line")).toHaveLength(0);
      expect(container.querySelector("pre")).toBeNull();
    });

    it("uses one uniform structure across kinds with no per-kind tone", () => {
      renderRows([
        notice(1, "retry_fallback_applied", { message: "warn" }),
        notice(2, "brand_new_unknown_kind", { message: "info" }),
      ]);
      const rows = [...container.querySelectorAll(".th-chat-notice")];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.querySelector(".th-notice-title")).not.toBeNull();
        expect(row.querySelector(".th-notice-time")).not.toBeNull();
        expect(row.querySelector("pre")).toBeNull();
        expect(row.querySelector("details")).toBeNull();
      }
      expect(rows.map((row) => row.className)).toEqual([
        "th-chat-notice th-alert th-alert--info",
        "th-chat-notice th-alert th-alert--info",
      ]);
    });

    it("renders an unknown kind generically without crashing", () => {
      renderRow(notice(1, "brand_new_unknown_kind", { message: "hello there" }));
      expect(container.textContent).toContain("brand_new_unknown_kind");
      expect(container.textContent).toContain("hello there");
      expect(container.querySelector("details")).toBeNull();
    });

    it.each<Lang>(["en", "ko"])("renders the auto-retry start payload as a warning status line without translated prose (%s)", (lang) => {
      renderRow(notice(1, "auto_retry_start", { message: "attempt 2" }), lang);
      const row = container.querySelector(".th-notice-status--warning");
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain("attempt 2");
      expect(container.querySelector(".th-chat-notice")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
      expect(container.textContent).not.toContain(translate(lang, "notice.autoRetryStarted"));
    });

    it.each<Lang>(["en", "ko"])("renders a null auto-retry payload as a warning status line with the kind text (%s)", (lang) => {
      renderRow(notice(1, "auto_retry_end"), lang);
      const row = container.querySelector(".th-notice-status--warning");
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain("auto_retry_end");
      expect(container.querySelectorAll(".th-notice-line")).toHaveLength(0);
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
      expect(container.textContent).not.toContain(translate(lang, "notice.autoRetryEnded"));
    });

    it("preserves a payload's own type field as a key: value line alongside the kind title", () => {
      renderRow(notice(1, "brand_new_kind", { type: "QA_ORIGINAL_TYPE", message: "m1" }));
      // The wrapper kind keeps the bold-title role…
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("brand_new_kind");
      // …and the payload's own type field stays visible as its own line.
      expect(container.textContent).toContain("type: QA_ORIGINAL_TYPE");
      expect(container.textContent).toContain("m1");
    });

    it("renders the fallback-reverted from/to payload as key: value lines", () => {
      renderRow(notice(1, "retry_fallback_reverted", { from: "moonshot/kimi", to: "zai/glm" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("retry_fallback_reverted");
      expect(container.textContent).toContain("from: moonshot/kimi");
      expect(container.textContent).toContain("to: zai/glm");
      expect(container.textContent).not.toContain("notice.fallbackReverted");
    });

    it("renders the high-reasoning payload fields with no guidance copy", () => {
      renderRow(notice(1, "high_reasoning_warning", {
        provider: "zai",
        modelId: "glm-5.2",
        thinkingLevel: "high",
      }));
      expect(container.textContent).toContain("provider: zai");
      expect(container.textContent).toContain("modelId: glm-5.2");
      expect(container.textContent).toContain("thinkingLevel: high");
      expect(container.textContent).not.toContain("notice.highReasoningWarning");
      expect(container.textContent).not.toContain("notice.highReasoningGuidance");
    });

    it("renders the server fallback-aborted payload with its boolean field", () => {
      renderRow(notice(1, "server_fallback_aborted", { from: "a/one", to: "b/two", chainConfigured: true }));
      expect(container.textContent).toContain("from: a/one");
      expect(container.textContent).toContain("to: b/two");
      expect(container.textContent).toContain("chainConfigured: true");
      expect(container.textContent).not.toContain("notice.fallbackAborted");
    });

    it("renders extension_notify with the title as the bold line and id/message visible", () => {
      renderRow(notice(1, "extension_notify", { id: "n1", message: "Disk almost full", title: "Storage" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("Storage");
      expect(container.textContent).toContain("Disk almost full");
      expect(container.textContent).toContain("id: n1");
    });

    it("renders the fallback-succeeded payload as key: value lines", () => {
      renderRow(notice(1, "retry_fallback_succeeded", { to: "zai/glm" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("retry_fallback_succeeded");
      expect(container.textContent).toContain("to: zai/glm");
      expect(container.textContent).not.toContain("notice.fallbackSucceeded");
    });

    it("renders the fallback-exhausted payload as key: value lines", () => {
      renderRow(notice(1, "retry_fallback_exhausted", { chainKey: "main" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("retry_fallback_exhausted");
      expect(container.textContent).toContain("chainKey: main");
      expect(container.textContent).not.toContain("notice.fallbackExhausted");
    });

    it("renders a projected goal-cache-warmup notice as a title box without the session envelope dump", () => {
      renderRow(notice(1, "goal-cache-warmup", {
        title: "QA_TITLE",
        why: "QA_WHY",
        warm: 2,
        savings: 9007199254740993,
      }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("QA_TITLE");
      const lines = [...container.querySelectorAll(".th-notice-line")].map((el) => el.textContent);
      expect(lines[0]).toBe("QA_WHY");
      expect(lines).toContain("warm: 2");
      expect(lines.some((line) => line?.startsWith("savings: "))).toBe(true);
      expect(container.textContent).not.toContain("parentId");
      expect(container.textContent).not.toContain("timestamp");
      expect(container.textContent).not.toContain("customType");
      expect(container.textContent).not.toContain("data:");
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
    });

    it("renders no dismiss button", () => {
      renderRows([notice(1, "brand_new_kind", { message: "first" }), notice(2, "brand_new_other_kind")]);
      const row = [...container.querySelectorAll(".th-chat-notice")].find((block) =>
        block.textContent?.includes("first"),
      );
      expect(row?.querySelectorAll("button").length).toBe(0);
    });
  });
});
