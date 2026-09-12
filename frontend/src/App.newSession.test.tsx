import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { deferred, emptyState, prepareAppEmptyState, renderApp, teardownAppEmptyState } from "./App.testHarness";
import { ControlledResizeObserver, pressKey, renderChatPane, requireElement, setTextareaValue } from "./features/split/chatPaneTestHarness";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "./lib/chatWs";
import type { Terminal, Workspace } from "./features/workspace/workspace";

vi.mock("./features/auth/auth", async () => (await import("./App.testHarness")).authMock);
vi.mock("./lib/api", async () => (await import("./App.testHarness")).apiMock);
vi.mock("./features/split/useLayout", async () => {
  const { useLayoutMock, emptyState } = await import("./App.testHarness");
  return { useLayout: () => ({ ...useLayoutMock.useLayout(), root: emptyState.splitEnabled
    ? { kind: "split", id: "split", dir: "h", ratio: 0.5,
      first: { kind: "leaf", id: "pane-1", sessionId: null },
      second: { kind: "leaf", id: "pane-2", sessionId: "old" } }
    : { kind: "leaf", id: "pane-1", sessionId: "old" } }) };
});
vi.mock("./features/split/paneTree", async (original) => ({ ...await original<typeof import("./features/split/paneTree")>(), ...(await import("./App.testHarness")).paneTreeMock }));
vi.mock("./components/Sidebar", async () => {
  const { sidebarMock } = await import("./App.testHarness");
  return { ...sidebarMock, Sidebar: (props: Parameters<typeof sidebarMock.Sidebar>[0] & {
    onSelectTerminal: (ws: Workspace, chat: Terminal) => void;
  }) => <><sidebarMock.Sidebar {...props} />{props.workspaces.flatMap(ws => ws.chats.map(chat =>
    <button key={chat.id} data-chat-id={chat.id} onClick={() => props.onSelectTerminal(ws, chat)}>{chat.name}</button>,
  ))}</> };
});
vi.mock("./features/workspace/WorkspaceWizard", async () => (await import("./App.testHarness")).workspaceWizardMock);
vi.mock("./components/NewChatDialog", async () => (await import("./App.testHarness")).newChatDialogMock);
vi.mock("./features/workspace/useWorkspaces", async () => (await import("./App.testHarness")).useWorkspacesMock);
vi.mock("./features/terminal/terminal", async () => (await import("./App.testHarness")).terminalMock);
vi.mock("./lib/useMediaQuery", async () => (await import("./App.testHarness")).useMediaQueryMock);
vi.mock("./lib/chatWs", async (original) => ({
  ...await original<typeof import("./lib/chatWs")>(),
  connectChat: ((handlers) => {
    handlers.onOpen?.();
    return { send: (frame) => {
      // App also owns a live-session subscription socket. Deliver only to the
      // connection actually bound to the chat, not whichever connected last.
      if (frame.type === "chat.create") transport.deliver = handlers.onFrame;
      transport.sent.push(frame);
      return true;
    }, close: () => undefined };
  }) satisfies ChatConnector,
}));

const transport = vi.hoisted(() => ({ sent: [] as ChatClientFrame[], deliver: (_frame: ChatServerFrame) => {} }));

