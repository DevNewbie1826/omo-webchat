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

  it("renders the session picker directly under the hero inside .th-empty", () => {
    renderState({
      sessionPicker: <div data-testid="session-picker">picker</div>,
    });

    const empty = container.querySelector(".th-empty");
    const picker = container.querySelector('[data-testid="session-picker"]');

    expect(empty).not.toBeNull();
    expect(picker).not.toBeNull();
    expect(empty?.contains(picker as Node)).toBe(true);
  });

  it("renders only the hero and picker slots when no picker is provided", () => {
    renderState({
      mobile: false,
    });

    const children = Array.from(container.querySelector(".th-empty")?.children ?? []);
    expect(children).toHaveLength(1);
    expect(children[0]?.className).toBe("th-empty-hero");
  });

  it("leads with the presence hero and keeps its nodes mounted across re-renders", () => {
    renderState({ mobile: false, workspaces: [] });

    const hero = container.querySelector(".th-empty > .th-empty-hero");
    const orb = hero?.querySelector(".th-empty-orb");
    const greeting = hero?.querySelector("h2.th-empty-title");
    const hint = hero?.querySelector(".th-empty-hint");
    const cta = hero?.querySelector<HTMLButtonElement>("button.th-empty-cta");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(greeting?.textContent).toBe("empty.greeting");
    expect(hint?.textContent).toBe("empty.hintStart");
    expect(cta?.textContent).toBe("empty.newWorkspace");

    renderState({
      mobile: false,
      workspaces: [workspace("ws-1")],
      sessionPicker: <div data-testid="session-picker">picker</div>,
    });

    // The CSS entrance plays on mount only: re-rendering must reuse, not
    // remount, every hero node.
    const rerendered = container.querySelector(".th-empty > .th-empty-hero");
    expect(rerendered).toBe(hero);
    expect(rerendered?.querySelector(".th-empty-orb")).toBe(orb);
    expect(rerendered?.querySelector("h2.th-empty-title")).toBe(greeting);
    expect(rerendered?.querySelector(".th-empty-hint")).toBe(hint);
    expect(rerendered?.querySelector("button.th-empty-cta")).toBe(cta);
    expect(hint?.textContent).toBe("empty.hintResume");
    expect(cta?.textContent).toBe("empty.newChat");
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
