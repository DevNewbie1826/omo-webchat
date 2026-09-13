import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { apiJson } from "../../lib/api";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import { __resetLiveBadgeStoreForTests } from "./liveBadgeStore";

vi.mock("../../lib/chatWs", async original => ({ ...await original<object>(), connectChat: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiJson: vi.fn() }));
vi.mock("../../lib/useMediaQuery", () => ({ useMediaQuery: () => false }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetLiveBadgeStoreForTests();
});

it("restores the Sidebar main-running badge through fresh fallback requests after disconnect", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let handlers!: ChatHandlers;
  let settle!: (response: unknown) => void;
  let scheduledPoll: (() => void) | undefined;
  const schedule = window.setTimeout.bind(window);
  // Drive the registered poll callback directly, without elapsed-time waits.
  vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout, ...args) => {
    const id = schedule(handler, timeout, ...args);
    if (timeout === 4000 && typeof handler === "function") {
      scheduledPoll = () => { window.clearTimeout(id); handler(...args); };
    }
    return id;
  });
  vi.mocked(apiJson).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  vi.mocked(connectChat).mockImplementation(h => {
    handlers = h;
    return { send: () => true, close: () => undefined };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const row = { id: "s", title: "Session", active: true, last_activity_ms: 300,
    running: { agents: 0, tasks: 0, dag: 0 }, done: 7 };
  const badge = () => container.querySelector(".th-overview-card-running");
  const startPoll = () => {
    if (scheduledPoll === undefined) throw new Error("No fallback poll scheduled");
    const callback = scheduledPoll;
    scheduledPoll = undefined;
    act(callback);
  };
  const completePoll = async () => { await act(async () => settle({ sessions: [row] })); };
  try {
    act(() => root.render(<Sidebar
      collapsed={false} onToggleCollapse={() => undefined}
      workspaces={[]} activeTerminalId={null} placedSessions={new Set()} liveSessions={new Set(["s"])}
      expanded={new Set()} sessionLists={new Map()} sessionPages={new Map()}
      onToggleExpanded={() => undefined} onLoadMoreSessions={() => undefined}
      onSelectTerminal={() => undefined} onOpenSession={async () => undefined}
      onAddWorkspace={() => undefined} onAddTerminal={() => undefined}
      onDeleteWorkspace={() => undefined} onDeleteTerminal={() => undefined}
      onRenameWorkspace={async () => undefined} onRenameTerminal={async () => undefined}
      onLogout={() => undefined} notify={() => undefined}
    />));
    await completePoll();
    const frame = parseChatServerFrame({ type: "sessions.activity", sessionId: "s", durableSessionId: "s",
      overflow: false, ...row });
    if (frame === null) throw new Error("Invalid activity fixture");
    act(() => handlers.onFrame(frame));
    expect(badge()).not.toBeNull();
    startPoll();
    act(() => handlers.onClose?.(1006));
    expect(badge()).toBeNull();
    await completePoll();
    expect(badge()).toBeNull();
    startPoll();
    await completePoll();
    expect(badge()).not.toBeNull();
    startPoll();
    await completePoll();
    expect(badge()).not.toBeNull();
    expect(container.querySelector(".th-sidebar-live-count")).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
