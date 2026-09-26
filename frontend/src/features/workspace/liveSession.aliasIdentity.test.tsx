import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsActivityFrame } from "../../lib/contract/types_gen";
import {
  __resetLiveBadgeStoreForTests,
  canonicalLiveSessionId,
  ingestExtensionEvent,
  nextLiveActivitySequence,
  settleLiveBadgePoll,
  useLiveAgentAggregates,
  useLiveBadgeOverrides,
  useMergedLiveSummaries,
} from "./liveBadgeStore";
import { liveDurableOwner } from "./liveSessionIdentity";
import { LiveSessionMembership } from "./liveSessionMembership";
import { parseLeanSessionFields } from "./useLiveSessionsLean";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionInfo } from "./useLiveSessionsLean";
import type { LiveBadgeOverride } from "./liveBadgeStore";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";

const CHAT_A = "r9-chat-a";
const CHAT_B = "r9-chat-b";
const DURABLE_X = "r9-durable-x";
const DURABLE_Y = "r9-durable-y";

function frame(
  sessionId: string,
  durableSessionId: string,
  at: number,
  tasks: number,
  extra?: { readonly replacesSessionId?: string; readonly title?: string; readonly overflow?: boolean },
): SessionsActivityFrame {
  return {
    type: "sessions.activity",
    sessionId,
    durableSessionId,
    overflow: extra?.overflow ?? false,
    title: extra?.title ?? (sessionId === CHAT_A ? "First" : "Second"),
    active: false,
    done: 0,
    dag_done: 0,
    dag_total: 0,
    last_activity_ms: at,
    running: { agents: tasks, tasks, dag: 0 },
    truncated: { task: false, dag: false },
    ...(extra?.replacesSessionId === undefined ? {} : { replacesSessionId: extra.replacesSessionId }),
  };
}

function restRow(id: string, title: string, at: number, tasks: number): LiveSessionInfo {
  return {
    id, title, active: false, task: null, dag: null,
    lean: parseLeanSessionFields({
      last_activity_ms: at,
      running: { agents: tasks, tasks, dag: 0 },
      done: 0, dag_done: 0, dag_total: 0,
    }) ?? {},
  };
}

const CHAT_C = "r9-chat-c";
const DURABLE_Z = "r9-durable-z";

