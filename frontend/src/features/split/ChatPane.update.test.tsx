import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

describe("ChatPane update", () => {
  let container: HTMLDivElement;
  let root: Root;
  let finishUpdate: (response: Response) => void;
  const updateRequests: RequestInit[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    updateRequests.length = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/system/update") {
        if (init) updateRequests.push(init);
        return new Promise<Response>((resolve) => { finishUpdate = resolve; });
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
      document.querySelector<HTMLButtonElement>('[data-update-confirm]'),
      "missing update confirmation",
    ).click());
  }

  it("confirms an exact update and installs once without sending a model prompt", async () => {
    // Given an idle chat and a pending package installation.
    const { sent } = renderChatPane(root);
    // When the user submits /update and confirms the dialog twice.
    submit("/update");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(updateRequests).toHaveLength(0);
    confirmUpdate();
    confirmUpdate();
    // Then only the authenticated update endpoint is called.
    expect(updateRequests).toHaveLength(1);
    expect(updateRequests[0]?.method).toBe("POST");
    expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
    await act(async () => finishUpdate(new Response('{"restartRequired":true}')));
    expect(document.querySelector("[data-update-state]")?.getAttribute("data-update-state")).toBe("success");
    expect(document.querySelector("[data-update-confirm]")).toBeNull();
  });

  it("cancels before confirmation without installing or sending a prompt", () => {
    // Given an idle chat.
    const { sent } = renderChatPane(root);
    // When the user closes the update confirmation.
    submit("/update");
    act(() => requireElement(
      document.querySelector<HTMLButtonElement>("[data-update-close]"),
      "missing close",
    ).click());
    // Then nothing is installed or sent.
    expect(updateRequests).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows an installation failure and lets the user explicitly retry", async () => {
    // Given the package manager will fail.
    renderChatPane(root);
    submit("/update");
    // When the user confirms and the endpoint fails.
    confirmUpdate();
    await act(async () => finishUpdate(new Response('{"error":"npm exited 1"}', { status: 500 })));
    // Then the error is visible and a new attempt requires another click.
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("npm exited 1");
    expect(updateRequests).toHaveLength(1);
    confirmUpdate();
    expect(updateRequests).toHaveLength(2);
    await act(async () => finishUpdate(new Response('{"restartRequired":true}')));
  });

  it("keeps a provider-owned update command on the provider path", () => {
    // Given the provider advertises its own /update.
    const { deliver, sent } = renderChatPane(root);
    act(() => deliver({ type: "commands", sessionId: "chat-1", commands: [{ name: "update", source: "extension" }] }));
    // When the user submits that command.
    submit("/update");
    // Then it is not replaced by a webchat installation.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(updateRequests).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);
  });

  it("does not intercept prompts containing update arguments", () => {
    // Given an idle chat.
    const { sent } = renderChatPane(root);
    // When update is part of a longer prompt.
    submit("/update explain this");
    // Then the ordinary prompt path remains available.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(updateRequests).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);
  });

  it("retains the result when the dialog is closed during installation", async () => {
    // Given an installation started from this chat.
    renderChatPane(root);
    submit("/update");
    confirmUpdate();
    // When the dialog is closed and installation completes.
    act(() => requireElement(
      document.querySelector<HTMLButtonElement>("[data-update-close]"),
      "missing close",
    ).click());
    await act(async () => finishUpdate(new Response('{"restartRequired":true}')));
    submit("/update");
    // Then reopening shows the outcome instead of offering another install.
    expect(document.querySelector("[data-update-state]")?.getAttribute("data-update-state")).toBe("success");
    expect(updateRequests).toHaveLength(1);
  });
});
