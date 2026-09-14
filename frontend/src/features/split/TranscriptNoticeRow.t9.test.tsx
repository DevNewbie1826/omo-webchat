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

function notice(id: number, kind: string, values?: Record<string, unknown>): ChatNotice {
  return { id, kind, payload: values ? (values as ChatNotice["payload"]) : null, at: 1_000 + id };
}

describe("TranscriptNoticeRow transcript-derived notice kinds", () => {
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

  const renderRow = (entry: ChatNotice): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <TranscriptNoticeRow notice={entry} />
        </I18nContext.Provider>,
      );
    });
  };

  describe("compaction_summary box", () => {
    const summary = "First line of the summary.\nSecond line with more detail.";

    it("renders a [compaction] labeled notice box with a tokens line and the receipt time", () => {
      renderRow(notice(1, "compaction_summary", { tokensBefore: 48213, summary }));
      const box = container.querySelector(".th-chat-notice.th-alert--info");
      expect(box).not.toBeNull();
      expect(box?.querySelector(".th-notice-title")?.textContent).toBe("[compaction]");
      expect(box?.textContent).toContain("48213");
      const time = box?.querySelector(".th-notice-time");
      expect(time?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("collapses the summary to one line behind an expandable disclosure", () => {
      renderRow(notice(1, "compaction_summary", { tokensBefore: 100, summary }));
      const details = container.querySelector("details");
      expect(details).not.toBeNull();
      expect(details?.hasAttribute("open")).toBe(false);
      const toggle = details?.querySelector("summary");
      expect(toggle?.textContent).toContain("First line of the summary.");
      // Exact text passthrough: the full summary is present verbatim in the body.
      const full = details?.querySelector(".th-notice-summary-full");
      expect(full?.textContent).toBe(summary);
    });

    it("expands to reveal the full summary text", () => {
      renderRow(notice(1, "compaction_summary", { tokensBefore: 100, summary }));
      const details = container.querySelector("details");
      const toggle = details?.querySelector("summary");
      expect(toggle).not.toBeNull();
      act(() => {
        toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(details?.hasAttribute("open")).toBe(true);
      expect(details?.textContent).toContain("Second line with more detail.");
    });

    it("renders without a tokens line when tokensBefore is absent", () => {
      renderRow(notice(1, "compaction_summary", { summary: "only text" }));
      expect(container.querySelector(".th-notice-title")?.textContent).toBe("[compaction]");
      expect(container.textContent).toContain("only text");
      expect(container.textContent).not.toContain("Tokens before");
    });
  });

  describe("warning-toned one-liners", () => {
    it.each(["compaction_cost", "cache_miss", "engine_warning"])(
      "%s renders as a single warning status line with the text verbatim and the receipt time",
      (kind) => {
        renderRow(notice(1, kind, { text: "Cache miss: 42K tokens re-billed (~$1.20)" }));
        const row = container.querySelector(".th-notice-status");
        expect(row).not.toBeNull();
        expect(row?.className).toContain("th-notice-status--warning");
        expect(row?.textContent).toContain("Cache miss: 42K tokens re-billed (~$1.20)");
        expect(row?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        // One-liner: no box, no disclosure, no key: value dump.
        expect(container.querySelector(".th-chat-notice")).toBeNull();
        expect(container.querySelector("details")).toBeNull();
        expect(container.textContent).not.toContain("text:");
      },
    );
  });

  describe("dim one-liners", () => {
    it.each(["thinking_dropped", "continuity_notice", "compaction_history"])(
      "%s renders as a single dim status row like engine_notify, with the receipt time",
      (kind) => {
        renderRow(notice(1, kind, { text: "Session compacted 2 times" }));
        const row = container.querySelector(".th-notice-status");
        expect(row).not.toBeNull();
        expect(row?.className).toContain("th-notice-status--info");
        expect(row?.className).not.toContain("th-notice-status--warning");
        expect(row?.textContent).toContain("Session compacted 2 times");
        expect(row?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        expect(container.querySelector(".th-chat-notice")).toBeNull();
        expect(container.querySelector("details")).toBeNull();
      },
    );
  });

  describe("extension_error block", () => {
    it("renders an error-toned block titled by extensionPath and event with the error text", () => {
      renderRow(notice(1, "extension_error", {
        extensionPath: "/ext/weather.ts",
        event: "message_end",
        error: "TypeError: boom",
      }));
      const box = container.querySelector(".th-chat-notice.th-alert--error");
      expect(box).not.toBeNull();
      const title = box?.querySelector(".th-notice-title");
      expect(title?.textContent).toContain("/ext/weather.ts");
      expect(title?.textContent).toContain("message_end");
      expect(box?.textContent).toContain("TypeError: boom");
      expect(box?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it("renders the title without an event segment when event is absent", () => {
      renderRow(notice(1, "extension_error", { extensionPath: "/ext/weather.ts", error: "boom" }));
      const title = container.querySelector(".th-chat-notice.th-alert--error .th-notice-title");
      expect(title?.textContent).toBe("/ext/weather.ts");
      expect(container.textContent).toContain("boom");
    });
  });

  it("keeps the generic all-fields notice box for unknown kinds", () => {
    renderRow(notice(1, "brand_new_kind", { message: "hello", extra: 1 }));
    expect(container.querySelector(".th-chat-notice.th-alert--info")).not.toBeNull();
    expect(container.textContent).toContain("hello");
    expect(container.textContent).toContain("extra: 1");
  });
});
