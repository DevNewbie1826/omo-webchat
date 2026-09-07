import { describe, expect, it } from "vitest";
import compactOnly from "../../../test/fixtures/task-compact-boundary/compact-only.json?raw";
import mixed from "../../../test/fixtures/task-compact-boundary/mixed.json?raw";
import { parseChatServerFrame } from "../../lib/chatWsParse";
import { parseTaskUpdated } from "./activityParseTask";
import { applyActivityEvent, applyTaskHistorySnapshot, emptyActivityState } from "./activityState";
import { parseTaskDigest } from "../workspace/activityDigest";
import { summarizeLiveSession } from "../workspace/useLiveSessionSummaries";

interface Receipt {
  frames: unknown[];
  taskDigest: unknown;
  enrichmentFrames: unknown[];
  expectedTask: { task_id: string; status: string; raw_status: string; updated_at: string };
}
function consume(state: ReturnType<typeof emptyActivityState>, frames: readonly unknown[]) {
  for (const raw of frames) {
    const frame = parseChatServerFrame(raw);
    if (frame?.type !== "extensionEvent") throw new Error("Go task frame rejected at wire boundary");
    state = applyActivityEvent(state, frame.name, frame.data);
  }
  return state;
}

// Go's TestTaskStateOrderingCompactBoundary compares actual Session subscriber
// output against these same fixtures on every run; these are not rich mocks.
for (const [mode, source] of [["compact-only", compactOnly], ["mixed", mixed]] as const) {
  const receipt = JSON.parse(source) as Receipt;
  const { task_id: id, status, raw_status: rawStatus, updated_at: updatedAt } = receipt.expectedTask;
  describe(`actual Go ${mode} compact boundary`, () => {
    it("corrects the attached incumbent without replacing descriptors and agrees with the sidebar", () => {
      const before = consume(emptyActivityState(), receipt.frames.slice(0, -1));
      const incumbent = before.tasks.get(id)!;
      expect(incumbent.status).toBe("running");
      const state = consume(before, receipt.frames.slice(-1));
      expect(state.tasks.get(id)).toMatchObject({ name: incumbent.name, status, rawStatus, updatedAt });
      expect(state.truncatedTasks).toBe(true);
      if (mode === "mixed") expect(state.tasks.get("other")?.status).toBe("pending");
      const digest = parseTaskDigest(receipt.taskDigest);
      if (digest === null) throw new Error("Go digest rejected");
      const sidebar = summarizeLiveSession({ id: "review-chat", title: "Review", task: null, dag: null, taskDigest: digest },
        Date.parse("2026-09-07T10:03:00Z"), { sessionLive: true });
      expect(sidebar.doneCount).toBe(1);
      expect(sidebar.runningCount).toBe(0);
    });

    it("marks a cold compact correction incomplete and permits equal-version rich enrichment", () => {
      let state = consume(emptyActivityState(), receipt.frames.slice(-1));
      expect(state.tasks.get(id)).toMatchObject({ name: id, status, rawStatus, updatedAt, compact: true });
      state = consume(state, receipt.enrichmentFrames);
      expect(state.tasks.get(id)).toMatchObject({ name: "Refilled task", taskSummary: "Full description", status, rawStatus, updatedAt, compact: false });
      state = consume(state, receipt.frames);
      expect(state.tasks.get(id)).toMatchObject({ name: "Refilled task", status, rawStatus, updatedAt });
    });

    it("does not resurrect an omitted equal revision or overwrite a genuine newer revival", () => {
      let state = consume(emptyActivityState(), receipt.frames);
      state = applyTaskHistorySnapshot(state, { tasks: [] });
      state = consume(state, receipt.frames.slice(-1));
      expect(state.tasks.has(id)).toBe(false);
      const frame = parseChatServerFrame(receipt.frames[0]);
      if (frame?.type !== "extensionEvent") throw new Error("missing initial task frame");
      const initial = parseTaskUpdated(frame.data)!.tasks.find(task => task.taskId === id)!;
      state = applyActivityEvent(state, "omo.task.updated", { tasks: [{ task_id: id, name: initial.name,
        status: "running", updated_at: "2026-09-07T10:04:00Z" }], truncated_tasks: true });
      state = consume(state, receipt.frames.slice(-1));
      expect(state.tasks.get(id)).toMatchObject({ status: "running", updatedAt: "2026-09-07T10:04:00Z" });
      expect(state.tasks.get(id)?.rawStatus).toBeUndefined();
    });

    it("preserves both other activity domains", () => {
      const base = emptyActivityState();
      const todo = [{ name: "Existing", tasks: [{ content: "Keep", status: "pending" as const }] }];
      const state = consume({ ...base, todo }, receipt.frames);
      expect(state.todo).toBe(todo);
      expect(state.dags).toBe(base.dags);
      expect(state.heartbeats).toBe(base.heartbeats);
    });
  });
}

describe("compact correction validation", () => {
  const compact = { task_id: "t", status: "completed", raw_status: "running", updated_at: "2026-09-07T10:02:00Z" };
  it("accepts only the partial, provenance-bearing compact shape without a name", () => {
    expect(parseTaskUpdated({ tasks: [compact], truncated_tasks: true })?.tasks[0]).toMatchObject({ compact: true, name: "t", rawStatus: "running" });
  });
  it.each([
    { ...compact, name: null }, { ...compact, name: 3 }, { ...compact, raw_status: undefined },
    { ...compact, raw_status: "completed" }, { ...compact, raw_status: "unknown" },
    { ...compact, status: "running" }, { ...compact, task_id: "" },
    { ...compact, task_summary: "not a compact row" }, { ...compact, updated_at: 3 },
  ])("does not relax malformed raw/name validation: %j", task => {
    expect(parseTaskUpdated({ tasks: [task], truncated_tasks: true })?.tasks).toEqual([]);
  });
  it.each([false, undefined])("does not grant compact authority in a complete envelope: %j", truncated_tasks => {
    expect(parseTaskUpdated({ tasks: [compact], truncated_tasks })?.tasks).toEqual([]);
  });
});