function project(rows: readonly LiveSessionInfo[]): readonly { id: string; title: string; tasks: number | undefined }[] {
  return rows
    .map((row) => ({ id: row.id, title: row.title, tasks: row.lean?.running?.tasks }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

afterEach(() => __resetLiveBadgeStoreForTests());

describe("durable alias identity across independent chats", () => {
  it("keeps both chats' rows when a former owner's durable is published by another chat", () => {
    // A:X, A:Y, B:X (no replacesSessionId), then another A:Y update.
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_A, DURABLE_X, 1000, 1), 1);
    membership.push(frame(CHAT_A, DURABLE_Y, 1002, 2), 2);
    membership.push(frame(CHAT_B, DURABLE_X, 1004, 3), 3);
    membership.push(frame(CHAT_A, DURABLE_Y, 1006, 4), 4);

    // B's publication of X must not merge into or delete A's row; A's later
    // Y update must apply to A only.
    const expected = [
      { id: CHAT_A, title: "First", tasks: 4 },
      { id: CHAT_B, title: "Second", tasks: 3 },
    ];
    expect(project(membership.values())).toEqual(expected);
    expect(canonicalLiveSessionId(CHAT_A)).toBe(CHAT_A);
    expect(canonicalLiveSessionId(CHAT_B)).toBe(CHAT_B);
    // PR #197 server contract: stored rows use chat IDs; switching A to Y
    // releases its old X ownership rather than retaining a historical alias.
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_B);
    expect(liveDurableOwner(DURABLE_Y)).toBe(CHAT_A);

    // Replaying REST must leave both rows intact as well.
    membership.poll([
      restRow(CHAT_A, "First", 1006, 4),
      restRow(CHAT_B, "Second", 1004, 3),
    ], 5);
    expect(project(membership.values())).toEqual(expected);
    expect(canonicalLiveSessionId(CHAT_A)).toBe(CHAT_A);
    expect(canonicalLiveSessionId(CHAT_B)).toBe(CHAT_B);
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_B);
    expect(liveDurableOwner(DURABLE_Y)).toBe(CHAT_A);
  });

  it("returns durable ownership to the original chat without retaining the intermediate chat", () => {
    // A:X, transfer A->B, then transfer B->A.
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_A, DURABLE_X, 1000, 1), 1);
    membership.push(frame(CHAT_B, DURABLE_X, 1002, 3, { replacesSessionId: CHAT_A }), 2);
    membership.push(frame(CHAT_A, DURABLE_X, 1004, 4, { replacesSessionId: CHAT_B }), 3);

    const expected = [{ id: CHAT_A, title: "First", tasks: 4 }];
    expect(project(membership.values())).toEqual(expected);
    expect(canonicalLiveSessionId(CHAT_A)).toBe(CHAT_A);
    expect(canonicalLiveSessionId(CHAT_B)).toBe(CHAT_B);
    // PR #197 server contract: replacesSessionId names the current owner of
    // the SAME durable; a replaced chat ID does not become a durable alias.
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_A);

    membership.poll([restRow(CHAT_A, "First", 1004, 4)], 4);
    expect(project(membership.values())).toEqual(expected);
  });

  it("lets a chat's row follow its cursor back to an unchanged cached durable", () => {
    // A:X(t1), A:Y(t2), A:Y(t3), then the cursor returns to unchanged X
    // with a newer exposed row revision and its original one-task content.
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_A, DURABLE_X, 1000, 1), 1);
    membership.push(frame(CHAT_A, DURABLE_Y, 1002, 2), 2);
    membership.push(frame(CHAT_A, DURABLE_Y, 1004, 3), 3);
    membership.push(frame(CHAT_A, DURABLE_X, 1006, 1), 4);

    const expected = [{ id: CHAT_A, title: "First", tasks: 1 }];
    expect(project(membership.values())).toEqual(expected);
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_A);
    expect(liveDurableOwner(DURABLE_Y)).toBeUndefined();

    membership.poll([restRow(CHAT_A, "First", 1006, 1)], 5);
    expect(project(membership.values())).toEqual(expected);
  });

  it("lets an authoritative chat id reclaim its identity from a provisional remap", () => {
    const membership = new LiveSessionMembership();
    membership.push(frame("old-row", "old-row", 1000, 1, { title: "Old" }), 1);
    // PR #197 server contract: replacesSessionId only names a provisional of
    // the SAME durable, not an unrelated old-row for durable-1.
    membership.push(frame("chat-1", "old-row", 1002, 2, { title: "New", replacesSessionId: "old-row" }), 2);
    expect(project(membership.values())).toEqual([{ id: "chat-1", title: "New", tasks: 2 }]);
    expect(canonicalLiveSessionId("old-row")).toBe("chat-1");
    expect(liveDurableOwner("old-row")).toBe("chat-1");

    // A later authoritative frame for the replaced id reclaims it: the row
    // lives under its own id again instead of folding into the replacer.
    membership.push(frame("old-row", "old-row", 1004, 5, { title: "Old" }), 3);
    expect(canonicalLiveSessionId("old-row")).toBe("old-row");
    expect(liveDurableOwner("old-row")).toBe("old-row");
    expect(project(membership.values())).toEqual([
      { id: "chat-1", title: "New", tasks: 2 },
      { id: "old-row", title: "Old", tasks: 5 },
    ]);
  });

  it("expires a claimed provisional alias on a bare durable rebind", () => {
    // PR #197 server contract: durable-keyed rows exist only while unowned,
    // and a bare rebind expires X's observed alias instead of transferring it.
    const membership = new LiveSessionMembership();
    membership.push(frame("durable", "durable", 1000, 0, { title: "Provisional" }), 1);
    membership.push(frame("route", "durable", 1002, 1, { title: "Route", replacesSessionId: "durable" }), 2);
    expect(canonicalLiveSessionId("durable")).toBe("route");
    membership.push(frame("new-route", "durable", 1004, 2, { title: "New route" }), 3);
    // PR #197 server contract: bare B:X expires the observed X alias without
    // transferring it; both raw chat rows survive as independent identities.
    expect(canonicalLiveSessionId("durable")).toBe("durable");
    expect(liveDurableOwner("durable")).toBe("new-route");
    membership.push(frame("durable", "durable", 1006, 3, { title: "New route" }), 4);

    expect(canonicalLiveSessionId("durable")).toBe("durable");
    expect(liveDurableOwner("durable")).toBe("durable");
    expect(project(membership.values())).toEqual([
      { id: "durable", title: "New route", tasks: 3 },
      { id: "new-route", title: "New route", tasks: 2 },
      { id: "route", title: "Route", tasks: 1 },
    ]);
  });
});

