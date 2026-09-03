import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { Sidebar } from "./Sidebar";
import { useMediaQuery } from "../lib/useMediaQuery";
import type { Workspace } from "../features/workspace/workspace";

vi.mock("../lib/useMediaQuery", () => ({ useMediaQuery: vi.fn() }));

describe("Sidebar mobile drawer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(useMediaQuery).mockReturnValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes collapsed mobile drawer controls from accessibility and keyboard navigation", () => {
    const render = (collapsed: boolean): void => {
      root.render(
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={() => undefined}
          workspaces={[]}
          activeTerminalId={null}
          placedSessions={new Set()}
          liveSessions={new Set()}
          expanded={new Set()}
          sessionLists={new Map()}
          sessionPages={new Map()}
          onToggleExpanded={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelectTerminal={() => undefined}
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
    };

    act(() => {
      render(true);
    });
    const sidebar = container.querySelector("aside");
    expect(sidebar?.getAttribute("aria-hidden")).toBe("true");
    expect(sidebar?.hasAttribute("inert")).toBe(true);

    act(() => {
      render(false);
    });
    expect(sidebar?.hasAttribute("aria-hidden")).toBe(false);
    expect(sidebar?.hasAttribute("inert")).toBe(false);
  });

  it("keeps workspace actions visible on touch devices after a chat exists", () => {
    vi.mocked(useMediaQuery).mockImplementation((query) => query === "(hover: none)");
    act(() => {
      root.render(
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => undefined}
          workspaces={[
            {
              id: "ws-1",
              name: "Workspace",
              path: "/work",
              chats: [{ id: "tm-1", name: "Chat", provider: "omo" }],
            } satisfies Workspace,
          ]}
          activeTerminalId={"tm-1"}
          placedSessions={new Set(["tm-1"])}
          liveSessions={new Set()}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", [
            { id: "tm-1", name: "Chat", source: "stored", recencyMs: 1 },
          ]]])}
          sessionPages={new Map()}
          onToggleExpanded={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelectTerminal={() => undefined}
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

    const tree = container.querySelector<HTMLElement>(".th-tree");
    expect(tree?.classList.contains("th-tree--touch")).toBe(true);
    expect(container.querySelector('button[title="sidebar.ws.addTerminal"]')).toBeDefined();
  });
});
