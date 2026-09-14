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

describe("TranscriptNoticeRow auto_retry bundle", () => {
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

  it.each(["auto_retry_start", "auto_retry_end"])(
    "%s renders one warning status line with the payload message verbatim and the receipt time, not an all-fields box",
    (kind) => {
      renderRow(notice(1, kind, { message: "Rate limited; retrying in 30s", attempt: 2 }));
      const row = container.querySelector(".th-notice-status");
      expect(row).not.toBeNull();
      expect(row?.className).toContain("th-notice-status--warning");
      expect(row?.textContent).toContain("Rate limited; retrying in 30s");
      expect(row?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      // One-liner: no box, no disclosure, no key: value dump.
      expect(container.querySelector(".th-chat-notice")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
      expect(container.textContent).not.toContain("attempt:");
      expect(container.textContent).not.toContain("message:");
    },
  );

  it("uses the reason field when message is absent, then error", () => {
    renderRow(notice(1, "auto_retry_start", { reason: "overloaded" }));
    expect(container.querySelector(".th-notice-status--warning")?.textContent).toContain("overloaded");

    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <TranscriptNoticeRow notice={notice(2, "auto_retry_end", { error: "timeout" })} />
        </I18nContext.Provider>,
      );
    });
    expect(container.querySelector(".th-notice-status--warning")?.textContent).toContain("timeout");
  });

  it("falls back to the kind itself when no text field exists", () => {
    renderRow(notice(1, "auto_retry_start", { attempt: 3 }));
    const row = container.querySelector(".th-notice-status--warning");
    expect(row?.textContent).toContain("auto_retry_start");
  });

  it("keeps the generic all-fields notice box for unknown kinds", () => {
    renderRow(notice(1, "brand_new_kind", { message: "hello", extra: 1 }));
    expect(container.querySelector(".th-chat-notice.th-alert--info")).not.toBeNull();
    expect(container.textContent).toContain("hello");
    expect(container.textContent).toContain("extra: 1");
  });

  it("leaves the engine_notify status row unchanged", () => {
    renderRow(notice(1, "engine_notify", { message: "Engine restarted", notifyType: "warning" }));
    const row = container.querySelector(".th-notice-status--warning");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Engine restarted");
    expect(row?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(container.querySelector(".th-chat-notice")).toBeNull();
  });
});
