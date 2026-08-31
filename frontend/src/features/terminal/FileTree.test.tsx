import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { setUnauthorizedHandler } from "../../lib/api";
import { FileTree } from "./FileTree";
import { i18n } from "./fileBrowserTestSupport";

function unauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: async () => {
      throw new SyntaxError("empty body");
    },
  } as unknown as Response;
}

describe("FileTree downloads", () => {
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
    setUnauthorizedHandler(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes a download 401 through the shared unauthorized handler without navigation", async () => {
    let signalHandled = (): void => undefined;
    const handled = new Promise<void>((resolve) => {
      signalHandled = resolve;
    });
    const handler = vi.fn(signalHandled);
    setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => unauthorizedResponse()));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await act(async () => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileTree
            entries={[{ name: "notes.txt", isDir: false, size: 5, modTime: "2026-01-01T00:00:00Z" }]}
            path="/work"
            locale="en"
            onOpenFile={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });

    const download = container.querySelector<HTMLButtonElement>(".th-files-dl");
    if (!download) throw new Error("Download button is missing");
    expect(download.tagName).toBe("BUTTON");

    download.click();
    await handled;

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/fs/download?path=%2Fwork%2Fnotes.txt",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
    expect(handler).toHaveBeenCalledExactlyOnceWith();
  });
});
