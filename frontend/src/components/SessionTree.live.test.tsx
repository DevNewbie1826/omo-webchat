import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { SessionTree } from "./SessionTree";
import type { Workspace } from "../features/workspace/workspace";
import { renameTerminal } from "../features/terminal/terminal";

describe("SessionTree live-process indicator", () => {
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

  it("marks live terminal nodes without changing placed-dot state", () => {
    const workspaces = [
      {
        id: "ws-1",
        name: "Workspace",
        path: "/work",
        chats: [
          { id: "tm-live", name: "Live chat", provider: "omo" },
          { id: "tm-idle", name: "Idle chat", provider: "omo" },
        ],
      } satisfies Workspace,
    ];

    act(() => {
      root.render(
        <SessionTree
          workspaces={workspaces}
          liveSessions={new Set(["tm-live"])}
          activeTerminalId={null}
          placedSessions={new Set(["tm-idle"])}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [
            { id: "tm-live", name: "Live chat", source: "stored", recencyMs: 2 },
            { id: "tm-idle", name: "Idle chat", source: "stored", recencyMs: 1 },
          ]]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
          onImport={async () => undefined}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          notify={() => undefined}
        />,
      );
    });

    const rows = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-node"));
    const liveNode = rows.find((node) => node.textContent?.includes("Live chat"));
    const idleNode = rows.find((node) => node.textContent?.includes("Idle chat"));

    expect(container.querySelector(".th-tree")?.getAttribute("role")).toBe("navigation");
    expect(container.querySelector('[role="tree"]')).toBeNull();
    expect(container.querySelector('[role="treeitem"]')).toBeNull();
    expect(rows).not.toHaveLength(0);
    expect(rows.every((row) => row.getAttribute("role") === null)).toBe(true);
    const workspaceNode = rows.find((node) => node.classList.contains("th-tree-node") && node.parentElement?.classList.contains("th-tree-workspace"));
    expect(workspaceNode?.getAttribute("aria-expanded")).toBeNull();
    expect(workspaceNode?.querySelector(".th-tree-chevron")?.getAttribute("aria-expanded")).toBe("true");

    expect(liveNode).toBeDefined();
    expect(idleNode).toBeDefined();
    if (liveNode === undefined || idleNode === undefined) return;

    expect(liveNode.querySelector(".th-tree-live")).not.toBeNull();
    expect(idleNode.querySelector(".th-tree-live")).toBeNull();
    expect(liveNode.querySelector(".th-tree-activation")?.getAttribute("title")).toBe("sidebar.tm.liveProcess");
    expect(idleNode.querySelector(".th-tree-activation")?.getAttribute("title")).toBeNull();
    expect(liveNode.querySelector(".th-tree-placed")?.classList.contains("th-tree-placed--on")).toBe(false);
    expect(idleNode.querySelector(".th-tree-placed")?.classList.contains("th-tree-placed--on")).toBe(true);
  });

  it("renames a cursor-only stored row through its synthetic terminal", async () => {
    const workspace: Workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/work",
      chats: [],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "cursor-only", name: "Renamed", provider: "omo" }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);
    const onRenameTerminal = vi.fn(async (ws: Workspace, tm: Workspace["chats"][number], name: string) => {
      await renameTerminal(ws.id, tm.id, name);
    });

    act(() => {
      root.render(
        <SessionTree
          workspaces={[workspace]}
          liveSessions={new Set()}
          activeTerminalId={null}
          placedSessions={new Set()}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [
            { id: "cursor-only", name: "Cursor row", source: "stored", recencyMs: 1 },
          ]]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
          onImport={async () => undefined}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={onRenameTerminal}
          notify={() => undefined}
        />,
      );
    });

    const renameButton = container.querySelector<HTMLButtonElement>('button[title="sidebar.tm.rename"]');
    act(() => renameButton?.click());
    const input = container.querySelector<HTMLInputElement>(".th-tree-rename");
    expect(input?.value).toBe("Cursor row");
    act(() => {
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Renamed");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => input?.blur());

    expect(onRenameTerminal).toHaveBeenCalledWith(
      workspace,
      { id: "cursor-only", name: "Cursor row", provider: "omo" },
      "Renamed",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws-1/chats/cursor-only",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }),
    );
  });

  it("renders discovered sessions as importable rows with no store actions", () => {
    const onSelect = vi.fn();
    const onImport = vi.fn(async () => undefined);
    const onDeleteTerminal = vi.fn();
    const onRenameTerminal = vi.fn(async () => undefined);
    const workspace: Workspace = {
      id: "ws-1",
      name: "Workspace",
      path: "/work",
      chats: [{ id: "stored-1", name: "Stored chat", provider: "omo" }],
    };

    act(() => {
      root.render(
        <SessionTree
          workspaces={[workspace]}
          liveSessions={new Set()}
          activeTerminalId={null}
          placedSessions={new Set()}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [
            { id: "omo-session-uuid", name: "Disk session", source: "discovered", recencyMs: 2 },
            { id: "stored-1", name: "Stored chat", source: "stored", recencyMs: 1 },
          ]]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={onSelect}
          onImport={onImport}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={onDeleteTerminal}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={onRenameTerminal}
          notify={() => undefined}
        />,
      );
    });

    const discovered = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-node"))
      .find((node) => node.textContent?.includes("Disk session"));
    const activation = discovered?.querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(discovered?.getAttribute("role")).toBeNull();
    expect(discovered?.getAttribute("aria-disabled")).toBeNull();
    expect(discovered?.getAttribute("aria-expanded")).toBeNull();
    expect(discovered?.getAttribute("aria-selected")).toBeNull();
    expect(activation?.tagName).toBe("BUTTON");
    expect(activation?.getAttribute("aria-label")).toBe("sidebar.tm.discoveredHint");
    expect(activation?.getAttribute("title")).toBe("sidebar.tm.discoveredHint");
    expect(discovered?.querySelectorAll("button")).toHaveLength(1);

    act(() => {
      activation?.click();
      activation?.click();
    });

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDeleteTerminal).not.toHaveBeenCalled();
    expect(onRenameTerminal).not.toHaveBeenCalled();
  });
});
