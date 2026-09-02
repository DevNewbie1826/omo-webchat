import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { SessionTreeProps } from "./SessionTree";
import type { Workspace, WorkspaceSession } from "../features/workspace/workspace";

/**
 * Sidebar hierarchy contract: the session name is the row's primary content
 * and its accessible name; the "not imported" badge is demoted secondary
 * metadata (Micro tier in CSS, hidden from the accessibility tree) and must
 * never crowd out or replace the name.
 */

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => (vars && "name" in vars ? `${key} ${String(vars["name"])}` : key),
};

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "tm-1", name: "Stored session", provider: "omo" }],
};

const sessions: readonly WorkspaceSession[] = [
  { id: "tm-1", name: "Stored session", source: "stored", recencyMs: 2 },
  {
    id: "disk-1",
    name: "Discovered session",
    source: "discovered",
    recencyMs: 1,
    resumeIdentity: "/sessions/disk-1.jsonl",
  },
];

describe("SessionTree session-row hierarchy", () => {
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
  });

  function render(
    onToggle: (wsId: string) => void = () => undefined,
    onSelect: SessionTreeProps["onSelect"] = () => undefined,
  ): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <SessionTree
            workspaces={[workspace]}
            liveSessions={new Set()}
            activeTerminalId="tm-1"
            placedSessions={new Set()}
            expanded={new Set([workspace.id])}
            sessionLists={new Map([[workspace.id, sessions]])}
            sessionPages={new Map()}
            onToggle={onToggle}
            onLoadMoreSessions={() => undefined}
            onSelect={onSelect}
            onAdopt={async () => undefined}
            onAddTerminal={() => undefined}
            onDeleteWorkspace={() => undefined}
            onDeleteTerminal={() => undefined}
            onRenameWorkspace={async () => undefined}
            onRenameTerminal={async () => undefined}
            notify={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });
  }

  function row(name: string): HTMLElement {
    const match = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"))
      .find((item) => item.textContent?.includes(name));
    expect(match).toBeDefined();
    return match!;
  }

  it("keeps the session name as the row's accessible name while the import badge is demoted", () => {
    render();
    const discovered = row("Discovered session");

    const activation = discovered.querySelector<HTMLButtonElement>(".th-tree-activation");
    // The accessible name is built from the session name...
    expect(activation?.getAttribute("aria-label")).toBe(
      "sidebar.tm.discoveredHint Discovered session",
    );
    // ...while the demoted badge is hidden from the accessibility tree so
    // secondary metadata can never outrank the primary content.
    const badge = discovered.querySelector(".th-tree-source");
    expect(badge?.textContent).toBe("sidebar.tm.discovered");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    // The primary label stays exposed.
    const label = discovered.querySelector(".th-tree-label");
    expect(label?.textContent).toBe("Discovered session");
    expect(label?.getAttribute("aria-hidden")).toBeNull();
  });

  it("gives a stored session row its name with no badge at all", () => {
    render();
    const stored = row("Stored session");

    expect(stored.querySelector(".th-tree-source")).toBeNull();
    const activation = stored.querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(activation?.textContent).toBe("Stored session");
    expect(activation?.tagName).toBe("BUTTON");
    expect(activation?.getAttribute("aria-current")).toBe("true");
    expect(activation?.getAttribute("aria-selected")).toBeNull();
  });

  it("uses plain row containers with sibling controls and no nested interactive elements", () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    render(onToggle, onSelect);

    const rows = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-node"));
    const workspaceRow = rows.find((item) => item.parentElement?.classList.contains("th-tree-workspace"));
    const sessionRow = row("Stored session");
    expect(workspaceRow).toBeDefined();

    for (const item of rows) {
      expect(item.getAttribute("role")).toBeNull();
      expect(item.getAttribute("tabindex")).toBeNull();
      expect(item.getAttribute("aria-current")).toBeNull();
      expect(item.getAttribute("aria-expanded")).toBeNull();
      expect(item.getAttribute("aria-selected")).toBeNull();

      const interactive = Array.from(
        item.querySelectorAll<HTMLElement>('button, [role="button"], input, a[href]'),
      );
      for (const control of interactive) {
        let ancestor = control.parentElement;
        while (ancestor && ancestor !== item) {
          expect(ancestor.matches('button, [role="button"], input, a[href]')).toBe(false);
          ancestor = ancestor.parentElement;
        }
      }
    }

    const expand = workspaceRow?.querySelector<HTMLButtonElement>(".th-tree-chevron");
    const workspaceActivation = workspaceRow?.querySelector<HTMLButtonElement>(".th-tree-activation");
    const sessionActivation = sessionRow.querySelector<HTMLButtonElement>(".th-tree-activation");
    const sessionActions = sessionRow.querySelector(".th-tree-actions");
    expect(expand?.tagName).toBe("BUTTON");
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
    expect(workspaceActivation?.tagName).toBe("BUTTON");
    expect(sessionActivation?.tagName).toBe("BUTTON");
    expect(sessionActivation?.getAttribute("aria-current")).toBe("true");
    expect(workspaceActivation?.parentElement).toBe(workspaceRow);
    expect(sessionActivation?.parentElement).toBe(sessionRow);
    expect(sessionActions?.parentElement).toBe(sessionRow);
    expect(sessionActivation?.contains(sessionActions ?? null)).toBe(false);

    act(() => {
      workspaceRow?.click();
      sessionRow.click();
    });
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();

    act(() => {
      expand?.click();
      workspaceActivation?.click();
      sessionActivation?.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);

    act(() => {
      sessionRow.querySelector<HTMLButtonElement>('[title="sidebar.tm.rename"]')?.click();
    });
    const renameInput = sessionRow.querySelector<HTMLInputElement>(".th-tree-rename");
    expect(renameInput).not.toBeNull();
    expect(renameInput?.parentElement).toBe(sessionRow);
    expect(renameInput?.closest("button, [role=button], a[href]")).toBeNull();
  });
});
