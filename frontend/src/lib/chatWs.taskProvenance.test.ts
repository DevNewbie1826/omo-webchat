import { describe, expect, it } from "vitest";
import corrected from "../../../contract/fixtures/server-sessions.activity-task-correction.json";
import legacy from "../../../contract/fixtures/server-sessions.activity.json";
import { parseChatServerFrame } from "./chatWs";
import { parseServerFrame } from "./contract/types_gen";

function digestFrame(row: unknown) {
  return { ...corrected, snapshots: [], taskDigest: { tasks: [row], truncated: false, running_count: 1, total_count: 1 } };
}

const rawRow = { task_id: "task-1", status: "completed", updated_at: "2026-09-07T10:01:00Z" };

describe("task provenance wire boundary", () => {
  it("roundtrips the correction and original clock through the actual chat parser", () => {
    expect(parseChatServerFrame(JSON.parse(JSON.stringify(corrected)))).toEqual(corrected);
  });

  it("preserves old valid frames without inventing provenance", () => {
    expect(parseChatServerFrame(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
  });

  it("preserves raw extension snapshot provenance", () => {
    const frame = { type: "extensionEvent", sessionId: "chat-1", name: "omo.task.updated", data: corrected.snapshots[0]?.data };
    expect(parseChatServerFrame(frame)).toEqual(frame);
  });

  it.each([null, 42, true, [], {}].map((value) => [value]))("rejects non-string provenance in the generated strict contract: %j", (raw_status) => {
    expect(parseServerFrame(digestFrame({ ...rawRow, raw_status }))).toBeNull();
  });

  it.each([null, 42, true, [], {}].map((value) => [value]))("ignores malformed optional provenance without losing membership: %j", (raw_status) => {
    const input = digestFrame({ ...rawRow, raw_status });
    const original = JSON.stringify(input);
    expect(parseChatServerFrame(input)).toEqual(digestFrame(rawRow));
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each([null, 42, true, [], {}].map((value) => [value]))("retains membership with an unknown non-string raw clock: %j", (updated_at) => {
    expect(parseChatServerFrame(digestFrame({ ...rawRow, raw_status: "running", updated_at }))).toEqual(
      digestFrame({ task_id: "task-1", status: "completed", raw_status: "running" }),
    );
  });

  it.each([{}, null, { status: "running" }, { task_id: 42, status: "running" }, { task_id: "task-1", status: null }])(
    "does not turn malformed required membership into an empty digest: %j", (row) => {
      expect(parseChatServerFrame(digestFrame(row))).toBeNull();
    },
  );

  it("preserves absent, empty and partial task sides", () => {
    const base = { type: "sessions.activity", sessionId: "chat-1", durableSessionId: "child-session-1", snapshots: [], overflow: false };
    for (const frame of [
      base,
      { ...base, taskDigest: { tasks: [], truncated: false, running_count: 0, total_count: 0 } },
      { ...base, taskDigest: { tasks: [rawRow], truncated: true, running_count: 1, total_count: 1 } },
    ]) {
      expect(parseChatServerFrame(frame)).toEqual(frame);
    }
    expect(parseChatServerFrame({ ...base, taskDigest: { tasks: null, truncated: false } })).toBeNull();
  });
});