describe("App local /new command", () => {
  let mount: ReturnType<typeof prepareAppEmptyState>;
  beforeEach(() => {
    mount = prepareAppEmptyState();
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    transport.sent = [];
    emptyState.workspaces = [
      { id: "default", name: "Default", path: "/default", chats: [] },
      { id: "current", name: "Current", path: "/current", chats: [{ id: "old", name: "Old chat", provider: "omo" }] },
    ];
    emptyState.focusedSessionId = "old";
    emptyState.sessions.set("old", { id: "old", name: "Old chat", wsId: "current", cwd: "/current", provider: "omo" });
    emptyState.sessionPages.set("current", { ready: true, loading: false, hasMore: false, nextCursor: "" });
  });
  afterEach(() => {
    teardownAppEmptyState(mount);
    ControlledResizeObserver.instances = [];
  });

  function submit(text: string): void {
    const input = requireElement(mount.container.querySelector("textarea"), "composer");
    act(() => setTextareaValue(input, text));
    act(() => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }

  it("creates a separate chat in the current workspace without sending /new to the old session", async () => {
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp(mount.root, <App />);
    submit(" /new \n");
    expect(emptyState.createTerminal).toHaveBeenCalledExactlyOnceWith("current", "", "omo");
    expect(transport.sent.filter(frame => frame.type === "chat.send")).toEqual([]);
    expect(emptyState.assignSession).not.toHaveBeenCalled();
    await act(async () => request.resolve({ id: "new", name: "New chat", provider: "omo" }));
    expect(emptyState.assignSession).toHaveBeenCalledExactlyOnceWith("pane-1", "new", false);
    expect(mount.container.querySelector('[data-testid="sidebar-session-new"]')).not.toBeNull();
    expect(Array.from(mount.container.querySelectorAll('[data-chat-id]'), row => row.getAttribute("data-chat-id"))).toEqual(["old", "new"]);
    expect(transport.sent.some(frame => frame.type === "chat.disconnect")).toBe(false);
  });

  it("deduplicates submissions while creation is pending and allows retry after failure", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<Terminal>((_resolve, fail) => { reject = fail; });
    emptyState.createTerminal.mockReturnValueOnce(pending);
    await renderApp(mount.root, <App />);
    submit("/new");
    submit("/new");
    expect(emptyState.createTerminal).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("creation failed")));
    expect(emptyState.assignSession).not.toHaveBeenCalled();
    expect(mount.container.querySelector(".th-toast--error")).not.toBeNull();
    expect(mount.container.querySelector(".th-termhead-name")?.textContent).toBe("Old chat");
    emptyState.createTerminal.mockResolvedValueOnce({ id: "retry", name: "Retry", provider: "omo" });
    await act(async () => submit("/new"));
    expect(emptyState.createTerminal).toHaveBeenCalledTimes(2);
    expect(emptyState.assignSession).toHaveBeenCalledWith("pane-1", "retry", false);
    expect(transport.sent.filter(frame => frame.type === "chat.send")).toEqual([]);
  });

  it("does not place the new chat into a pane closed during creation", async () => {
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp(mount.root, <App />);
    submit("/new");
    emptyState.hasPane.mockReturnValueOnce(false);
    await act(async () => request.resolve({ id: "unplaced", name: "Unplaced", provider: "omo" }));
    expect(emptyState.assignSession).not.toHaveBeenCalled();
    expect(mount.container.querySelector('[data-testid="sidebar-session-unplaced"]')).not.toBeNull();
  });

  it("targets the originating split pane rather than the globally focused pane", async () => {
    emptyState.splitEnabled = true;
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp(mount.root, <App />);
    expect(mount.container.querySelector('[data-pane-id="pane-2"] textarea')).not.toBeNull();
    submit("/new");
    expect(emptyState.createTerminal).toHaveBeenCalledExactlyOnceWith("current", "", "omo");
    await act(async () => request.resolve({ id: "split-new", name: "Split new", provider: "omo" }));
    expect(emptyState.assignSession).toHaveBeenCalledExactlyOnceWith("pane-2", "split-new", false);
    expect(transport.sent.filter(frame => frame.type === "chat.send")).toEqual([]);
  });

  it("retains the new chat without replacing a newer selection in the same pane", async () => {
    const request = deferred<Terminal>();
    emptyState.createTerminal.mockReturnValueOnce(request.promise);
    await renderApp(mount.root, <App />);
    submit("/new");
    // Selecting an existing chat captures a newer pane intent while creation
    // is pending. Completion must not overwrite that explicit navigation.
    act(() => requireElement(mount.container.querySelector<HTMLButtonElement>('[data-chat-id="old"]'), "old chat").click());
    await act(async () => request.resolve({ id: "retained", name: "Retained", provider: "omo" }));
    expect(emptyState.assignSession).toHaveBeenCalledExactlyOnceWith("pane-1", "old");
    expect(mount.container.querySelector('[data-testid="sidebar-session-retained"]')).not.toBeNull();
  });

  it("reserves exact /new despite a provider collision, including the steering shortcut", async () => {
    emptyState.createTerminal.mockReturnValueOnce(deferred<Terminal>().promise);
    await renderApp(mount.root, <App />);
    act(() => transport.deliver({ type: "commands", sessionId: "old", commands: [
      { name: "new", source: "extension", syntax: "slash", description: "Provider new" },
      { name: "new", source: "skill", syntax: "dollar", description: "Dollar new" },
    ] }));
    const input = requireElement(mount.container.querySelector("textarea"), "composer");
    act(() => setTextareaValue(input, "/new"));
    expect(mount.container.querySelectorAll('[role="option"]')).toHaveLength(1);
    act(() => pressKey(input, "Enter")); // palette inserts, never executes
    expect(emptyState.createTerminal).not.toHaveBeenCalled();
    act(() => transport.deliver({ type: "run.started", sessionId: "old" }));
    expect(mount.container.querySelector('[data-chat-run-state]')?.getAttribute('data-chat-run-state')).toBe("responding");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(emptyState.createTerminal).toHaveBeenCalledExactlyOnceWith("current", "", "omo");
    expect(transport.sent.filter(frame => frame.type === "chat.send")).toEqual([]);
  });

  it.each(["/new topic", "hello /new", "$new", "/newer", "normal prompt"])("preserves the existing prompt path for %s", async (text) => {
    await renderApp(mount.root, <App />);
    submit(text);
    expect(emptyState.createTerminal).not.toHaveBeenCalled();
    expect(transport.sent).toContainEqual(expect.objectContaining({ type: "chat.send", run: expect.objectContaining({ message: text }) }));
  });

  it("does not execute /new during IME composition", async () => {
    await renderApp(mount.root, <App />);
    const input = requireElement(mount.container.querySelector("textarea"), "composer");
    act(() => setTextareaValue(input, "/new"));
    let event!: KeyboardEvent;
    act(() => { event = pressKey(input, "Enter", { isComposing: true }); });
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe("/new");
    expect(emptyState.createTerminal).not.toHaveBeenCalled();
    expect(transport.sent.filter(frame => frame.type === "chat.send")).toEqual([]);
  });

  it("never forwards /new when rendered without a new-chat action", () => {
    const { sent } = renderChatPane(mount.root);
    submit("/new");
    expect(sent.filter(frame => frame.type === "chat.send")).toEqual([]);
    expect(mount.container.querySelector("textarea")?.value).toBe("/new");
    expect(emptyState.createTerminal).not.toHaveBeenCalled();
  });
});
