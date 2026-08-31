import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import { App } from "./App";
import { prepareAppEmptyState, renderApp as renderIntoRoot, teardownAppEmptyState } from "./App.testHarness";

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

describe("App document language", () => {
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

  it("syncs the document language with the stored locale", async () => {
    await renderApp();
    expect(document.documentElement.lang).toBe("en");
  });

  it("syncs the document language to ko when Korean is the stored locale", async () => {
    window.localStorage.setItem("th-lang", "ko");
    await renderApp();
    expect(document.documentElement.lang).toBe("ko");
  });
});
