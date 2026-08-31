import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "./App";
import type { Terminal } from "./features/workspace/workspace";
import {
  deferred,
  emptyState,
  prepareAppEmptyState,
  renderApp as renderIntoRoot,
  teardownAppEmptyState,
} from "./App.testHarness";

vi.mock("./features/auth/auth", async () => (await import("./App.testHarness")).authMock);
vi.mock("./lib/api", async () => (await import("./App.testHarness")).apiMock);
vi.mock("./lib/chatWs", async () => (await import("./App.testHarness")).chatWsMock);
vi.mock("./features/split/useLayout", async () => (await import("./App.testHarness")).useLayoutMock);
vi.mock("./features/split/paneTree", async () => (await import("./App.testHarness")).paneTreeMock);
vi.mock("./features/split/SplitView", async () => (await import("./App.testHarness")).splitViewMock);
vi.mock("./features/split/ChatPane", async () => (await import("./App.testHarness")).chatPaneMock);
vi.mock("./components/Sidebar", async () => (await import("./App.testHarness")).sidebarMock);
vi.mock("./features/workspace/WorkspaceWizard", async () => (await import("./App.testHarness")).workspaceWizardMock);
vi.mock("./components/NewChatDialog", async () => (await import("./App.testHarness")).newChatDialogMock);
vi.mock("./features/workspace/useWorkspaces", async () => (await import("./App.testHarness")).useWorkspacesMock);
vi.mock("./features/terminal/terminal", async () => (await import("./App.testHarness")).terminalMock);
vi.mock("./lib/useMediaQuery", async () => (await import("./App.testHarness")).useMediaQueryMock);

describe("App empty-state creation targeting", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = prepareAppEmptyState());
  });

  afterEach(() => {
    teardownAppEmptyState({ container, root });
  });

  async function renderApp(): Promise<void> {
    await renderIntoRoot(root, <App />);
  }

  it("targets the clicked sidebar workspace for direct creation", async () => {
    emptyState.workspaces = [
      { id: "ws-1", name: "one", path: "/one", chats: [] },
      { id: "ws-2", name: "two", path: "/two", chats: [] },
    ];
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp();

    const addChat = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Add chat ws-2");
    act(() => addChat?.click());

    expect(emptyState.createTerminal).toHaveBeenCalledTimes(1);
    expect(emptyState.createTerminal).toHaveBeenCalledWith("ws-2", "", "omo");
    await act(async () => {
      request.resolve({ id: "tm-ws-2", name: "chat-ws-2", provider: "omo" });
    });
  });

  it("shows a newly created chat immediately in an already-expanded workspace", async () => {
    emptyState.workspaces = [
      { id: "ws-1", name: "one", path: "/one", chats: [] },
    ];
    emptyState.expanded = new Set(["ws-1"]);
    emptyState.sessionPages = new Map([["ws-1", {
      ready: true,
      loading: false,
      hasMore: false,
      nextCursor: "",
    }]]);
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp();

    const addChat = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Add chat ws-1");
    act(() => addChat?.click());

    expect(container.querySelector('[data-testid="sidebar-session-tm-new"]')).toBeNull();
    await act(async () => {
      request.resolve({ id: "tm-new", name: "New chat", provider: "omo" });
    });

    expect(container.querySelector('[data-testid="sidebar-session-tm-new"]')?.textContent)
      .toBe("New chat");
  });

  it("targets the originating split pane for direct creation", async () => {
    emptyState.splitEnabled = true;
    emptyState.workspaces = [
      { id: "ws-1", name: "one", path: "/one", chats: [] },
      { id: "ws-2", name: "two", path: "/two", chats: [] },
    ];
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp();

    const addChat = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Add split chat");
    act(() => addChat?.click());

    expect(emptyState.createTerminal).toHaveBeenCalledTimes(1);
    expect(emptyState.createTerminal).toHaveBeenCalledWith("ws-2", "", "omo");
    await act(async () => {
      request.resolve({ id: "tm-pane-2", name: "chat-pane-2", provider: "omo" });
    });
    expect(emptyState.assignSession).toHaveBeenCalledWith("pane-2", "tm-pane-2");
  });
});
