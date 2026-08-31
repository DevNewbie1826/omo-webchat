import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "./App";
import type { ProviderStatus, Terminal } from "./features/workspace/workspace";
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

describe("App empty-state provider retry", () => {
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

  it("retries unavailable Omo and creates once for the retained workspace", async () => {
    emptyState.workspaces = [
      { id: "ws-1", name: "one", path: "/one", chats: [] },
      { id: "ws-2", name: "two", path: "/two", chats: [] },
    ];
    let providerRequests = 0;
    emptyState.apiJson.mockImplementation(async (path: string) => {
      if (path === "/api/providers") {
        providerRequests += 1;
        return [{
          id: "omo",
          label: "omo",
          binary: "omo",
          available: providerRequests > 1,
        }] as readonly ProviderStatus[];
      }
      if (path === "/api/sessions/live") return { sessions: [] as readonly string[] };
      return [];
    });
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp();

    const newChat = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("New chat"));
    act(() => newChat?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const dialog = container.querySelector<HTMLElement>('[data-testid="new-chat-dialog"]');
    expect(dialog?.dataset["status"]).toBe("loaded");
    expect(dialog?.dataset["available"]).toBe("false");

    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Retry providers");
    await act(async () => {
      retry?.click();
    });

    expect(providerRequests).toBe(2);
    expect(emptyState.createTerminal).toHaveBeenCalledTimes(1);
    expect(emptyState.createTerminal).toHaveBeenCalledWith("ws-1", "", "omo");
    await act(async () => {
      request.resolve({ id: "tm-ws-1", name: "chat-ws-1", provider: "omo" });
    });
  });
});
