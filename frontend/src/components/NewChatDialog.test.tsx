import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { NewChatDialog } from "./NewChatDialog";

const i18n = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key: string) => key,
} as I18nValue;

describe("NewChatDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderDialog(overrides: Partial<React.ComponentProps<typeof NewChatDialog>> = {}): void {
    const props: React.ComponentProps<typeof NewChatDialog> = {
      open: true,
      providerDiscovery: {
        status: "loaded",
        providers: [
          { id: "omo", label: "omo", binary: "omo", available: true },
        ],
      },
      onRetryProviders: () => undefined,
      onClose: () => undefined,
      ...overrides,
    };
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <NewChatDialog {...props} />
        </I18nContext.Provider>,
      );
    });
  }

  it("shows loading status with retry and cancel but no provider cards", () => {
    const onRetryProviders = vi.fn();
    const onClose = vi.fn();
    renderDialog({
      providerDiscovery: { status: "loading" },
      onRetryProviders,
      onClose,
    });

    expect(document.querySelector('[role="status"]')?.textContent).toContain("newChat.providersLoading");
    expect(document.querySelector("[data-provider-option]")).toBeNull();
    expect(document.querySelector(".th-provider-card")).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>("[data-new-chat-retry]")?.click());
    expect(onRetryProviders).toHaveBeenCalledOnce();
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "wizard.cancel");
    act(() => cancel?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels with Escape without creating", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows retry and cancel without provider cards when Omo is unavailable", () => {
    const onRetryProviders = vi.fn();
    const onClose = vi.fn();
    renderDialog({
      onRetryProviders,
      onClose,
      providerDiscovery: {
        status: "loaded",
        providers: [
          { id: "omo", label: "omo", binary: "omo", available: false },
        ],
      },
    });

    expect(document.querySelector("[data-provider-option]")).toBeNull();
    expect(document.querySelector(".th-provider-card")).toBeNull();
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "common.retry");
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "wizard.cancel");
    act(() => retry?.click());
    act(() => cancel?.click());
    expect(onRetryProviders).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows provider discovery errors without fabricating options and retries", () => {
    const onRetryProviders = vi.fn();
    renderDialog({ providerDiscovery: { status: "error" }, onRetryProviders });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("newChat.providersError");
    expect(document.querySelector("[data-provider-option]")).toBeNull();
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "common.retry");
    act(() => retry?.click());
    expect(onRetryProviders).toHaveBeenCalledOnce();
  });

});
