import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { Terminal, Workspace } from "../features/workspace/workspace";

vi.mock("../lib/useMediaQuery", () => ({ useMediaQuery: vi.fn() }));

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "tm-1", name: "Stored session", provider: "omo" }],
};

const LIVE_RESPONSE = {
  sessions: [
    {
      id: "tm-1",
      title: "Refactor auth",
      task: {
        parent_session_id: "tm-1",
        tasks: [
          {
            task_id: "t1",
            name: "Greeter",
            status: "running",
            updated_at: new Date(Date.now() - 1000).toISOString(),
            live_progress: { activity: "thinking", last_assistant_line: "ls" },
          },
        ],
      },
      dag: null,
    },
  ],
};

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("Sidebar sessions overview entry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(useMediaQuery).mockReturnValue(false);
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

  function renderSidebar(onSelect: (ws: Workspace, tm: Terminal) => void): void {
    act(() => {
      root.render(
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => undefined}
          workspaces={[workspace]}
          activeTerminalId={null}
          placedSessions={new Set()}
          liveSessions={new Set(["tm-1"])}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [
            { id: "tm-1", name: "Stored session", source: "stored", recencyMs: 1 },
          ]]])}
          sessionPages={new Map()}
          onToggleExpanded={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelectTerminal={onSelect}
          onOpenSession={async () => undefined}
          onAddWorkspace={() => undefined}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          onLogout={() => undefined}
          notify={() => undefined}
        />,
      );
    });
  }

  it("opens the overview panel from the sidebar and routes card clicks to the chat", async () => {
    const fetchMock = vi.fn(async () => okResponse(LIVE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const onSelect = vi.fn();

    renderSidebar(onSelect);

    const trigger = container.querySelector<HTMLButtonElement>('button[title="sidebar.overview"]');
    expect(trigger).not.toBeNull();
    // Poll result has not landed yet; the panel is closed and nothing is mounted.
    expect(document.body.querySelector(".th-overview")).toBeNull();

    act(() => {
      trigger?.click();
    });
    // Data lands on the shared poller; the panel shows the live session card.
    await act(async () => {});
    const panel = document.body.querySelector(".th-overview");
    expect(panel).not.toBeNull();
    const cards = document.body.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Refactor auth");

    act(() => {
      cards[0]?.click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
    expect(document.body.querySelector(".th-overview")).toBeNull();
  });
});
