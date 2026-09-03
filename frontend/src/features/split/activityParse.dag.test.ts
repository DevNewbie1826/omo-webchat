import { describe, expect, it } from "vitest";
import { parseDagActivity, parseDagHeartbeat, parseDagUpdated } from "./activityParse";

describe("parseDagUpdated", () => {
  it("parses nodes, edges, waves, and counts from a snapshot run", () => {
    const parsed = parseDagUpdated({
      parent_session_id: "sess-1",
      truncated_runs: true,
      runs: [
        {
          run_id: "r1",
          run_key: "plan",
          name: "Ship",
          status: "running",
          created_at: "2026-08-19T10:00:00.000Z",
          updated_at: "2026-08-19T10:02:00.000Z",
          counts: { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
          nodes: [
            {
              id: "n1",
              label: "One",
              prompt: "do one",
              depends_on: [],
              state: "completed",
              attempt: 1,
              task_id: "t1",
              started_at: "2026-08-19T10:00:00.000Z",
              completed_at: "2026-08-19T10:01:00.000Z",
            },
            { id: "n2", prompt: "do two", depends_on: ["n1"], state: "running" },
          ],
          edges: [{ from: "n1", to: "n2" }],
          waves: [{ index: 0, node_ids: ["n1"] }, { index: 1, node_ids: ["n2"] }],
        },
      ],
    });

    expect(parsed?.parentSessionId).toBe("sess-1");
    expect(parsed?.truncatedRuns).toBe(true);
    expect(parsed?.runs).toHaveLength(1);
    const run = parsed?.runs[0];
    expect(run?.runId).toBe("r1");
    expect(run?.runKey).toBe("plan");
    expect(run?.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
    expect(run?.nodes[1]).toEqual({
      id: "n2",
      prompt: "do two",
      dependsOn: ["n1"],
      state: "running",
    });
    expect(run?.edges).toEqual([{ from: "n1", to: "n2" }]);
    expect(run?.waves).toEqual([
      { index: 0, nodeIds: ["n1"] },
      { index: 1, nodeIds: ["n2"] },
    ]);
    expect(run?.counts.running).toBe(1);
  });

  it("drops malformed runs, nodes, edges, and waves", () => {
    const parsed = parseDagUpdated({
      runs: [
        { run_key: "x", name: "No id", status: "pending", nodes: [], edges: [], waves: [] },
        {
          run_id: "r1",
          run_key: "ok",
          name: "Ok",
          status: "pending",
          nodes: [{ prompt: "missing id", depends_on: [], state: "pending" }, { id: "n1", prompt: "ok", depends_on: [], state: "pending" }],
          edges: [{ from: "n1" }, { from: "n1", to: "n2" }],
          waves: [{ node_ids: ["n1"] }, { index: 0, node_ids: ["n1"] }],
        },
      ],
    });
    expect(parsed?.runs.map((run) => run.runId)).toEqual(["r1"]);
    expect(parsed?.runs[0]?.nodes.map((node) => node.id)).toEqual(["n1"]);
    expect(parsed?.runs[0]?.edges).toEqual([{ from: "n1", to: "n2" }]);
    expect(parsed?.runs[0]?.waves).toEqual([{ index: 0, nodeIds: ["n1"] }]);
  });

  it("returns null and never throws on garbage", () => {
    for (const data of [undefined, null, { runs: 1 }]) {
      expect(parseDagUpdated(data)).toBeNull();
    }
  });
});

describe("parseDagActivity", () => {
  it("parses camelCase per-node live progress", () => {
    expect(
      parseDagActivity({
        schemaVersion: 1,
        runId: "r1",
        nodeId: "n2",
        taskId: "t9",
        at: "2026-08-19T10:05:00.000Z",
        activity: "tool",
        currentTool: "bash",
        lastAssistantLine: "done",
        turns: 4,
        toolCalls: 2,
      }),
    ).toEqual({
      schemaVersion: 1,
      runId: "r1",
      nodeId: "n2",
      taskId: "t9",
      at: "2026-08-19T10:05:00.000Z",
      activity: "tool",
      currentTool: "bash",
      lastAssistantLine: "done",
      turns: 4,
      toolCalls: 2,
    });
  });

  it("normalizes a valid offset-bearing RFC3339 timestamp", () => {
    expect(parseDagActivity({
      runId: "r1",
      nodeId: "n1",
      at: "2026-08-19T10:05:00.123+02:30",
    })?.at).toBe("2026-08-19T07:35:00.123Z");
  });

  it.each([
    ["timezone-less", "2026-08-19T10:05:00.000"],
    ["malformed", "2026-08-19 10:05:00.000Z"],
    ["invalid calendar date", "2026-02-30T10:05:00.000Z"],
  ])("rejects a %s timestamp", (_case, at) => {
    expect(parseDagActivity({ runId: "r1", nodeId: "n1", at })).toBeNull();
  });

  it("returns null when required camelCase ids or at are missing", () => {
    expect(parseDagActivity({ nodeId: "n1", at: "2026-08-19T10:00:00.000Z" })).toBeNull();
    expect(parseDagActivity({ runId: "r1", at: "2026-08-19T10:00:00.000Z" })).toBeNull();
    expect(parseDagActivity({ runId: "r1", nodeId: "n1" })).toBeNull();
  });
});

describe("parseDagHeartbeat", () => {
  it("parses heartbeat at and per-run headSeq", () => {
    expect(
      parseDagHeartbeat({
        schemaVersion: "1",
        at: "2026-08-19T10:06:00.000Z",
        runs: [{ runId: "r1", headSeq: 7 }, { runId: "r2", headSeq: 1 }],
      }),
    ).toEqual({
      schemaVersion: "1",
      at: "2026-08-19T10:06:00.000Z",
      runs: [
        { runId: "r1", headSeq: 7 },
        { runId: "r2", headSeq: 1 },
      ],
    });
  });

  it("drops malformed run rows and rejects a missing at", () => {
    expect(
      parseDagHeartbeat({
        at: "2026-08-19T10:06:00.000Z",
        runs: [{ runId: "r1", headSeq: 1 }, { runId: "r2" }, { headSeq: 3 }],
      })?.runs,
    ).toEqual([{ runId: "r1", headSeq: 1 }]);
    expect(parseDagHeartbeat({ runs: [] })).toBeNull();
  });
});