describe("established remap behaviour through the real stores", () => {
  it("migrates a provisional durable row into the replacing chat on replacesSessionId", () => {
    const membership = new LiveSessionMembership();
    membership.push(frame("durable-child", "durable-child", 1000, 1, { title: "Child" }), 1);
    membership.push(frame("attached-chat", "durable-child", 1002, 2,
      { title: "Attached", replacesSessionId: "durable-child" }), 2);

    expect(project(membership.values())).toEqual([{ id: "attached-chat", title: "Attached", tasks: 2 }]);
    expect(canonicalLiveSessionId("durable-child")).toBe("attached-chat");
    expect(liveDurableOwner("durable-child")).toBe("attached-chat");
  });

  let container: HTMLDivElement;
  let root: Root;
  let captured: ReadonlyMap<string, LiveBadgeOverride>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    captured = new Map();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Host(): null {
    captured = useLiveBadgeOverrides();
    return null;
  }

  it("does not fold a parent_session_id from a rich REST row", () => {
    const requestSequence = nextLiveActivitySequence();
    act(() => {
      root.render(<Host />);
      ingestExtensionEvent("durable-child", "omo.task.updated", {
        tasks: [{ task_id: "t1", name: "Alias", status: "running", updated_at: "2026-08-19T10:00:00.000Z" }],
      }, undefined, 1);
    });
    act(() => {
      settleLiveBadgePoll([{
        id: "attached-chat",
        task: { parent_session_id: "durable-child", tasks: [] },
      }], requestSequence);
    });

    expect(captured.get("durable-child")?.summary.runningCount).toBe(1);
    expect(canonicalLiveSessionId("durable-child")).toBe("durable-child");
  });
});

/** Review counter-scenarios replayed through membership and badge stores.
 * PR #197 server contract: stored rows use chat IDs; durable-keyed rows
 * exist only while unowned; ownership and observed aliases are distinct. */
