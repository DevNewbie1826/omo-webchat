import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue, type Lang } from "../../i18n";
import { TranscriptNoticeRow } from "./TranscriptNoticeRow";

// Compare to shipped translations, not pinned prose.
afterEach(() => vi.unstubAllGlobals());

it.each<Lang>(["en", "ko"])("renders a raw, inert compaction diagnostic (%s)", (lang) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const detail = 'QA_OVERFLOW_RECOVERY_EXHAUSTED\n<img src=x onerror="alert(1)">';
  const i18n: I18nValue = {
    lang, setLang: () => undefined, font: "system", setFont: () => undefined,
    fontSize: 13, setFontSize: () => undefined, t: (key) => translate(lang, key),
  };
  try {
    act(() => root.render(
      <I18nContext.Provider value={i18n}>
        <TranscriptNoticeRow notice={{ id: 1, at: 1, kind: "compaction_error", payload: { message: detail } }} />
      </I18nContext.Provider>,
    ));
    // Notice-box format: the kind is the bold title, the message renders as
    // inert text — never as markup and never as a JSON blob.
    expect(container.querySelector(".th-notice-title")?.textContent).toBe("compaction_error");
    expect(container.textContent).toContain("QA_OVERFLOW_RECOVERY_EXHAUSTED");
    expect(container.textContent).not.toContain(translate(lang, "notice.compactionError"));
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelectorAll("img, script")).toHaveLength(0);
    expect(container.querySelectorAll(".th-alert--warning")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  } finally {
    act(() => root.unmount());
  }
});
