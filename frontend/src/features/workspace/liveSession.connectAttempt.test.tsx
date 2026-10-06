import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  __resetLiveBadgeStoreForTests, useMergedLiveSummaries,
} from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { LiveSessionList } from "./LiveSessionList";
import { useLiveSessionInfos } from "./useLiveSessions";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { Workspace } from "./workspace";

// Authenticated capture: /tmp/live-card-provenance-review-20260926/connect-attempt-wire.log.
const old = {
  instanceId: "7HYUJZXUM7TQC4AGMFJGTTWJQV",
  row: { id: "A", durableSessionId: "X", title: "A", active: false,
    last_activity_ms: 1790430481259, running: { agents: 7, tasks: 7, dag: 0 } },
} as const;
const fresh = {
  instanceId: "VVLOFPJWWHUYMGZYLSVBIYDUKT",
  row: { id: "A", durableSessionId: "Y", title: "A", active: false,
    last_activity_ms: 1790430481307, running: { agents: 2, tasks: 2, dag: 0 } },
} as const;

class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(_data: string): void {}
  close(): void { this.readyState = Socket.CLOSED; }
  open(): void {
    this.readyState = Socket.OPEN;
    this.onopen?.(new Event("open"));
  }
  message(data: object): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  disconnect(): void {
    this.readyState = Socket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }
}

const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: [{ id: "A", name: "A", provider: "omo" }],
}];
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let infos: readonly LiveSessionInfo[];
let response: Promise<Response>;
let resolveResponse: (value: Response) => void;

function deferResponse(): void {
  response = new Promise((resolve) => { resolveResponse = resolve; });
}

function Host() {
  infos = useLiveSessionInfos(true);
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = {
    summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined, onOpen: async () => "opened" as const,
  };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}

function socket(index: number): Socket {
  const result = Socket.instances[index];
  if (result === undefined) throw new TypeError("Expected connection attempt");
  return result;
}

async function settle(epoch: typeof old | typeof fresh): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ instanceId: epoch.instanceId, sessions: [epoch.row] })));
    await response;
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Socket.instances = [];
  __resetLiveBadgeStoreForTests();
  deferResponse();
  vi.stubGlobal("fetch", vi.fn(() => response));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("drops old REST after a new socket starts CONNECTING (overflow=%s)", async (overflow) => {
  act(() => {
    socket(0).open();
    socket(0).message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId: old.instanceId });
  });
  await settle(old); // The mount request predates the first open.
  expect(infos).toEqual([]);

  await act(async () => vi.advanceTimersByTimeAsync(3999));
  act(() => socket(0).disconnect());
  deferResponse();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(2); // REST begins during reconnect backoff.
  await act(async () => vi.advanceTimersByTimeAsync(999));
  expect(Socket.instances).toHaveLength(2);
  expect(socket(1).readyState).toBe(Socket.CONNECTING);

  await settle(old); // The response must not adopt old membership or ownership.
  expect(infos).toEqual([]);
  expect(__liveIdentitySnapshotForTests().owners).toEqual({});
  expect([...container.querySelectorAll(".th-overview-card-running")]).toEqual([]);

  act(() => {
    socket(1).open();
    socket(1).message({ type: "hello", version: 3, serverVersion: "1.2.3", instanceId: fresh.instanceId });
    socket(1).message({ ...fresh.row, type: "sessions.activity", sessionId: "A", overflow });
  });
  expect(infos.map(({ durableSessionId, lean }) => [durableSessionId, lean?.running?.tasks])).toEqual([["Y", 2]]);
  expect([...container.querySelectorAll(".th-overview-card-running")].map((el) => el.textContent))
    .toEqual(["2", "2"]);
});