describe("durable ownership map counter-scenarios (review REQUIRED)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: ReadonlyMap<string, LiveBadgeOverride>;
  let merged: readonly LiveSessionSummary[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    captured = new Map();
    merged = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Host(): null {
    captured = useLiveBadgeOverrides();
    merged = useMergedLiveSummaries([
      summarizeLiveSession({
        id: CHAT_A, title: "First", task: null, dag: null, taskOversized: false, dagOversized: false,
      }),
    ]);
    return null;
  }

  // Finding 1: PR #197 server contract: a bare X:X publication after C owns
  // X is an independent raw-frame row; it does not fold into C's chat row.
  it("rebinds a bare durable publication without merging former owners", () => {
    const membership = new LiveSessionMembership();
    act(() => root.render(<Host />));
    act(() => {
      membership.push(frame(CHAT_A, DURABLE_X, 1000, 1), 1);
      membership.push(frame(CHAT_A, DURABLE_Y, 1002, 2), 2);
      membership.push(frame(CHAT_B, DURABLE_X, 1004, 3), 3);
      membership.push(frame(CHAT_B, DURABLE_Z, 1006, 4), 4);
      membership.push(frame(CHAT_C, DURABLE_X, 1008, 5, { title: "Third" }), 5);
      membership.push(frame(DURABLE_X, DURABLE_X, 1010, 9, { title: "Durable work" }), 6);
    });

    expect(canonicalLiveSessionId(DURABLE_X)).toBe(DURABLE_X);
    expect(liveDurableOwner(DURABLE_X)).toBe(DURABLE_X);
    expect(liveDurableOwner(DURABLE_Y)).toBe(CHAT_A);
    expect(liveDurableOwner(DURABLE_Z)).toBe(CHAT_B);
    expect(project(membership.values())).toEqual([
      { id: CHAT_A, title: "First", tasks: 2 },
      { id: CHAT_B, title: "Second", tasks: 4 },
      { id: CHAT_C, title: "Third", tasks: 5 },
      { id: DURABLE_X, title: "Durable work", tasks: 9 },
    ]);
  });

  // Finding 2: A:X@100 -> B:X@110 replaces A -> A:Y@120, then replay the old
  // B frame. The replayed replacement is ownership-incompatible and must be
  // rejected before any row, alias or override mutation.
  it("rejects a replayed replacesSessionId frame before mutating membership", () => {
    const membership = new LiveSessionMembership();
    act(() => root.render(<Host />));
    act(() => {
      membership.push(frame(CHAT_A, DURABLE_X, 1000, 1), 1);
      membership.push(frame(CHAT_B, DURABLE_X, 1100, 3, { replacesSessionId: CHAT_A }), 2);
      membership.push(frame(CHAT_A, DURABLE_Y, 1200, 4), 3);
      // Replay of the seq-2 B frame: A no longer owns X, so nothing moves.
      membership.push(frame(CHAT_B, DURABLE_X, 1100, 3, { replacesSessionId: CHAT_A }), 4);
    });

    // PR #197 server contract: the old A chat row remains independent after
    // its SAME-durable owner replacement, while A's new Y releases old X.
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_B);
    expect(liveDurableOwner(DURABLE_Y)).toBe(CHAT_A);
    expect(canonicalLiveSessionId(CHAT_A)).toBe(CHAT_A);
    // Independent A survives; B keeps its own title/count instead of
    // inheriting A's.
    expect(project(membership.values())).toEqual([
      { id: CHAT_A, title: "First", tasks: 4 },
      { id: CHAT_B, title: "Second", tasks: 3 },
    ]);
  });

  // Finding 3: A:X@100 -> A:Y@200 -> poll starts -> A returns to X@300 with
  // overflow. The poll response carries the previous durable's payload and
  // must not restore its count; a fresh X response afterwards applies cleanly.
  it("fences a REST poll that started before a durable cursor change", () => {
    const membership = new LiveSessionMembership();
    act(() => root.render(<Host />));
    const push = (dur: string, at: number, tasks: number, overflow = false): void => {
      act(() => {
        membership.push(frame(CHAT_A, dur, at, tasks, { overflow }), nextLiveActivitySequence());
      });
    };
    push(DURABLE_X, 1000, 1);
    push(DURABLE_Y, 2000, 2);
    const requestSequence = nextLiveActivitySequence();
    // The cursor returns to unchanged X content with a newer row revision.
    push(DURABLE_X, 3000, 1, true);
    expect(project(membership.values())).toEqual([{ id: CHAT_A, title: "First", tasks: 1 }]);

    // Pending Y-era response: two running tasks. Fenced: no rows, no counts.
    act(() => {
      membership.poll([{
        ...restRow(CHAT_A, "First", 2000, 2),
        task: rowsTaskFrame("y", 2, "2026-08-19T10:02:00.000Z"),
      }], requestSequence);
    });
    expect(merged[0]?.runningCount).toBe(0);

    // A fresh X-era response repairs immediately.
    const freshSequence = nextLiveActivitySequence();
    act(() => {
      membership.poll([{
        ...restRow(CHAT_A, "First", 3001, 1),
        task: rowsTaskFrame("x", 1, "2026-08-19T10:04:00.000Z"),
      }], freshSequence);
    });
    expect(merged[0]?.runningCount).toBe(1);
  });

  // Finding 4: a durable's provisional badge data (ingested under the durable
  // id itself) migrates to the first chat that publishes it without
  // replacesSessionId; the hook then reports the chat, not the durable.
  it("migrates provisional durable-keyed badge data to the first owning chat", () => {
    const membership = new LiveSessionMembership();
    act(() => root.render(<Host />));
    act(() => {
      ingestExtensionEvent(DURABLE_X, "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 },
        undefined, 1);
    });
    expect(captured.get(DURABLE_X)?.summary.runningCount).toBe(9);

    act(() => {
      membership.push(frame(CHAT_A, DURABLE_X, 1000, 1), nextLiveActivitySequence());
    });

    // PR #197 server contract: the observed attached badge authority at X is
    // a provisional source; its first claim migrates the badge and alias.
    expect(canonicalLiveSessionId(DURABLE_X)).toBe(CHAT_A);
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_A);
    expect(captured.has(DURABLE_X)).toBe(false);
    expect(captured.get(CHAT_A)?.summary.runningCount).toBe(9);
  });

  function rowsTaskFrame(prefix: string, count: number, at: string): Record<string, unknown> {
    return {
      truncated_tasks: false,
      tasks: Array.from({ length: count }, (_, index) => ({
        task_id: `${prefix}-${index}`,
        name: `Task ${prefix}-${index}`,
        status: "running",
        updated_at: at,
      })),
    };
  }
});

