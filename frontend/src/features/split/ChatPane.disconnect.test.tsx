import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type Lang } from "../../i18n";
import en from "../../i18n/locales/en.json";
import ko from "../../i18n/locales/ko.json";
import { modalStack } from "../../components/modalStack";
import type { ChatClientFrame, ChatConnector } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { chatSession, ControlledResizeObserver, requireElement } from "./chatPaneTestHarness";

describe("ChatPane disconnect confirmation with shipped locales", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    ControlledResizeObserver.instances = [];
    vi.unstubAllGlobals();
    expect(modalStack.size()).toBe(0);
  });

  function render(lang: Lang, count = 1) {
    const frames: ChatClientFrame[] = [];
    const close = vi.fn(), notify = vi.fn();
    const connect: ChatConnector = handlers => {
      handlers.onOpen?.();
      return { send: frame => { frames.push(frame); return true; }, close: vi.fn() };
    };
    act(() => root.render(
      <I18nContext.Provider value={{ lang, t: key => translate(lang, key), setLang: () => undefined,
        font: "system", setFont: () => undefined, fontSize: 14, setFontSize: () => undefined }}>
        {Array.from({ length: count }, (_, index) => <ChatPane key={index}
          chatSession={{ ...chatSession, id: `${chatSession.id}-${index}` }} focused splitEnabled
          onFocus={() => undefined} onSplit={() => undefined} onOpenSidebar={() => undefined}
          onClose={close} connect={connect} notify={notify} />)}
      </I18nContext.Provider>,
    ));
    return { frames, close, notify };
  }
  function open(index = 0) {
    const trigger = requireElement(container.querySelectorAll<HTMLButtonElement>(".th-disconnect-btn")[index], "trigger");
    act(() => { trigger.focus(); trigger.click(); });
    return trigger;
  }
  const dialog = () => requireElement(document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]'), "dialog");

  for (const lang of ["en", "ko"] as const) {
    const catalog: Readonly<Record<string, string>> = lang === "en" ? en : ko;
    it(`${lang}: resolves Cancel from its own catalog, never a key or fallback`, () => {
      // Given real locale data, not a translator that echoes keys.
      render(lang);
      // When the confirmation opens.
      open();
      // Then the visible control equals this locale's shipped copy.
      expect(Object.hasOwn(catalog, "common.cancel")).toBe(true);
      expect(catalog["common.cancel"]).toBeTruthy();
      const cancel = requireElement(dialog().querySelector(".th-btn--ghost"), "cancel");
      expect(cancel.textContent).toBe(catalog["common.cancel"]);
      expect(cancel.textContent).not.toBe("common.cancel");
      if (lang === "ko") expect(cancel.textContent).not.toBe(en["wizard.cancel"]);
    });
    it(`${lang}: references the visible title as the dialog name`, () => {
      render(lang);
      open();
      const panel = dialog(), title = requireElement(panel.querySelector("h2"), "title");
      expect(title.id).not.toBe("");
      expect(panel.getAttribute("aria-labelledby")).toBe(title.id);
      expect(document.getElementById(title.id)).toBe(title);
      expect(title.textContent).toBe(catalog["chat.disconnect"]);
    });
    for (const action of ["Cancel", "Escape"] as const) {
      it(`${lang}: ${action} restores focus without disconnecting or closing the pane`, () => {
        const { frames, close, notify } = render(lang);
        const trigger = open(), panel = dialog();
        expect(panel.contains(document.activeElement)).toBe(true);
        expect(document.body.style.overflow).toBe("hidden");
        act(() => {
          if (action === "Cancel") requireElement(panel.querySelector<HTMLButtonElement>(".th-btn--ghost"), "cancel").click();
          else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(document.body.style.overflow).not.toBe("hidden");
        expect(frames.filter(frame => frame.type === "chat.disconnect")).toEqual([]);
        expect(close).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      });
    }
  }
  it("keeps per-instance title identities and top-only Escape/focus isolation", () => {
    const { frames, close } = render("en", 2);
    const trigger = open();
    const first = dialog();
    open(1);
    const second = dialog();
    const firstId = first.getAttribute("aria-labelledby"), secondId = second.getAttribute("aria-labelledby");
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(first.closest(".th-modal-overlay")?.getAttribute("aria-hidden")).toBe("true");
    expect(first.closest(".th-modal-overlay")?.hasAttribute("inert")).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBe(first);
    expect(first.contains(document.activeElement)).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);
    expect(frames.filter(frame => frame.type === "chat.disconnect")).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });
});
