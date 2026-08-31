import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate } from "../../i18n";
import type { I18nValue } from "../../i18n";
import { FileEditor } from "./FileEditor";
import { fsRead, fsWrite } from "./terminal";

vi.mock("./terminal", () => ({ fsRead: vi.fn(), fsWrite: vi.fn() }));

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => translate("en", key, vars),
};

describe("FileEditor close guard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(fsRead).mockResolvedValue({ content: "original", size: 8 });
    vi.mocked(fsWrite).mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileEditor
            path="/work/file.txt"
            name="file.txt"
            onClose={() => undefined}
            notify={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes Escape through dirty-change confirmation", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileEditor
            path="/work/file.txt"
            name="file.txt"
            onClose={onClose}
            notify={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });
    const editor = container.querySelector<HTMLTextAreaElement>(".th-editor-area");
    if (!editor) throw new Error("File editor textarea is missing");

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(editor, "changed");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const discard = dialog?.querySelector<HTMLButtonElement>(".th-btn--danger");
    if (!discard) throw new Error("Discard confirmation is missing");
    await act(async () => {
      discard.click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function setEditorValue(editor: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setValue?.call(editor, value);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FileEditor close request handling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(fsRead).mockResolvedValue({ content: "original", size: 8 });
    vi.mocked(fsWrite).mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderEditor(onClose: () => void, requestClose?: { readonly id: number; readonly target: "browser" }): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileEditor
            path="/work/file.txt"
            name="file.txt"
            onClose={onClose}
            notify={() => undefined}
            {...(requestClose ? { requestClose } : {})}
          />
        </I18nContext.Provider>,
      );
    });
  }

  it("handles each close request id exactly once", async () => {
    const onClose = vi.fn();
    renderEditor(onClose, { id: 1, target: "browser" });
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("browser");

    // A re-render with a fresh object but the same id must not re-handle.
    renderEditor(onClose, { id: 1, target: "browser" });
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalledTimes(1);

    // A genuinely new request id is handled.
    renderEditor(onClose, { id: 2, target: "browser" });
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("never replays a cancelled browser close after later edits or saves", async () => {
    const onClose = vi.fn();
    renderEditor(onClose);
    await act(async () => undefined);
    const editor = container.querySelector<HTMLTextAreaElement>(".th-editor-area");
    if (!editor) throw new Error("File editor textarea is missing");

    act(() => setEditorValue(editor, "changed"));

    // Dirty browser close request -> confirmation, not a close.
    renderEditor(onClose, { id: 1, target: "browser" });
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();

    // Cancel the confirmation.
    const cancel = dialog?.querySelector<HTMLButtonElement>(".th-btn--ghost");
    if (!cancel) throw new Error("Cancel button is missing");
    await act(async () => {
      cancel.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Editing again must not replay the stale browser close.
    act(() => setEditorValue(editor, "changed again"));
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Saving must not replay the stale browser close either.
    const save = container.querySelector<HTMLButtonElement>(".th-editor-save");
    await act(async () => {
      save?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
