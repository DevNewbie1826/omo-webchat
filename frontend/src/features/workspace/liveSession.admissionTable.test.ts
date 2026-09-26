import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionsActivityFrame } from "../../lib/contract/types_gen";
import { __resetLiveBadgeStoreForTests, ingestExtensionEvent, useLiveAgentAggregates } from "./liveBadgeStore";
import { __liveIdentitySnapshotForTests } from "./liveSessionIdentity";
import { LiveSessionMembership } from "./liveSessionMembership";
import { parseLiveSummarySessions } from "./useLiveSessionsLean";

type Publication = readonly [id: string, durable: string, receipt: number, replaces?: string];
const identity = (durable: string, receipt: number, generation = -1, removed = false) =>
  ({ durable, receipt, generation, removed });
const row = (id: string, durableSessionId: string, receipt: number) => ({
  id, durableSessionId, title: id, active: false,
  last_activity_ms: receipt, running: { tasks: receipt },
});
const frame = ([sessionId, durableSessionId, last_activity_ms, replacesSessionId]: Publication,
  overflow: boolean): SessionsActivityFrame => ({
  type: "sessions.activity", sessionId, durableSessionId, last_activity_ms, overflow,
  title: sessionId, active: false, running: { tasks: last_activity_ms },
  ...(replacesSessionId === undefined ? {} : { replacesSessionId }),
});
interface Case {
  readonly name: string;
  readonly history: readonly Publication[];
  readonly authority: string;
  readonly push?: Publication;
  readonly poll?: { readonly sequence: number; readonly rows: readonly unknown[] };
  readonly expectedRows: Readonly<Record<string, number>>;
  readonly state: ReturnType<typeof __liveIdentitySnapshotForTests>;
  readonly counts: Readonly<Record<string, number>>;
}

