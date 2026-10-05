import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTree } from "./SessionTree";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "chat-stored", name: "Stored chat", provider: "omo" }],
};

/** Post-auto-enrollment wire contract: daemon sessions arrive as stored chat rows. */
const discoveredRow: WorkspaceSession = {
  id: "disk-session-key",
  name: "Disk session",
  source: "discovered",
  recencyMs: 1,
  resumeIdentity: "/sessions/disk-session.jsonl",
};

const storedRow: WorkspaceSession = {
  id: "chat-stored",
  name: "Stored chat",
  source: "stored",
  recencyMs: 2,
  live: true,
  durableSessionID: "dur-1",
};

describe("SessionTree single chat-row list after rpc auto-enrollment", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn((_ws: Workspace, _tm: Terminal) => undefined);

  function renderTree(sessions: readonly WorkspaceSession[]): void {
    act(() => {
      root.render(
        <SessionTree
          workspaces={[workspace]}
          activeTerminalId={null}
          placedSessions={new Set<string>()}
          liveSessions={new Set<string>()}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", sessions]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={onSelect}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          notify={() => undefined}
        />,
      );
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const rows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"));

  const rowOf = (name: string): HTMLElement => {
    const row = rows().find((item) => item.textContent?.includes(name));
    expect(row).toBeDefined();
    return row!;
  };

  it("activates a stored chat row through the ordinary select flow", () => {
    renderTree([storedRow]);
    const activation = rowOf("Stored chat").querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(activation?.disabled).toBe(false);
    act(() => activation?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
  });

  it("renders the server-reported live flag on the row without the webchat live feed", () => {
    renderTree([storedRow]);
    const row = rowOf("Stored chat");
    expect(row.querySelector(".th-tree-live")).not.toBeNull();
    expect(row.querySelector<HTMLButtonElement>(".th-tree-activation")?.getAttribute("title"))
      .toBe("sidebar.tm.liveProcess");
  });

  it("renders a discovered row inert, with no click-to-open affordance", () => {
    renderTree([discoveredRow, storedRow]);
    const discovered = rowOf("Disk session");
    const activation = discovered.querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(activation?.disabled).toBe(true);
    expect(activation?.getAttribute("aria-label")).toBeNull();
    act(() => activation?.click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(discovered.querySelector(".th-tree-actions")).toBeNull();
  });

  it("offers no takeover, retry or view-live controls anywhere in the tree", () => {
    renderTree([discoveredRow, storedRow, { ...storedRow, id: "chat-dangling", dangling: true }]);
    for (const selector of [
      ".th-tree-session-active",
      ".th-tree-view-live",
      ".th-tree-force-open",
      ".th-tree-retry-open",
    ]) {
      expect(container.querySelector(selector)).toBeNull();
    }
  });
});
