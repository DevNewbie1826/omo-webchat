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

function startFailedFrame(): ChatServerFrame {
  return {
    type: "error",
    sessionId: "chat-1",
    code: "start_failed",
    message: "could not open the session; please retry",
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

  const deliverStartFailed = (): void => {
    act(() => {
      captured?.handleFrame(startFailedFrame());
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
});
