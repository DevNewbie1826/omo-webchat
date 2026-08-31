import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { WorkspaceFolderPickerStep } from "./WorkspaceFolderPickerStep";
import { fsCreateFolder } from "../terminal/terminal";
import type { FsBrowse } from "../terminal/terminal";
import type { FolderPickerState } from "./WorkspaceWizard";

vi.mock("../terminal/terminal", () => ({ fsCreateFolder: vi.fn() }));

function pickerState(overrides: Partial<FolderPickerState> = {}): FolderPickerState {
  const data: FsBrowse = { path: "/work", parent: null, dirs: ["existing"] };
  return {
    data,
    selected: "/work",
    loading: false,
    error: "",
    navigate: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`expected button containing ${text}`);
  return button;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WorkspaceFolderPickerStep new folder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(fsCreateFolder).mockClear();
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

  it("creates the folder, reloads, and navigates into it", async () => {
    const picker = pickerState();
    vi.mocked(fsCreateFolder).mockResolvedValue({ path: "/work/new-dir" });
    act(() => {
      root.render(<WorkspaceFolderPickerStep picker={picker} onSelect={vi.fn()} />);
    });

    act(() => {
      buttonWithText("wizard.newFolder").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const input = document.body.querySelector<HTMLInputElement>(".th-picker-newfolder-input");
    if (!input) throw new Error("expected new folder input");
    act(() => {
      typeInto(input, "new-dir");
    });
    await act(async () => {
      buttonWithText("wizard.newFolder").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(fsCreateFolder).toHaveBeenCalledWith("/work", "new-dir");
    expect(fsCreateFolder).toHaveBeenCalledTimes(1);
    expect(picker.navigate).toHaveBeenCalledWith("/work/new-dir");
    expect(picker.reload).toHaveBeenCalledTimes(1);
    expect(picker.navigate).toHaveBeenCalledTimes(1);
  });

  it("keeps the form and shows the error without navigating on failure", async () => {
    const picker = pickerState();
    vi.mocked(fsCreateFolder).mockRejectedValue(new Error("directory already exists"));
    act(() => {
      root.render(<WorkspaceFolderPickerStep picker={picker} onSelect={vi.fn()} />);
    });

    act(() => {
      buttonWithText("wizard.newFolder").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const input = document.body.querySelector<HTMLInputElement>(".th-picker-newfolder-input");
    if (!input) throw new Error("expected new folder input");
    act(() => {
      typeInto(input, "dupe");
    });
    await act(async () => {
      buttonWithText("wizard.newFolder").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "directory already exists",
    );
    expect(document.body.querySelector<HTMLInputElement>(".th-picker-newfolder-input")).not.toBeNull();
    expect(picker.navigate).not.toHaveBeenCalled();
    expect(picker.reload).not.toHaveBeenCalled();
  });

  it("ignores a blank name even when the form is submitted", async () => {
    const picker = pickerState();
    act(() => {
      root.render(<WorkspaceFolderPickerStep picker={picker} onSelect={vi.fn()} />);
    });

    act(() => {
      buttonWithText("wizard.newFolder").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const input = document.body.querySelector<HTMLInputElement>(".th-picker-newfolder-input");
    if (!input) throw new Error("expected new folder input");
    act(() => {
      typeInto(input, "   ");
    });
    expect(buttonWithText("wizard.newFolder").disabled).toBe(true);

    const form = document.body.querySelector<HTMLFormElement>(".th-picker-newfolder-form");
    if (!form) throw new Error("expected new folder form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fsCreateFolder).not.toHaveBeenCalled();
    expect(picker.navigate).not.toHaveBeenCalled();
  });
});
