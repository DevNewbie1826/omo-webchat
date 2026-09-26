import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext } from "../../i18n";
import type { I18nValue } from "../../i18n";
import { SessionPicker } from "./SessionPicker";
import type { SessionPickerProps } from "./SessionPicker";
import type { Workspace } from "../workspace/workspace";

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

function makeProps(overrides: Partial<SessionPickerProps> = {}): SessionPickerProps {
  return {
    workspaces: [],
    sessionLists: new Map(),
    sessionPages: new Map(),
    onEnsureSessions: () => undefined,
    onLoadMoreSessions: async () => undefined,
    onOpenSession: async () => "opened",
    onNewChat: () => undefined,
    ...overrides,
  };
}

describe("SessionPicker presence hero", () => {
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

  function renderPicker(props: SessionPickerProps): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <SessionPicker {...props} />
        </I18nContext.Provider>,
      );
    });
  }

  it("leads the desktop picker with the shared presence hero above the title", () => {
    renderPicker(makeProps());

    const picker = container.querySelector(".th-picker-pane");
    const hero = picker?.querySelector(":scope > .th-empty-hero");
    expect(hero).not.toBeNull();
    expect(hero?.querySelector(".th-empty-orb")?.getAttribute("aria-hidden")).toBe("true");
    expect(hero?.querySelector("h2.th-empty-title")?.textContent).toBe("empty.greeting");
    expect(hero?.querySelector(".th-empty-hint")?.textContent).toBe("empty.hintStart");

    const title = container.querySelector(".th-picker-pane-title");
    expect(
      (hero as Node).compareDocumentPosition(title as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("switches the hero hint once workspaces exist", () => {
    renderPicker(makeProps({ workspaces: [workspace("ws-1")] }));

    expect(
      container.querySelector(".th-picker-pane > .th-empty-hero .th-empty-hint")?.textContent,
    ).toBe("empty.hintResume");
  });

  it("keeps the hero free of its own CTA; the pane keeps the create action", () => {
    renderPicker(makeProps({ workspaces: [workspace("ws-1")] }));

    const hero = container.querySelector(".th-picker-pane > .th-empty-hero");
    expect(hero?.querySelector("button")).toBeNull();
    expect(container.querySelector(".th-picker-pane-create button")).not.toBeNull();
  });

  it("pins session rows to the raised calm-card idiom and the desktop entrance choreography", () => {
    const splitCss = readFileSync("src/styles/split-view.css", "utf8");
    const item = /\.th-picker-pane-item\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(item).toContain("background: var(--th-surface-raised)");
    expect(item).toContain("border-radius: var(--th-radius)");
    expect(item).toContain("box-shadow: var(--th-shadow-raised), var(--th-highlight)");

    const hover = /\.th-picker-pane-item:hover\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(hover).toContain("background: var(--th-hover)");
    expect(hover).not.toContain("border-color");

    const entrance =
      /\.th-pane-wrap > \.th-picker-pane > \.th-empty-hero ~ \*\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(entrance).toContain("th-empty-rise");
    expect(entrance).toContain("var(--th-dur-emph)");

    const emptyCss = readFileSync("src/styles/app-empty.css", "utf8");
    const hide =
      /\.th-empty > \.th-picker-pane > \.th-empty-hero\s*\{[^}]*\}/.exec(emptyCss)?.[0] ?? "";
    expect(hide).toContain("display: none");
  });
});
