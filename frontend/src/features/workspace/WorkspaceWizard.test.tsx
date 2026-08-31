import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { WorkspaceWizard } from "./WorkspaceWizard";
import { createWorkspace } from "./workspace";
import { fsBrowse } from "../terminal/terminal";
import type { FsBrowse } from "../terminal/terminal";
import type { Workspace } from "./workspace";

vi.mock("./workspace", () => ({ createWorkspace: vi.fn() }));
vi.mock("../terminal/terminal", () => ({ fsBrowse: vi.fn(), fsCreateFolder: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function footerPrimary(): HTMLButtonElement {
  const button = document.body.querySelector<HTMLButtonElement>(".th-wizard-foot .th-btn--primary");
  if (!button) throw new Error("expected wizard primary button");
  return button;
}

describe("WorkspaceWizard creation", () => {
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
    vi.restoreAllMocks();
  });

  it("ignores a cancelled create after reopening and prevents duplicate submits", async () => {
    const browse = deferred<FsBrowse>();
    vi.mocked(fsBrowse).mockReturnValue(browse.promise);
    const pending = deferred<Workspace>();
    const create = vi.mocked(createWorkspace);
    create.mockReturnValue(pending.promise);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const render = (open: boolean): void => {
      root.render(<WorkspaceWizard open={open} onClose={onClose} onCreated={onCreated} />);
    };

    act(() => {
      render(true);
    });
    expect(fsBrowse).toHaveBeenCalledTimes(1);
    await act(async () => {
      browse.resolve({ path: "/work", parent: null, dirs: [] });
    });

    const select = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("wizard.selectHere"));
    expect(select).toBeDefined();
    act(() => {
      select?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      footerPrimary().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      footerPrimary().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      footerPrimary().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(create).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      render(false);
    });
    act(() => {
      render(true);
    });

    await act(async () => {
      pending.resolve({ id: "ws-1", name: "work", path: "/work", chats: [] });
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});
