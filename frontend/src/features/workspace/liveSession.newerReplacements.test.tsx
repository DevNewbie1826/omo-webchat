import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import {
  __resetLiveBadgeStoreForTests, ingestExtensionEvent, useLiveAgentAggregates, useMergedLiveSummaries,
} from "./liveBadgeStore";
import { LiveSessionList } from "./LiveSessionList";
import { useLiveSessionInfos } from "./useLiveSessions";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import type { Workspace } from "./workspace";

vi.mock("../../lib/chatWs", async (original) => ({
  ...await original<typeof import("../../lib/chatWs")>(),
  connectChat: vi.fn(),
}));

const workspaces: readonly Workspace[] = [{
  id: "workspace", name: "Workspace", path: "/tmp",
  chats: [{ id: "A", name: "A", provider: "omo" }, { id: "B", name: "B", provider: "omo" }],
}];
const wire = (id: string, durable: string, revision: number, tasks: number, replaces?: string) => ({
  type: "sessions.activity", sessionId: id, durableSessionId: durable,
  last_activity_ms: revision, active: false, title: id, running: { agents: tasks, tasks, dag: 0 },
  ...(replaces === undefined ? {} : { replacesSessionId: replaces }),
});
const rest = (id: string, durable: string, revision: number, tasks: number) => ({
  id, durableSessionId: durable, last_activity_ms: revision, active: false,
  title: id, running: { agents: tasks, tasks, dag: 0 },
});

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let handlers: ChatHandlers;
let infos: readonly LiveSessionInfo[];
let aggregates: ReadonlyMap<string, { readonly running: number }>;
let response: Promise<Response>;
let resolveResponse: (response: Response) => void;
function deferResponse(): void {
  response = new Promise(resolve => { resolveResponse = resolve; });
}

function Host() {
  infos = useLiveSessionInfos(true);
  aggregates = useLiveAgentAggregates();
  const summaries = useMergedLiveSummaries(useLiveSessionSummaries(true));
  const props = {
    summaries, workspaces, sessionLists: new Map(),
    onSelect: () => undefined,
    onOpen: async () => "opened" as const,
  };
  return createElement("div", null,
    createElement(LiveSessionList, { ...props, listClassName: "pinned" }),
    createElement(LiveSessionList, { ...props, listClassName: "home" }));
}

function push(fields: object, overflow: boolean): void {
  const frame = parseChatServerFrame({ ...fields, overflow });
  if (frame === null) throw new TypeError("Invalid captured activity");
  act(() => handlers.onFrame(frame));
}

async function settle(sessions: readonly object[]): Promise<void> {
  await act(async () => {
    resolveResponse(new Response(JSON.stringify({ sessions })));
    await response;
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  deferResponse();
  vi.stubGlobal("fetch", vi.fn(() => response));
  vi.mocked(connectChat).mockImplementation(next => {
    handlers = next;
    return { send: vi.fn(), close: vi.fn() };
  });
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

it.each([false, true])("admits captured replacement after REST retired A (overflow=%s)", async overflow => {
  // Captured: A:X@1790426734327 -> REST [] -> B:X@1790426734350 replaces A.
  push(wire("A", "X", 1790426734327, 1), false);
  await settle([]);
  deferResponse();
  await act(async () => vi.advanceTimersToNextTimerAsync());
  await settle([]);
  expect(infos).toEqual([]);

  push(wire("B", "X", 1790426734350, 2, "A"), overflow);
  expect(infos.map(({ id, lean }) => ({ id, tasks: lean?.running?.tasks })))
    .toEqual([{ id: "B", tasks: 2 }]);
  expect([...aggregates].map(([id, value]) => [id, value.running])).toEqual([]);
  expect([...container.querySelectorAll(".th-overview-card-running")].map(el => el.textContent))
    .toEqual(["2", "2"]);
});

it.each([false, true])("admits captured replacement after REST-only A:Y (overflow=%s)", async overflow => {
  // Captured: A:X@1790426734401 -> REST A:Y@1790426734435
  // -> B:X@1790426734477 replaces A. A's Y authority cannot migrate.
  push(wire("A", "X", 1790426734401, 1), false);
  await settle([rest("A", "Y", 1790426734435, 3)]);
  expect(infos[0]?.durableSessionId).toBe("Y");
  act(() => ingestExtensionEvent("A", "omo.dag.updated", { agent_running_count: 3 },
    undefined, 1790426734436));
  expect(aggregates.get("A")?.running).toBe(3);

  push(wire("B", "X", 1790426734477, 2, "A"), overflow);
  expect(infos.map(({ id, lean }) => ({ id, tasks: lean?.running?.tasks })))
    .toEqual([{ id: "B", tasks: 2 }]);
  expect([...container.querySelectorAll(".th-overview-card-running")].map(el => el.textContent))
    .toEqual(["2", "2"]);
  expect(aggregates.has("B")).toBe(false);
  expect(aggregates.has("A")).toBe(false);
});
