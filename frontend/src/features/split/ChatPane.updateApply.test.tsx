import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate, type I18nValue } from "../../i18n";
import {
  chatSession,
  i18n,
  renderChatPane,
  requireElement,
  setTextareaValue,
} from "./chatPaneTestHarness";

const realI18n: I18nValue = { ...i18n, t: (key, vars) => translate("en", key, vars) };

const restartResult = (before: string, after: string): Response =>
  new Response(
    `{"restarted":true,"engineVersionBefore":"${before}","engineVersionAfter":"${after}","activeChats":1}`,
  );

describe("ChatPane update apply", () => {
  let container: HTMLDivElement;
  let root: Root;
  let finishUpdate: (response: Response) => void;
  let finishRestart: (response: Response) => void;
  const restartRequests: RequestInit[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    restartRequests.length = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/system/update") {
        return new Promise<Response>((resolve) => { finishUpdate = resolve; });
      }
      if (url === "/api/system/engine/restart") {
        if (init) restartRequests.push(init);
        return new Promise<Response>((resolve) => { finishRestart = resolve; });
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function submit(text: string): void {
    const input = requireElement(container.querySelector("textarea"), "missing composer");
    act(() => setTextareaValue(input, text));
    act(() => requireElement(
      container.querySelector<HTMLButtonElement>('button[type="submit"]'),
      "missing send",
    ).click());
  }

  function confirmUpdate(): void {
    act(() => requireElement(
      document.querySelector<HTMLButtonElement>("[data-update-confirm]"),
      "missing update confirmation",
    ).click());
  }

  function clickApply(): void {
    act(() => requireElement(
      document.querySelector<HTMLButtonElement>("[data-update-apply]"),
      "missing apply control",
    ).click());
  }

  function applyControl(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>("[data-update-apply]");
  }

  function updateState(): string | null {
    return document.querySelector("[data-update-state]")?.getAttribute("data-update-state") ?? null;
  }

  async function reachSuccess(): Promise<void> {
    renderChatPane(root, chatSession, realI18n);
    submit("/update");
    confirmUpdate();
    await act(async () => finishUpdate(new Response('{"restartRequired":true}')));
  }

  it("offers the apply control only once the installation has succeeded", async () => {
    // Given an idle chat.
    renderChatPane(root, chatSession, realI18n);
    // When the update dialog is open before and during installation.
    submit("/update");
    expect(updateState()).toBe("confirm");
    expect(applyControl()).toBeNull();
    confirmUpdate();
    expect(updateState()).toBe("running");
    expect(applyControl()).toBeNull();
    // And when the installation fails, the failed state has no apply control either.
    await act(async () => finishUpdate(new Response('{"error":"npm exited 1"}', { status: 500 })));
    expect(updateState()).toBe("error");
    expect(applyControl()).toBeNull();
    // Then only a successful installation offers the apply action.
    confirmUpdate();
    await act(async () => finishUpdate(new Response('{"restartRequired":true}')));
    expect(updateState()).toBe("success");
    expect(applyControl()).not.toBeNull();
    expect(applyControl()?.textContent).toBe("Apply now");
  });

  it("posts to the restart endpoint exactly once, even on a double click", async () => {
    // Given a finished installation.
    await reachSuccess();
    // When the user activates Apply now twice in the same moment.
    const apply = requireElement(applyControl(), "missing apply control");
    act(() => {
      apply.click();
      apply.click();
    });
    // Then exactly one restart request is in flight and the control is disabled.
    expect(restartRequests).toHaveLength(1);
    expect(restartRequests[0]?.method).toBe("POST");
    expect(updateState()).toBe("applying");
    expect(requireElement(applyControl(), "missing apply control").disabled).toBe(true);
    await act(async () => finishRestart(restartResult("0.14.0", "0.15.2")));
    expect(restartRequests).toHaveLength(1);
  });

  it("shows both engine versions once the new version is applied", async () => {
    // Given a finished installation and a restart in flight.
    await reachSuccess();
    clickApply();
    // When the engine answers with the version change.
    await act(async () => finishRestart(restartResult("0.14.0", "0.15.2")));
    // Then the applied state announces both versions and offers no further action.
    expect(updateState()).toBe("applied");
    const status = document.querySelector('.th-update-dialog [role="status"]');
    expect(status?.textContent).toContain("0.14.0");
    expect(status?.textContent).toContain("0.15.2");
    expect(applyControl()).toBeNull();
    expect(document.querySelector("[data-update-confirm]")).toBeNull();
  });

  it("shows the server error and retries explicitly when applying fails", async () => {
    // Given a finished installation and a restart that the server refuses.
    await reachSuccess();
    clickApply();
    await act(async () => finishRestart(
      new Response('{"error":"engine restart already running"}', { status: 409 }),
    ));
    // Then the server error text is shown next to an explicit retry control.
    expect(updateState()).toBe("apply-failed");
    expect(document.querySelector('.th-update-dialog [role="alert"]')?.textContent)
      .toContain("engine restart already running");
    expect(restartRequests).toHaveLength(1);
    // When the user retries, a second request is posted and can succeed.
    clickApply();
    expect(restartRequests).toHaveLength(2);
    await act(async () => finishRestart(restartResult("0.14.0", "0.15.2")));
    expect(updateState()).toBe("applied");
    expect(restartRequests).toHaveLength(2);
  });

  it("keeps an in-flight restart when the dialog is closed", async () => {
    // Given a restart started from the success state.
    await reachSuccess();
    clickApply();
    // When the dialog is closed while the restart is in flight.
    act(() => requireElement(
      document.querySelector<HTMLButtonElement>("[data-update-close]"),
      "missing close",
    ).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Then the restart still completes and reopening shows the applied outcome.
    await act(async () => finishRestart(restartResult("0.14.0", "0.15.2")));
    submit("/update");
    expect(updateState()).toBe("applied");
    expect(restartRequests).toHaveLength(1);
  });
});
