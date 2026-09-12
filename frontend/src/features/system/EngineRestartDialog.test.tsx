import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { I18nContext, translate } from "../../i18n";
import type { I18nValue } from "../../i18n";
import { EngineRestartDialog } from "./EngineRestartDialog";
import { restartEngine } from "./system";
import type { EngineRestartResult } from "./system";

vi.mock("./system", () => ({ restartEngine: vi.fn() }));

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 16,
  setFontSize: () => undefined,
  t: (key, vars) => translate("en", key, vars),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const restarted: EngineRestartResult = {
  restarted: true,
  engineVersionBefore: "0.14.0",
  engineVersionAfter: "0.14.1",
  activeChats: 0,
};

describe("EngineRestartDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderDialog(runningChats: number): Promise<void> {
    await act(async () => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <EngineRestartDialog open onClose={() => undefined} runningChats={runningChats} />
        </I18nContext.Provider>,
      );
    });
  }

  function panel(): HTMLElement {
    const el = document.body.querySelector<HTMLElement>(".th-modal");
    expect(el, "dialog panel").not.toBeNull();
    return el!;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const found = Array.from(panel().querySelectorAll<HTMLButtonElement>("button")).find(
      (btn) => btn.textContent === text,
    );
    expect(found, `button "${text}"`).not.toBeUndefined();
    return found!;
  }

  function statusRegion(): HTMLElement | null {
    return panel().querySelector<HTMLElement>('[role="status"]');
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(restartEngine).mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the plain confirmation without a warning when no chats are running", async () => {
    await renderDialog(0);
    expect(panel().querySelector(".th-confirm-title")?.textContent).toBe("Restart omo engine");
    expect(panel().querySelector(".th-alert--warning")).toBeNull();
    expect(statusRegion()).toBeNull();
  });

  it("warns with the running chat count when chats are running", async () => {
    await renderDialog(3);
    const warning = panel().querySelector<HTMLElement>(".th-alert--warning");
    expect(warning, "running-chat warning").not.toBeNull();
    expect(warning!.textContent).toContain("3");
  });

  it("posts exactly once on confirm and shows both versions on success", async () => {
    const pending = deferred<EngineRestartResult>();
    const restart = vi.mocked(restartEngine);
    restart.mockReturnValue(pending.promise);

    await renderDialog(0);
    act(() => {
      buttonByText("Restart").click();
    });
    expect(restart).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(restarted);
    });
    const status = statusRegion();
    expect(status, "success status").not.toBeNull();
    expect(status!.getAttribute("aria-live")).toBe("polite");
    expect(status!.textContent).toContain("0.14.0");
    expect(status!.textContent).toContain("0.14.1");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("posts only once even when confirm is double clicked", async () => {
    const pending = deferred<EngineRestartResult>();
    const restart = vi.mocked(restartEngine);
    restart.mockReturnValue(pending.promise);

    await renderDialog(1);
    const confirmButton = buttonByText("Restart");
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(buttonByText("Restart").disabled).toBe(true);

    await act(async () => {
      pending.resolve(restarted);
    });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("shows the server error and a retry control that posts again", async () => {
    const restart = vi.mocked(restartEngine);
    restart.mockRejectedValueOnce(new Error("engine restart already running"));

    await renderDialog(0);
    await act(async () => {
      buttonByText("Restart").click();
    });
    const alert = panel().querySelector<HTMLElement>('[role="alert"]');
    expect(alert, "error alert").not.toBeNull();
    expect(alert!.textContent).toContain("engine restart already running");

    restart.mockResolvedValueOnce(restarted);
    await act(async () => {
      buttonByText("Retry").click();
    });
    expect(restart).toHaveBeenCalledTimes(2);
    expect(statusRegion()?.textContent).toContain("0.14.1");
  });
});
