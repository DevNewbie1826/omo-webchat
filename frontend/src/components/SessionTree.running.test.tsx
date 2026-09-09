import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { Workspace } from "../features/workspace/workspace";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => (vars ? `${key} ${Object.values(vars).join(" ")}` : key),
};

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [
    { id: "tm-live", name: "Live chat", provider: "omo" },
    { id: "tm-idle", name: "Idle chat", provider: "omo" },
  ],
};

const sessions = [
  { id: "tm-live", name: "Live chat", source: "stored" as const, recencyMs: 2 },
  { id: "tm-idle", name: "Idle chat", source: "stored" as const, recencyMs: 1 },
];

function tree(
  container: HTMLDivElement,
  runningCounts?: ReadonlyMap<string, number>,
  touchActions = false,
  expanded = new Set(["ws-1"]),
  renderedWorkspace = workspace,
  renderedSessions = sessions,
  aggregateSessionIds: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): void {
  const root = (container as HTMLDivElement & { __root?: Root }).__root!;
  act(() => {
    root.render(
      <I18nContext.Provider value={i18n}>
        <SessionTree
          workspaces={[renderedWorkspace]}
          touchActions={touchActions}
          liveSessions={new Set(["tm-live", "tm-idle"])}
          runningCounts={runningCounts}
          aggregateSessionIds={aggregateSessionIds}
          activeTerminalId={null}
          placedSessions={new Set()}
          expanded={expanded}
          sessionLists={new Map([["ws-1", renderedSessions]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
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

describe("SessionTree running-agent badge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (container as HTMLDivElement & { __root?: Root }).__root = root;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function row(name: string): HTMLElement {
    const match = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-node")).find(
      (item) => item.textContent?.includes(name),
    );
    expect(match).toBeDefined();
    return match!;
  }

  it("renders a chip with the exact count and an aria-label only while agents run", () => {
    tree(container, new Map([
      ["tm-live", 2],
      ["tm-idle", 0],
    ]));

    const live = row("Live chat");
    const chip = live.querySelector(".th-tree-running");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("2");
    expect(chip?.getAttribute("aria-label")).toBe("sidebar.tm.runningAgents 2");
    expect(chip?.getAttribute("role")).toBe("img");
    expect(chip?.querySelector(".th-tree-running-dot")).not.toBeNull();
    expect(live.querySelector(".th-tree-live")).not.toBeNull();

    const idle = row("Idle chat");
    expect(idle.querySelector(".th-tree-running")).toBeNull();
    expect(idle.querySelector(".th-tree-live")).not.toBeNull();
  });

  it("renders an exact two-digit count without any unknown or partial marker", () => {
    tree(container, new Map([["tm-live", 50]]));

    const chip = row("Live chat").querySelector(".th-tree-running");
    expect(chip?.textContent).toBe("50");
    expect(chip?.getAttribute("aria-label")).toBe("sidebar.tm.runningAgents 50");
    expect(chip?.getAttribute("title")).toBeNull();
    expect(chip?.textContent).not.toContain("+");
    expect(chip?.textContent).not.toContain("?");
  });

  it("keeps the badge exposed in touch mode and while row actions are focused", () => {
    tree(container, new Map([["tm-live", 2]]), true);

    expect(container.querySelector(".th-tree")?.classList.contains("th-tree--touch")).toBe(true);
    const live = row("Live chat");
    const action = live.querySelector<HTMLButtonElement>(".th-tree-actions button");
    act(() => action?.focus());
    const chip = live.querySelector(".th-tree-running");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("aria-hidden")).toBeNull();

    const css = readFileSync("src/styles/session-tree.css", "utf8");
    expect(css).not.toMatch(/(?:focus-within|th-tree--touch)[^{]*\.th-tree-running\s*\{[^}]*display:\s*none/);
  });

  it("renders a workspace aggregate while collapsed", () => {
    tree(container, new Map([["tm-live", 2]]), false, new Set());

    const workspaceRow = row("Workspace");
    const chip = workspaceRow.querySelector(".th-tree-running");
    expect(chip?.textContent).toBe("2");
    expect(chip?.getAttribute("aria-label")).toBe("sidebar.ws.runningAgents 2");
  });

  it("counts a running cursor-only session in a cold collapsed workspace", () => {
    tree(
      container,
      new Map([["cursor-only", 1]]),
      false,
      new Set(),
      { ...workspace, chats: [] },
      [],
      new Map([["ws-1", new Set(["cursor-only"])]]),
    );

    const workspaceRow = row("Workspace");
    expect(workspaceRow.querySelector(".th-tree-count")?.textContent).toBe("1");
    expect(workspaceRow.querySelector(".th-tree-running")?.textContent).toBe("1");
  });

  it("counts a running cursor-only session beyond the visible first page", () => {
    tree(
      container,
      new Map([["cursor-page-2", 2]]),
      false,
      new Set(),
      { ...workspace, chats: [] },
      sessions,
      new Map([["ws-1", new Set(["cursor-page-2"])]]),
    );

    const workspaceRow = row("Workspace");
    expect(workspaceRow.querySelector(".th-tree-count")?.textContent).toBe("3");
    expect(workspaceRow.querySelector(".th-tree-running")?.textContent).toBe("2");
  });

  it("renders the workspace aggregate and per-session badges when expanded", () => {
    tree(container, new Map([
      ["tm-live", 2],
      ["tm-idle", 1],
    ]));

    const workspaceRow = row("Workspace");
    expect(workspaceRow.querySelector(".th-tree-running")?.textContent).toBe("3");
    expect(container.querySelectorAll(".th-tree-running")).toHaveLength(3);
  });

  it("renders no workspace chip without running counts", () => {
    tree(container, new Map([["tm-live", 0]]));

    expect(row("Workspace").querySelector(".th-tree-running")).toBeNull();
  });

  it("keeps the workspace chat-count pill beside the running aggregate", () => {
    tree(container, new Map([["tm-live", 1]]));

    const workspaceRow = row("Workspace");
    expect(workspaceRow.querySelector(".th-tree-count")?.textContent).toBe("2");
    expect(workspaceRow.querySelector(".th-tree-running")?.textContent).toBe("1");
  });

  it("keeps the workspace chat-count pill when no agents run", () => {
    tree(container);

    const workspaceRow = row("Workspace");
    expect(workspaceRow.querySelector(".th-tree-count")?.textContent).toBe("2");
    expect(workspaceRow.querySelector(".th-tree-running")).toBeNull();
  });

  it("renders no chip at all without running counts", () => {
    tree(container);

    expect(container.querySelector(".th-tree-running")).toBeNull();
    expect(container.querySelectorAll(".th-tree-live")).toHaveLength(2);
  });
});