describe("review r2 admission regressions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let aggregates: ReadonlyMap<string, { readonly running: number }>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    aggregates = new Map();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    __resetLiveBadgeStoreForTests();
  });

  function Host(): null {
    aggregates = useLiveAgentAggregates();
    return null;
  }

  it.each([false, true])("rejects stale B:X@90 replacing A after B:X@120 (overflow=%s)", (overflow) => {
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_B, DURABLE_X, 120, 2), 1);
    membership.push(frame(CHAT_A, DURABLE_X, 130, 1, { replacesSessionId: CHAT_B }), 2);
    membership.push(frame(CHAT_B, DURABLE_X, 90, 2, { replacesSessionId: CHAT_A, overflow }), 3);

    expect(project(membership.values())).toEqual([{ id: CHAT_A, title: "First", tasks: 1 }]);
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_A);
  });

  it.each([false, true])("keeps C owning X after stale A:X@90 (overflow=%s)", (overflow) => {
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_A, DURABLE_X, 100, 1), 1);
    membership.push(frame(CHAT_B, DURABLE_X, 200, 2, { replacesSessionId: CHAT_A }), 2);
    membership.push(frame(CHAT_C, DURABLE_X, 300, 3, { replacesSessionId: CHAT_B, title: "Third" }), 3);
    membership.push(frame(CHAT_A, DURABLE_X, 90, 4, { overflow }), 4);
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_C);
    // PR #197 server contract: a claimed durable-keyed publication is not
    // folded into C; update C by its stored chat ID instead.
    membership.push(frame(CHAT_C, DURABLE_X, 400, 5, { title: "Latest" }), 5);
    expect(project(membership.values())).toEqual([{ id: CHAT_C, title: "Latest", tasks: 5 }]);
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_C);
  });

  it("accepts newer B:X@210 replacing A despite locally observed A:Y", () => {
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_A, DURABLE_X, 100, 1), 1);
    membership.push(frame(CHAT_A, DURABLE_Y, 200, 2), 2);
    membership.push(frame(CHAT_B, DURABLE_X, 210, 3, { replacesSessionId: CHAT_A }), 3);

    expect(project(membership.values())).toEqual([{ id: CHAT_B, title: "Second", tasks: 3 }]);
    // The server's later validated remap supersedes the stale local Y view.
    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_B);
    expect(liveDurableOwner(DURABLE_Y)).toBeUndefined();
  });

  it.each([false, true])("rejects an in-flight Y REST row after A returns to X (overflow=%s)", (overflow) => {
    const membership = new LiveSessionMembership();
    membership.push(frame(CHAT_A, DURABLE_X, 100, 1), 1);
    membership.push(frame(CHAT_A, DURABLE_Y, 200, 2), 2);
    const requestSequence = 3;
    membership.push(frame(CHAT_A, DURABLE_X, 300, 1, { overflow }), 4);
    membership.poll([restRow(CHAT_A, "First", 200, 2)], requestSequence);
    expect(project(membership.values())).toEqual([{ id: CHAT_A, title: "First", tasks: 1 }]);
    membership.poll([restRow(CHAT_A, "First", 301, 1)], 5);
    expect(project(membership.values())).toEqual([{ id: CHAT_A, title: "First", tasks: 1 }]);
  });

  it("rejects an old REST parent remap without transferring B's task authority", () => {
    const membership = new LiveSessionMembership();
    act(() => root.render(<Host />));
    membership.push(frame(CHAT_A, DURABLE_X, 100, 1), 1);
    membership.push(frame(CHAT_A, DURABLE_Y, 200, 2), 2);
    const requestSequence = 3;
    membership.push(frame(CHAT_B, DURABLE_X, 300, 3), 4);
    membership.push(frame(CHAT_A, DURABLE_Z, 400, 4), 5);
    act(() => {
      ingestExtensionEvent(CHAT_B, "omo.dag.updated", { agent_running_count: 9, agent_total_count: 9 },
        undefined, 301);
      membership.poll([{
        ...restRow(CHAT_A, "First", 200, 2),
        task: { parent_session_id: DURABLE_X, tasks: [] },
      }], requestSequence);
    });

    expect(liveDurableOwner(DURABLE_X)).toBe(CHAT_B);
    expect(liveDurableOwner(DURABLE_Y)).toBeUndefined();
    expect(liveDurableOwner(DURABLE_Z)).toBe(CHAT_A);
    expect(aggregates.get(CHAT_B)?.running).toBe(9);
    expect(aggregates.get(CHAT_A)?.running).not.toBe(9);
  });
});
