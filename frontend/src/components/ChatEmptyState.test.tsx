import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { ChatEmptyState } from "./ChatEmptyState";
import type { Workspace } from "../features/workspace/workspace";

const i18n = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key: string) => key,
} as I18nValue;

function workspace(id: string): Workspace {
  return { id, name: id, path: `/${id}`, chats: [] };
}

describe("ChatEmptyState", () => {
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

  function renderState(overrides: Partial<React.ComponentProps<typeof ChatEmptyState>> = {}): void {
    const props: React.ComponentProps<typeof ChatEmptyState> = {
      mobile: true,
      workspaces: [],
      onOpenSidebar: () => undefined,
      onNewWorkspace: () => undefined,
      onNewChat: () => undefined,
      ...overrides,
    };
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <ChatEmptyState {...props} />
        </I18nContext.Provider>,
      );
    });
  }

  it("shows a named sidebar button on mobile and keeps the New workspace action reachable", () => {
    const onOpenSidebar = vi.fn();
    const onNewWorkspace = vi.fn();
    const onNewChat = vi.fn();
    renderState({ mobile: true, workspaces: [], onOpenSidebar, onNewWorkspace, onNewChat });

    const menu = container.querySelector<HTMLButtonElement>('button[title="empty.menu"]');
    const primary = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("empty.newWorkspace"));

    expect(menu).toBeDefined();
    expect(primary).toBeDefined();

    act(() => menu?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => primary?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it("switches the primary action to New chat when workspaces exist", () => {
    const onOpenSidebar = vi.fn();
    const onNewWorkspace = vi.fn();
    const onNewChat = vi.fn();
    renderState({ mobile: false, workspaces: [workspace("ws-1")], onOpenSidebar, onNewWorkspace, onNewChat });

    const primary = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("empty.newChat"));

    expect(container.querySelector('button[title="empty.menu"]')).toBeNull();
    expect(primary).toBeDefined();

    act(() => primary?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewWorkspace).not.toHaveBeenCalled();
    expect(onOpenSidebar).not.toHaveBeenCalled();
  });
});
