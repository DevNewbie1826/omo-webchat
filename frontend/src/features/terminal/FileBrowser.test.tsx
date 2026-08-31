import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext } from "../../i18n";
import { FileBrowser } from "./FileBrowser";
import { fsList, fsRead, fsWrite, uploadFiles } from "./terminal";
import { deferred, dropFiles, i18n, listing, selectFiles } from "./fileBrowserTestSupport";

vi.mock("./terminal", () => ({
  downloadUrl: (path: string) => `/download?path=${path}`,
  fsList: vi.fn(),
  fsRead: vi.fn(),
  fsWrite: vi.fn(),
  uploadFiles: vi.fn(),
}));

describe("FileBrowser uploads", () => {
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

  it("uploads selected files, prevents concurrent drops, and clears the picker", async () => {
    const pendingUpload = deferred<void>();
    vi.mocked(uploadFiles)
      .mockReturnValueOnce(pendingUpload.promise)
      .mockResolvedValueOnce(undefined);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const choose = container.querySelector<HTMLButtonElement>(".th-files-choose");
    const panel = container.querySelector<HTMLDivElement>(".th-files");
    if (!input || !choose || !panel) throw new Error("File upload controls are missing");

    expect(input.multiple).toBe(true);
    const openPicker = vi.spyOn(input, "click");
    act(() => {
      choose.click();
    });
    expect(openPicker).toHaveBeenCalledOnce();

    const first = new File(["first"], "first.txt", { type: "text/plain" });
    act(() => {
      selectFiles(input, [first]);
    });
    expect(uploadFiles).toHaveBeenCalledExactlyOnceWith("workspace-1", "terminal-1", [first]);
    expect(choose.disabled).toBe(true);
    expect(input.value).toBe("C:\\fakepath\\first.txt");

    act(() => {
      dropFiles(panel, [new File(["blocked"], "blocked.txt")]);
    });
    expect(uploadFiles).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingUpload.resolve();
    });
    expect(input.value).toBe("");
    expect(choose.disabled).toBe(false);

    const dropped = new File(["dropped"], "dropped.txt", { type: "text/plain" });
    act(() => {
      dropFiles(panel, [dropped]);
    });
    expect(uploadFiles).toHaveBeenLastCalledWith("workspace-1", "terminal-1", [dropped]);
    await act(async () => {});
  });

  it("clears the picker after an upload error", async () => {
    vi.mocked(uploadFiles).mockRejectedValueOnce(new Error("Upload failed"));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const choose = container.querySelector<HTMLButtonElement>(".th-files-choose");
    if (!input || !choose) throw new Error("File upload controls are missing");

    act(() => {
      selectFiles(input, [new File(["failed"], "failed.txt")]);
    });
    await act(async () => {});

    expect(input.value).toBe("");
    expect(choose.disabled).toBe(false);
  });
});
