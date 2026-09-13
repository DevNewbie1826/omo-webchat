import { describe, expect, it } from "vitest";
import { acceptLeanSession, parseLeanSessionFields } from "./useLiveSessionsLean";
import { summarizeLiveSession } from "./useLiveSessionSummaries";

const previous = {
  id: "s", title: "Current", task: null, dag: null, active: false,
  lean: { last_activity_ms: 200, running: { agents: 0, tasks: 0, dag: 0 },
    done: 8, dag_done: 4, dag_total: 4, truncated: { task: true, dag: true } },
};

describe("lean scalar boundary and revision authority", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null])("ignores malformed counts %s without inventing work", value => {
    // Given malformed wire scalars and no retained topology.
    const lean = parseLeanSessionFields({ running: { agents: value }, done: value, dag_total: value });
    // When the parsed row is summarized.
    const summary = summarizeLiveSession({ id: "s", title: "", task: null, dag: null,
      ...(lean === undefined ? {} : { lean }) });
    // Then unknown work does not become a fabricated positive count.
    expect(summary).toMatchObject({ runningCount: 0, doneCount: 0, dagTotal: 0 });
  });
  it.each([100, 199])("rejects a stale revision %s without resurrecting ended work", at => {
    // Given exact completed counts at revision 200.
    // When an older running revision is admitted.
    const accepted = acceptLeanSession(previous, { ...previous, active: true,
      lean: { last_activity_ms: at, running: { agents: 99 }, done: 0 } });
    // Then every field belongs to the newer accepted revision.
    expect(accepted).toBe(previous);
  });
  it("retains known scalar fields when a newer partial lean delivery omits them", () => {
    // Given a complete accepted lean revision.
    // When only a new DAG total and explicit truncation withdrawal arrive.
    const accepted = acceptLeanSession(previous, { ...previous,
      lean: { last_activity_ms: 201, dag_total: 5, truncated: { dag: false } } });
    // Then omissions do not degrade counts or erase independent qualification.
    expect(summarizeLiveSession(accepted)).toMatchObject({ runningCount: 0, doneCount: 8,
      dagDone: 4, dagTotal: 5, taskSideOversized: true, dagSideOversized: false });
  });
  it("leaves omitted lean counts unknown instead of reconstructing attached detail", () => {
    // Given a partial lean aggregate with legacy completion detail.
    const info = { id: "s", title: "", task: { tasks: [{ task_id: "t", name: "t", status: "completed" }] },
      dag: null, lean: { running: { agents: 5 }, dag_total: 9 } };
    // When the summary is built.
    const summary = summarizeLiveSession(info);
    // Then only server-provided scalars contribute positive counts.
    expect(summary).toMatchObject({ runningCount: 5, doneCount: 0, dagTotal: 9 });
  });
  it("does not fabricate an agent aggregate when only task and DAG counts are supplied", () => {
    // Given overlapping sides without a server-deduplicated agent count.
    const info = { id: "s", title: "", task: null, dag: null,
      lean: { running: { tasks: 5, dag: 4 } } };
    // When the lean row is summarized.
    const summary = summarizeLiveSession(info);
    // Then side counts are not summed into an invented aggregate.
    expect(summary).toMatchObject({ runningCount: 0, dagRunning: 4 });
  });
  it("preserves authoritative zero and empty last_line rather than reviving cached detail", () => {
    // Given stale legacy detail alongside exact zero and an explicit cleared line.
    const info = { ...previous, task: { tasks: [{ task_id: "t", name: "t", status: "running",
      live_progress: { last_assistant_line: "old" } }] }, lean: { ...previous.lean, last_line: "" } };
    // When the summary is built.
    const summary = summarizeLiveSession(info);
    // Then zero is not treated as missing and the line is cleared.
    expect(summary).toMatchObject({ runningCount: 0, lastLine: "", active: false });
  });
});
