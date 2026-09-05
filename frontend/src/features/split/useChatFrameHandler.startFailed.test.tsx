import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLang, I18nContext, translate, type I18nValue } from "../../i18n";
import type { ChatServerFrame } from "../../lib/chatWs";
import { useChatFrameState } from "./useChatFrameState";

interface ProbeState {
  readonly error: string;
  readonly handleFrame: (frame: ChatServerFrame) => void;
}

let captured: ProbeState | null = null;

function Probe(): null {
  const state = useChatFrameState();
  captured = {
    error: state.error,
    handleFrame: state.handleFrame,
  };
  return null;
}

function i18nFor(lang: "en" | "ko"): I18nValue {
  return {
    lang,
    setLang: () => undefined,
    font: "system",
    setFont: () => undefined,
    fontSize: 13,
    setFontSize: () => undefined,
    t: (key) => translate(lang, key),
  };
}

const GENERIC_START_FAILED = "could not open the session; please retry";
const OPEN_FAILED_DETAIL = "open_failed: QA_CONTEXT_LIMIT 311799 > 272000";
const OPEN_FAILED_LONG = `open_failed: QA_CONTEXT_LIMIT 311799 > 272000\n${"T".repeat(600)}\n<img src=x onerror=alert(1)>`;

function startFailedFrame(message = GENERIC_START_FAILED): ChatServerFrame {
  return {
    type: "error",
    sessionId: "chat-1",
    code: "start_failed",
    message,
  };
}

describe("start_failed error surface localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    captured = null;
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
    vi.restoreAllMocks();
  });

  const renderProbe = (value: I18nValue): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={value}>
          <Probe />
        </I18nContext.Provider>,
      );
    });
  };

  const deliverStartFailed = (message?: string): void => {
    act(() => {
      captured?.handleFrame(startFailedFrame(message));
    });
  };

  it("keeps English start_failed copy when the active translator is English", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("en"));
    deliverStartFailed();

    expect(captured?.error).toBe(translate("en", "chat.startFailed"));
    expect(captured?.error).not.toBe("could not open the session; please retry");
  });

  it("renders Korean start_failed copy from the active translator when storage still holds English", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("ko"));
    deliverStartFailed();

    expect(detectLang()).toBe("en");
    expect(captured?.error).toBe(translate("ko", "chat.startFailed"));
    expect(captured?.error).not.toBe(translate("en", "chat.startFailed"));
    expect(captured?.error).not.toBe(translate(detectLang(), "chat.startFailed"));
    expect(captured?.error).not.toBe("could not open the session; please retry");
  });

  it("keeps English heading and exact open_failed raw text when the translator is English", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("en"));
    deliverStartFailed(OPEN_FAILED_DETAIL);

    const heading = translate("en", "chat.startFailedHeading");
    expect(heading).not.toBe("chat.startFailedHeading");
    expect(heading).not.toBe(translate("en", "chat.startFailed"));
    expect(captured?.error).toBe(`${heading}\n${OPEN_FAILED_DETAIL}`);
    expect(captured?.error).toContain(OPEN_FAILED_DETAIL);
    expect(captured?.error).not.toBe(translate("en", "chat.startFailed"));
  });

  it("keeps Korean heading and exact open_failed raw text from the active translator", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("ko"));
    deliverStartFailed(OPEN_FAILED_DETAIL);

    expect(detectLang()).toBe("en");
    const heading = translate("ko", "chat.startFailedHeading");
    expect(heading).not.toBe("chat.startFailedHeading");
    expect(heading).not.toBe(translate("en", "chat.startFailedHeading"));
    expect(heading).not.toBe(translate("ko", "chat.startFailed"));
    expect(captured?.error).toBe(`${heading}\n${OPEN_FAILED_DETAIL}`);
    expect(captured?.error).not.toBe(translate("en", "chat.startFailed"));
    expect(captured?.error).not.toBe(translate(detectLang(), "chat.startFailed"));
  });

  it("falls back to localized generic copy when open_failed detail is empty or whitespace", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("ko"));
    const generic = translate("ko", "chat.startFailed");

    for (const message of ["open_failed:", "open_failed:   ", "open_failed:\t", "", "   "]) {
      deliverStartFailed(message);
      expect(captured?.error, message).toBe(generic);
      expect(captured?.error, message).not.toContain("open_failed:");
    }
  });

  it("preserves HTML-like multiline open_failed text after the localized heading", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("en"));
    deliverStartFailed(OPEN_FAILED_LONG);

    const heading = translate("en", "chat.startFailedHeading");
    expect(captured?.error).toBe(`${heading}\n${OPEN_FAILED_LONG}`);
    expect(captured?.error.endsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect(captured?.error).toContain("T".repeat(600));
  });

  it("does not leak an arbitrary start_failed message", () => {
    window.localStorage.setItem("th-lang", "en");
    renderProbe(i18nFor("en"));
    deliverStartFailed("sensitive internal boom");

    expect(captured?.error).toBe(translate("en", "chat.startFailed"));
    expect(captured?.error).not.toBe("sensitive internal boom");
  });
});
