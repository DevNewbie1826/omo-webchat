import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { SessionTreeProps } from "./SessionTree";
import type { Workspace, WorkspaceSession } from "../features/workspace/workspace";

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
  chats: [
    { id: "tm-1", name: "Stored dangling", provider: "omo" },
    { id: "tm-2", name: "Stored session", provider: "omo" },
  ],
};

const sessions: readonly WorkspaceSession[] = [
  {
    id: "tm-1",
    name: "Stored dangling",
    source: "stored",
    recencyMs: 3,
    dangling: true,
  } as WorkspaceSession,
  { id: "tm-2", name: "Stored session", source: "stored", recencyMs: 2 },
  {
    id: "durable-adopted",
    name: "Adopted source",
    source: "alreadyAdopted",
    recencyMs: 1,
    resumeIdentity: "/sessions/adopted-source.jsonl",
  },
  {
    id: "disk-1",
    name: "Discovered session",
    source: "discovered",
    recencyMs: 1,
    resumeIdentity: "/sessions/disk-1.jsonl",
  },
];

describe("SessionTree dangling stored-row badge", () => {
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
            onOpen={async () => undefined}
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

  it("badges a dangling stored row without hiding the session name", () => {
    render();
    const stored = row("Stored dangling");

    const badge = stored.querySelector(".th-tree-source");
    expect(badge?.textContent).toBe("sidebar.tm.missingOriginal");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");

    const label = stored.querySelector(".th-tree-label");
    expect(label?.textContent).toBe("Stored dangling");
    expect(label?.getAttribute("aria-hidden")).toBeNull();
  });

  it("keeps an adopted copy readable when its source is gone", () => {
    const onSelect = vi.fn();
    render(() => undefined, onSelect);
    const stored = row("Stored session");
    const activation = stored.querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(stored.querySelector(".th-tree-source")).toBeNull();
    expect(activation?.disabled).toBe(false);
    act(() => activation?.click());
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[1]);
  });

  it("renders an already-open source as inert without legacy adoption metadata", () => {
    render();
    const opened = row("Adopted source");
    expect(opened.querySelector(".th-tree-source")).toBeNull();
    expect(opened.querySelector<HTMLButtonElement>(".th-tree-activation")?.disabled).toBe(true);
  });

  it("renders a discovered session as a direct primary action without an import badge", () => {
    render();
    const discovered = row("Discovered session");
    expect(discovered.querySelector(".th-tree-source")).toBeNull();
    expect(discovered.querySelector<HTMLButtonElement>(".th-tree-activation")?.disabled).toBe(false);
    expect(discovered.textContent).not.toContain("sidebar.tm.missingOriginal");
  });
});
