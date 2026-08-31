import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext } from "../../i18n";
import { FileBrowser } from "./FileBrowser";
import { fsList, fsRead, fsWrite } from "./terminal";
import { i18n, listing } from "./fileBrowserTestSupport";

vi.mock("./terminal", () => ({
  downloadUrl: (path: string) => `/download?path=${path}`,
  fsList: vi.fn(),
  fsRead: vi.fn(),
  fsWrite: vi.fn(),
  uploadFiles: vi.fn(),
}));

describe("FileBrowser focus", () => {
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(fsList).mockResolvedValue(listing);
    vi.mocked(fsRead).mockResolvedValue({ content: "original", size: 8 });
    vi.mocked(fsWrite).mockResolvedValue(undefined);
    opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileBrowser
            path="/work"
            wsId="workspace-1"
            tmId="terminal-1"
            onClose={() => undefined}
            notify={() => undefined}
            width={320}
            onWidthChange={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    opener.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("moves focus into the overlay and restores it after Escape closes", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileBrowser
            path="/work"
            wsId="workspace-1"
            tmId="terminal-1"
            onClose={onClose}
            notify={() => undefined}
            width={320}
            onWidthChange={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });

    const closeButton = container.querySelector<HTMLButtonElement>(".th-files-head .th-btn-icon");
    if (!closeButton) throw new Error("File browser close button is missing");
    expect(document.activeElement).toBe(closeButton);

    act(() => {
      closeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();

    act(() => root.render(<></>));
    expect(document.activeElement).toBe(opener);
  });

  it("guards header and Escape overlay closes while the editor is dirty", async () => {
    const onClose = vi.fn();
    vi.mocked(fsList).mockResolvedValue({
      path: "/files",
      parent: null,
      entries: [{ name: "note.txt", isDir: false, size: 8, modTime: "2026-01-01T00:00:00Z" }],
    });
    await act(async () => root.render(
      <I18nContext.Provider value={i18n}>
        <FileBrowser path="/files" wsId="workspace-1" tmId="terminal-1" onClose={onClose} notify={() => undefined} width={320} onWidthChange={() => undefined} />
      </I18nContext.Provider>,
    ));
    const row = container.querySelector<HTMLButtonElement>(".th-files-name--link");
    await act(async () => row?.click());
    const editor = container.querySelector<HTMLTextAreaElement>(".th-editor-area");
    if (!editor) throw new Error("File editor textarea is missing");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "changed");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => container.querySelector<HTMLButtonElement>(".th-files-head button")?.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] .th-btn--ghost')?.click());
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] .th-btn--danger')?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus to the invoking file row after discarding an editor close", async () => {
    vi.mocked(fsList).mockResolvedValue({
      path: "/files",
      parent: null,
      entries: [{ name: "note.txt", isDir: false, size: 8, modTime: "2026-01-01T00:00:00Z" }],
    });
    await act(async () => root.render(
      <I18nContext.Provider value={i18n}>
        <FileBrowser path="/files" wsId="workspace-1" tmId="terminal-1" onClose={() => undefined} notify={() => undefined} width={320} onWidthChange={() => undefined} />
      </I18nContext.Provider>,
    ));
    const row = container.querySelector<HTMLButtonElement>(".th-files-name--link");
    await act(async () => row?.click());
    const editor = container.querySelector<HTMLTextAreaElement>(".th-editor-area");
    if (!editor) throw new Error("File editor textarea is missing");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "changed");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".th-editor-head .th-btn-icon")?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] .th-btn--danger')?.click());

    expect(document.activeElement).toBe(container.querySelector(".th-files-name--link"));
  });
});