// Server revisions share one manager-wide clock across REST and WS rows.
// Each versioned publication must exceed the watermark of every touched ID;
// a request's start sequence does not order versioned rows. Replaced and
// retired rows keep their watermarks, and the highest revision owns a durable.
// Owned durable-keyed REST rows and cross-durable replacements remain invalid.
const cases: readonly Case[] = [
  {
    name: "self replacement keeps its own authority", history: [["A", "X", 100]], authority: "A",
    push: ["A", "X", 200, "A"], expectedRows: { A: 200 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 200) }, owners: { X: "A" }, aliases: {}, generations: { A: -1, X: -1 } },
  },
  {
    name: "self replacement cannot authorize a different durable", history: [["A", "X", 100]], authority: "A",
    push: ["A", "Y", 200, "A"], expectedRows: { A: 100 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 100) }, owners: { X: "A" }, aliases: {}, generations: { A: -1, X: -1 } },
  },
  {
    name: "older same-row receipt has zero effects", history: [["A", "X", 100]], authority: "A",
    push: ["A", "X", 90], expectedRows: { A: 100 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 100) }, owners: { X: "A" }, aliases: {}, generations: { A: -1, X: -1 } },
  },
  {
    name: "newer same-row receipt commits only its row", history: [["A", "X", 100]], authority: "A",
    push: ["A", "X", 200], expectedRows: { A: 200 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 200) }, owners: { X: "A" }, aliases: {}, generations: { A: -1, X: -1 } },
  },
  {
    name: "older different durable cannot roll row or badge generation back", history: [["A", "X", 500]], authority: "A",
    push: ["A", "Y", 100], expectedRows: { A: 500 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 500) }, owners: { X: "A" }, aliases: {}, generations: { A: -1, X: -1 } },
  },
  {
    name: "newer different durable changes row and badge generation", history: [["A", "X", 500]], authority: "A",
    push: ["A", "Y", 600], expectedRows: { A: 600 }, counts: {},
    state: { rows: { A: identity("Y", 600, 30) }, owners: { Y: "A" }, aliases: {}, generations: { A: 30, X: -1, Y: 30 } },
  },
  {
    name: "unobserved first claim fences destination source and durable", history: [], authority: "X",
    push: ["A", "X", 200, "X"], expectedRows: { A: 200 }, counts: { A: 9 },
    state: { rows: { X: { generation: 30, removed: true }, A: identity("X", 200, 30) },
      owners: { X: "A" }, aliases: { X: "A" }, generations: { A: 30, X: 30 } },
  },
  {
    name: "newer provisional claim migrates authority", history: [["X", "X", 100]], authority: "X",
    push: ["A", "X", 101, "X"], expectedRows: { A: 101 }, counts: { A: 9 },
    state: { rows: { X: identity("X", 100, 30, true), A: identity("X", 101, 30) },
      owners: { X: "A" }, aliases: { X: "A" }, generations: { A: 30, X: 30 } },
  },
  {
    name: "tied provisional claim cannot supersede its source", history: [["X", "X", 100]], authority: "X",
    push: ["A", "X", 100, "X"], expectedRows: { X: 100 }, counts: { X: 9 },
    state: { rows: { X: identity("X", 100) },
      owners: { X: "X" }, aliases: {}, generations: { X: -1 } },
  },
  {
    name: "current-chat replacement never aliases the chat ID", history: [["P", "X", 100]], authority: "P",
    push: ["A", "X", 200, "P"], expectedRows: { A: 200 }, counts: { A: 9 },
    state: { rows: { P: identity("X", 100, 30, true), A: identity("X", 200, 30) },
      owners: { X: "A" }, aliases: {}, generations: { P: 30, A: 30, X: 30 } },
  },
  {
    name: "cross-durable replacement has zero effects", history: [["P", "P", 500]], authority: "P",
    push: ["A", "X", 200, "P"], expectedRows: { P: 500 }, counts: { P: 9 },
    state: { rows: { P: identity("P", 500) }, owners: { P: "P" }, aliases: {}, generations: { P: -1 } },
  },
  {
    name: "replacement must exceed its source revision", history: [["P", "X", 500]], authority: "P",
    push: ["A", "X", 200, "P"], expectedRows: { P: 500 }, counts: { P: 9 },
    state: { rows: { P: identity("X", 500) },
      owners: { X: "P" }, aliases: {}, generations: { P: -1, X: -1 } },
  },
  {
    name: "newer replacement supersedes its source revision", history: [["P", "X", 500]], authority: "P",
    push: ["A", "X", 600, "P"], expectedRows: { A: 600 }, counts: { A: 9 },
    state: { rows: { P: identity("X", 500, 30, true), A: identity("X", 600, 30) },
      owners: { X: "A" }, aliases: {}, generations: { P: 30, A: 30, X: 30 } },
  },
  {
    name: "bare rebind expires the provisional alias only", history: [["X", "X", 100], ["A", "X", 200, "X"]], authority: "A",
    push: ["B", "X", 300], expectedRows: { A: 200, B: 300 }, counts: { A: 9 },
    state: { rows: { X: identity("X", 100, 20, true), A: identity("X", 200, 20), B: identity("X", 300, 30) },
      owners: { X: "B" }, aliases: {}, generations: { X: 30, A: 20, B: 30 } },
  },
  {
    name: "pending REST settles newer destination but not claimed source", history: [["A", "X", 200, "X"]], authority: "A",
    poll: { sequence: 5, rows: [row("A", "X", 500), row("X", "X", 150)] }, expectedRows: { A: 500 }, counts: { A: 9 },
    state: { rows: { X: { generation: 10, removed: true }, A: identity("X", 500, 10) },
      owners: { X: "A" }, aliases: { X: "A" }, generations: { A: 10, X: 10 } },
  },
  {
    name: "pending REST cannot resurrect older replaced chat", history: [["P", "X", 100], ["A", "X", 200, "P"]], authority: "A",
    poll: { sequence: 15, rows: [row("P", "X", 150), row("A", "X", 200)] }, expectedRows: { A: 200 }, counts: { A: 9 },
    state: { rows: { P: identity("X", 100, 20, true), A: identity("X", 200, 20) },
      owners: { X: "A" }, aliases: {}, generations: { P: 20, A: 20, X: 20 } },
  },
  {
    name: "historical durable REST stays an independent row", history: [["A", "X", 100], ["A", "Y", 200]], authority: "A",
    poll: { sequence: 40, rows: [row("A", "Y", 200), row("X", "X", 500)] }, expectedRows: { A: 200, X: 500 }, counts: { A: 9 },
    state: { rows: { A: identity("Y", 200, 20), X: identity("X", 500) },
      owners: { Y: "A", X: "X" }, aliases: {}, generations: { A: 20, X: -1, Y: 20 } },
  },
  {
    name: "current chat REST commits freshness but owned durable row cannot", history: [["A", "X", 100]], authority: "A",
    poll: { sequence: 40, rows: [row("A", "X", 300), { ...row("X", "X", 500), dag: { agent_running_count: 7 } }] },
    expectedRows: { A: 300 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 300) }, owners: { X: "A" }, aliases: {}, generations: { A: -1, X: -1 } },
  },
  {
    name: "unowned durable REST commits its own freshness", history: [["X", "X", 100]], authority: "X",
    poll: { sequence: 40, rows: [row("X", "X", 300)] }, expectedRows: { X: 300 }, counts: { X: 9 },
    state: { rows: { X: identity("X", 300) }, owners: { X: "X" }, aliases: {}, generations: { X: -1 } },
  },
  {
    name: "current REST generation accepts a newer different durable revision", history: [["A", "X", 500]], authority: "A",
    poll: { sequence: 40, rows: [row("A", "Y", 600)] }, expectedRows: { A: 600 }, counts: {},
    state: { rows: { A: identity("Y", 600, 40) }, owners: { Y: "A" }, aliases: {}, generations: { A: 40, X: -1, Y: 40 } },
  },
  {
    name: "newer REST revision switches the durable despite older request", history: [["A", "X", 100], ["A", "Y", 200]], authority: "A",
    poll: { sequence: 15, rows: [{ ...row("A", "Z", 900), dag: { agent_running_count: 7 } }] },
    expectedRows: { A: 900 }, counts: {},
    state: { rows: { A: identity("Z", 900, 15) }, owners: { Z: "A" }, aliases: {}, generations: { A: 15, X: -1, Y: 20, Z: 15 } },
  },
  {
    name: "independent chat receipt cannot rewrite the former owner's receipt", history: [["A", "X", 500]], authority: "A",
    push: ["B", "X", 100], expectedRows: { A: 500, B: 100 }, counts: { A: 9 },
    state: { rows: { A: identity("X", 500), B: identity("X", 100, 30) },
      owners: { X: "A" }, aliases: {}, generations: { A: -1, X: 30, B: 30 } },
  },
  {
    name: "fresh REST can rediscover a released provisional ID", history: [["X", "X", 100], ["A", "X", 200, "X"], ["A", "Y", 300]], authority: "A",
    poll: { sequence: 40, rows: [row("A", "Y", 300), row("X", "X", 400)] },
    expectedRows: { A: 300, X: 400 }, counts: { A: 9 },
    state: { rows: { X: identity("X", 400, 20), A: identity("Y", 300, 30) },
      owners: { Y: "A", X: "X" }, aliases: {}, generations: { X: 20, A: 30, Y: 30 } },
  },
];

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let counts: ReadonlyMap<string, { readonly running: number }>;
function Host(): null { counts = useLiveAgentAggregates(); return null; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetLiveBadgeStoreForTests();
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(createElement(Host)));
});
afterEach(() => {
  act(() => root.unmount());
  __resetLiveBadgeStoreForTests();
  vi.unstubAllGlobals();
});

