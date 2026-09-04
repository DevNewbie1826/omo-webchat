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

describe("App empty-state creation flow", () => {
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

  it("creates an omo chat directly for the default workspace", async () => {
    emptyState.workspaces = [
      { id: "ws-1", name: "one", path: "/one", chats: [] },
      { id: "ws-2", name: "two", path: "/two", chats: [] },
    ];
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp();

    const newChat = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New chat"));
    expect(newChat).toBeDefined();

    act(() => newChat?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(emptyState.createTerminal).toHaveBeenCalledTimes(1);
    expect(emptyState.createTerminal).toHaveBeenCalledWith("ws-1", "", "omo");
    expect(container.querySelector('[data-testid="new-chat-dialog"]')).toBeNull();
    await act(async () => {
      request.resolve({ id: "tm-ws-1", name: "chat-ws-1", provider: "omo" });
    });
  });

  it("does not create a chat when creating a new workspace", async () => {
    await renderApp();

    const newWorkspace = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New workspace"));
    expect(newWorkspace).toBeDefined();

    act(() => newWorkspace?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[data-testid="workspace-wizard"]')).not.toBeNull();

    const createWorkspace = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Create workspace");
    act(() => createWorkspace?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector('[data-testid="sidebar"]')?.getAttribute("data-workspaces")).toBe("1");
    expect(container.querySelector('[data-testid="new-chat-dialog"]')).toBeNull();
    expect(emptyState.createTerminal).not.toHaveBeenCalled();
  });

  it("keeps a pane mounted for a canonical chat outside the loaded sidebar page", async () => {
    const chats = Array.from({ length: 6 }, (_, index) => ({
      id: `chat-${index + 1}`,
      name: `Chat ${index + 1}`,
      provider: "omo" as const,
    }));
    emptyState.workspaces = [{ id: "ws-1", name: "one", path: "/one", chats }];
    emptyState.sessions = new Map([["chat-6", {
      id: "chat-6",
      name: "Chat 6",
      wsId: "ws-1",
      cwd: "/one",
      provider: "omo",
    }]]);
    emptyState.focusedSessionId = "chat-6";

    await renderApp();

    expect(container.querySelector('[data-testid="chat-pane"]')?.getAttribute("data-session-id"))
      .toBe("chat-6");
  });

  it("ignores repeated direct-create clicks while the first request is pending", async () => {
    emptyState.workspaces = [
      { id: "ws-1", name: "one", path: "/one", chats: [] },
    ];
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp();

    const newChat = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New chat"));
    act(() => {
      newChat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      newChat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(emptyState.createTerminal).toHaveBeenCalledTimes(1);
    await act(async () => {
      request.resolve({ id: "tm-once", name: "chat-once", provider: "omo" });
    });
  });
});

describe("App unauthorized handling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = prepareAppEmptyState());
  });

  afterEach(() => {
    teardownAppEmptyState({ container, root });
  });

  it("swaps to the login page in place when the unauthorized handler fires", async () => {
    emptyState.workspaces = [{ id: "ws-1", name: "one", path: "/one", chats: [] }];
    await renderIntoRoot(root, <App />);

    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();

    // App registered the redirect with the api layer at mount.
    expect(emptyState.setUnauthorizedHandler).toHaveBeenCalledWith(expect.any(Function));
    const onUnauthorized = emptyState.setUnauthorizedHandler.mock.calls[0]?.[0];
    expect(onUnauthorized).toBeTypeOf("function");

    // Any 401 (or a confirmed-expired websocket upgrade) funnels into this
    // callback: the same document flips to the login page, no reload.
    await act(async () => {
      onUnauthorized?.();
    });

    expect(container.querySelector(".th-login")).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });
});
