import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext } from "../../i18n";
import { FileBrowser } from "./FileBrowser";
import { fsList } from "./terminal";
import { i18n, listing } from "./fileBrowserTestSupport";

vi.mock("./terminal", () => ({
  downloadUrl: (path: string) => `/download?path=${path}`,
  fsList: vi.fn(),
  fsRead: vi.fn(),
  fsWrite: vi.fn(),
  uploadFiles: vi.fn(),
}));

describe("FileBrowser resize", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(fsList).mockResolvedValue(listing);
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderWith = (onWidthChange: (px: number) => void, width = 320): void => {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <FileBrowser
            path="/work"
            wsId="workspace-1"
            tmId="terminal-1"
            onClose={() => undefined}
            notify={() => undefined}
            width={width}
            onWidthChange={onWidthChange}
          />
        </I18nContext.Provider>,
      );
    });
  };

  it("renders a labeled separator handle at the current width", () => {
    const handle = container.querySelector<HTMLElement>(".th-files-resize[role='separator']");
    if (!handle) throw new Error("Resize handle is missing");
    expect(handle.getAttribute("aria-label")).toBe("Resize file panel");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("720");
    expect(handle.tabIndex).toBe(0);
  });

  it("resizes by pointer drag, clamped to the min/max bounds", () => {
    const onWidthChange = vi.fn();
    renderWith(onWidthChange);
    const aside = container.querySelector<HTMLElement>(".th-files");
    const handle = container.querySelector<HTMLElement>(".th-files-resize");
    if (!aside || !handle) throw new Error("File browser panel or resize handle is missing");
    vi.spyOn(aside, "getBoundingClientRect").mockReturnValue({ right: 1000 } as DOMRect);

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 1000 }));
    });
    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 }));
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 900 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    expect(onWidthChange.mock.calls).toEqual([[400], [720], [240]]);
  });

  it("resizes by arrow keys: left widens, right narrows", () => {
    const onWidthChange = vi.fn();
    renderWith(onWidthChange);
    const handle = container.querySelector<HTMLElement>(".th-files-resize");
    if (!handle) throw new Error("Resize handle is missing");

    act(() => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(onWidthChange.mock.calls).toEqual([[344], [296]]);
  });
});