it.each(cases.flatMap((test) => [false, true].map((overflow) => ({ ...test, overflow }))))(
  "$name (overflow=$overflow)", (test) => {
    // Given real production membership and mounted badge authority.
    const membership = new LiveSessionMembership();
    act(() => {
      test.history.forEach((entry, index) => membership.push(frame(entry, test.overflow), (index + 1) * 10));
      ingestExtensionEvent(test.authority, "omo.dag.updated", { agent_running_count: 9 },
        undefined, Math.max(0, ...test.history.map(([, , receipt]) => receipt)) + 1);
    });
    // When a frame or a completed REST request enters the production reducer.
    act(() => {
      if (test.push !== undefined) membership.push(frame(test.push, test.overflow), 30);
      if (test.poll !== undefined) membership.poll(
        parseLiveSummarySessions({ sessions: test.poll.rows }), test.poll.sequence,
      );
    });
    // Then every identity effect is checked, not just admission or row count.
    expect(Object.fromEntries(membership.values().map((value) => [value.id, value.lean?.running?.tasks])))
      .toEqual(test.expectedRows);
    expect(__liveIdentitySnapshotForTests()).toEqual(test.state);
    expect(Object.fromEntries([...counts].map(([id, value]) => [id, value.running]))).toEqual(test.counts);
  },
);
