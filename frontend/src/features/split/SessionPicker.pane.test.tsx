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

describe("SessionPicker chooser pane", () => {
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
    renderPicker(makeProps({ workspaces: [workspace("ws-1")] }));

    const picker = container.querySelector(".th-picker-pane");
    const hero = picker?.querySelector(":scope > .th-empty-hero");
    expect(hero).not.toBeNull();
    expect(hero?.querySelector(".th-empty-orb")?.getAttribute("aria-hidden")).toBe("true");
    expect(hero?.querySelector("h2.th-empty-title")?.textContent).toBe("empty.greeting");
    expect(hero?.querySelector(".th-empty-hint")?.textContent).toBe("empty.hintResume");

    const title = container.querySelector(".th-picker-pane-title");
    expect(
      (hero as Node).compareDocumentPosition(title as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("switches the hero hint once workspaces exist", () => {
    renderPicker(makeProps());

    expect(
      container.querySelector(".th-picker-pane > .th-empty-hero .th-empty-hint")?.textContent,
    ).toBe("empty.hintStart");
  });

  it("keeps the hero free of its own CTA; the pane keeps the create action", () => {
    renderPicker(makeProps({ workspaces: [workspace("ws-1")] }));

    const hero = container.querySelector(".th-picker-pane > .th-empty-hero");
    expect(hero?.querySelector("button")).toBeNull();
    expect(container.querySelector(".th-picker-pane-create button")).not.toBeNull();
  });

  it("tiers the hero on the pane's block size and keeps the chooser reachable in short panes", () => {
    const splitCss = readFileSync("src/styles/split-view.css", "utf8");

    // The leaf wrap is sized by the split layout, never by content, so it may
    // be a size container; the picker hero tiers on its block size.
    const containerRule =
      /\.th-pane-wrap:has\(> \.th-picker-pane\)\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(containerRule).toContain("container: pane / size");

    // Compact tier: smaller orb, hidden hint, tighter gaps. The greeting
    // itself must stay in the Display tier — the S11 picker contract pins
    // orb + Display greeting wherever the hero renders — so no font-size
    // override may appear here (E24 rework guard).
    const compact = /@container pane \(height < 680px\)\s*\{([\s\S]*?)\n\}/.exec(splitCss)?.[1] ?? "";
    expect(compact, "compact container block").not.toBe("");
    expect(/\.th-empty-orb\s*\{[^}]*width: var\(--th-space-6\)/.test(compact)).toBe(true);
    expect(/\.th-empty-hint\s*\{[^}]*display: none/.test(compact)).toBe(true);
    expect(/\.th-empty-title\s*\{[^}]*font-size/.test(compact)).toBe(false);

    // Below 420px the hero yields entirely: chooser list and New chat stay
    // inside the pane without scrolling.
    const hidden = /@container pane \(height < 420px\)\s*\{([\s\S]*?)\n\}/.exec(splitCss)?.[1] ?? "";
    expect(/\.th-empty-hero\s*\{[^}]*display: none/.test(hidden)).toBe(true);

    // E24 guard: the hero may yield ONLY inside the container tiers. A rule
    // hiding it unconditionally would drain the desktop empty leaf again;
    // rendering it unconditionally in short panes would push the chooser
    // below the fold.
    const outsideTiers = splitCss.replace(/@container pane[^{]*\{[\s\S]*?\n\}/g, "");
    expect(/\.th-empty-hero[^{]*\{[^}]*display:\s*none/.test(outsideTiers)).toBe(false);

    // The mobile single-pane shell keeps its own hero, so the picker's copy
    // stays hidden there regardless of pane size.
    const emptyCss = readFileSync("src/styles/app-empty.css", "utf8");
    const hide =
      /\.th-empty > \.th-picker-pane > \.th-empty-hero\s*\{[^}]*\}/.exec(emptyCss)?.[0] ?? "";
    expect(hide).toContain("display: none");
  });

  it("pins the one-time entrance choreography: hero settles first, pane content rises second", () => {
    const splitCss = readFileSync("src/styles/split-view.css", "utf8");
    const entrance =
      /\.th-pane-wrap > \.th-picker-pane > \.th-empty-hero ~ \*\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(entrance).toContain("th-empty-rise");
    expect(entrance).toContain("var(--th-dur-emph)");
  });

  it("pins session rows to the raised calm-card idiom", () => {
    const splitCss = readFileSync("src/styles/split-view.css", "utf8");
    const item = /\.th-picker-pane-item\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(item).toContain("background: var(--th-surface-raised)");
    expect(item).toContain("border-radius: var(--th-radius)");
    expect(item).toContain("box-shadow: var(--th-shadow-raised), var(--th-highlight)");

    const hover = /\.th-picker-pane-item:hover\s*\{[^}]*\}/.exec(splitCss)?.[0] ?? "";
    expect(hover).toContain("background: var(--th-hover)");
    expect(hover).not.toContain("border-color");
  });

  it("pins the success toast to the status recipe: green word on the success tint, larger glyph, neutral border", () => {
    const emptyCss = readFileSync("src/styles/app-empty.css", "utf8");

    // E17: status colour is coloured text on the matching light tint; the
    // border stays neutral (binding decision 1).
    const success = /\.th-toast--success\s*\{[^}]*\}/.exec(emptyCss)?.[0] ?? "";
    expect(success).toContain("color: var(--th-success)");
    expect(success).toContain("background: var(--th-success-bg)");
    expect(success).not.toContain("border-color");

    const glyph = /\.th-toast--success::before\s*\{[^}]*\}/.exec(emptyCss)?.[0] ?? "";
    expect(glyph).toContain("width: var(--th-space-5)");
    expect(glyph).toContain("height: var(--th-space-5)");
    expect(glyph).toContain("mask-image:");
  });
});
