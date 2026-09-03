import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { useChatSession } from "./useChatSession";
import {
  chatSession,
  ControlledResizeObserver,
  requireElement,
} from "./chatPaneTestHarness";

const koI18n: I18nValue = {
  lang: "ko",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key) => translate("ko", key),
};

type RenderOptions = {
  readonly failClose?: boolean;
};

describe("ChatPane resync control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    ControlledResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    ControlledResizeObserver.instances = [];
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderKoreanPane = (
    options: RenderOptions = {},
  ): {
    deliver: (frame: ChatServerFrame) => void;
    disconnect: () => void;
    sent: ChatClientFrame[];
  } => {
    let deliverFrame: ((frame: ChatServerFrame) => void) | undefined;
    let disconnectClient = (): void => undefined;
    const sent: ChatClientFrame[] = [];
    const connect: ChatConnector = (handlers) => {
      deliverFrame = handlers.onFrame;
      disconnectClient = () => handlers.onClose?.(1006);
      handlers.onOpen?.();
      return {
        send: (frame) => {
          sent.push(frame);
          return !(options.failClose && frame.type === "chat.close");
        },
        close: vi.fn(),
      };
    };

    act(() => {
      root.render(
        <I18nContext.Provider value={koI18n}>
          <ChatPane
            chatSession={chatSession}
            focused
            splitEnabled
            onFocus={() => undefined}
            onSplit={() => undefined}
            onClose={() => undefined}
            onOpenSidebar={() => undefined}
            connect={connect}
            notify={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });

    return {
      deliver: (frame) => deliverFrame?.(frame),
      disconnect: () => disconnectClient(),
      sent,
    };
  };

  const renderKoreanSessionProbe = (
    options: RenderOptions = {},
  ): { deliver: (frame: ChatServerFrame) => void; resync: () => boolean } => {
    let deliverFrame: ((frame: ChatServerFrame) => void) | undefined;
    let resyncSession = (): boolean => false;
    const connect: ChatConnector = (handlers) => {
      deliverFrame = handlers.onFrame;
      handlers.onOpen?.();
      return {
        send: (frame) => !(options.failClose && frame.type === "chat.close"),
        close: vi.fn(),
      };
    };

    function SessionProbe() {
      const chat = useChatSession(chatSession, connect);
      resyncSession = chat.resync;
      return chat.error ? <div className="th-chat-error">{chat.error}</div> : null;
    }

    act(() => {
      root.render(
        <I18nContext.Provider value={koI18n}>
          <SessionProbe />
        </I18nContext.Provider>,
      );
    });

    return {
      deliver: (frame) => deliverFrame?.(frame),
      resync: () => resyncSession(),
    };
  };

  const resyncButton = (): HTMLButtonElement =>
    requireElement(
      container.querySelector<HTMLButtonElement>(".th-chat-resync-btn"),
      "resync control",
    );

  it("renders the icon-only narrow variant with a localized accessible name", () => {
    container.style.width = "320px";
    renderKoreanPane();

    const button = resyncButton();
    const accessibleName = translate("ko", "chat.resync");
    expect(button.classList.contains("th-btn-icon")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe(accessibleName);
    expect(button.title).toBe(accessibleName);
    expect(button.querySelector(".th-chat-resync-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.querySelector(".th-chat-resync-label")).not.toBeNull();
  });

  it("presents only a manual resync as busy", () => {
    const { deliver } = renderKoreanPane();
    act(() => {
      deliver({ type: "entries", sessionId: chatSession.id, entries: [], final: true });
    });

    const button = resyncButton();
    expect(button.disabled).toBe(false);

    act(() => button.click());

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector(".th-chat-resync-label")?.textContent).toBe(
      translate("ko", "chat.resyncBusy"),
    );
  });

  it("stays disabled but not busy during attach and after disconnect", () => {
    const { deliver, disconnect } = renderKoreanPane();
    const button = resyncButton();
    const idleLabel = translate("ko", "chat.resync");

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.querySelector(".th-chat-resync-label")?.textContent).toBe(idleLabel);

    act(() => {
      deliver({ type: "entries", sessionId: chatSession.id, entries: [], final: true });
    });
    expect(button.disabled).toBe(false);

    act(() => disconnect());

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.querySelector(".th-chat-resync-label")?.textContent).toBe(idleLabel);
  });

  it.each([
    {
      name: "an active assistant response",
      key: "chat.resyncBusyResponding",
      prepare: (deliver: (frame: ChatServerFrame) => void) =>
        deliver({ type: "run.started", sessionId: chatSession.id }),
      failClose: false,
    },
    {
      name: "active conversation compaction",
      key: "chat.resyncBusyCompacting",
      prepare: (deliver: (frame: ChatServerFrame) => void) =>
        deliver({ type: "compaction.started", sessionId: chatSession.id }),
      failClose: false,
    },
    {
      name: "a transport send failure",
      key: "chat.resyncError",
      prepare: () => undefined,
      failClose: true,
    },
  ])("surfaces translated text for $name", ({ key, prepare, failClose }) => {
    const { deliver, resync } = renderKoreanSessionProbe({ failClose });
    act(() => {
      deliver({ type: "entries", sessionId: chatSession.id, entries: [], final: true });
    });
    act(() => prepare(deliver));
    act(() => resync());

    const expected = translate("ko", key);
    const error = requireElement(
      container.querySelector(".th-chat-error"),
      "localized resync error",
    );
    expect(error.textContent).toBe(expected);
  });
});
