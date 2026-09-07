import { describe, expect, it } from "vitest";
import { parseTodoDetails } from "./activityParse";

const phases = [{
  name: "Build",
  tasks: [
    { content: "Compile", status: "completed" },
    { content: "Test", status: "in_progress" },
  ],
}];

describe("parseTodoDetails", () => {
  it("accepts actual completion-transition arrays and preserves their details", () => {
    const details = {
      op: "write",
      completedTasks: [{ phase: "Build", content: "Compile" }],
      storage: "session",
      phases,
    };
    expect(parseTodoDetails(details)).toEqual(details);
  });

  it("preserves empty transition metadata without treating it as a clear", () => {
    expect(parseTodoDetails({ phases, completedTasks: [] })).toEqual({ phases, completedTasks: [] });
  });

  it.each([
    { op: 1 },
    { storage: {} },
    { completedTasks: 1 },
    { completedTasks: null },
    { completedTasks: "invalid" },
    { completedTasks: [{ phase: "Build" }] },
    { completedTasks: [{ phase: 1, content: "Compile" }] },
    { completedTasks: [{ phase: "Build", content: "Compile" }, null] },
  ])("ignores malformed optional metadata without discarding phases: %j", (metadata) => {
    expect(parseTodoDetails({ phases, ...metadata })).toEqual({ phases });
  });

  it("ignores unrelated metadata while preserving valid optional fields", () => {
    expect(parseTodoDetails({ phases, op: "read", storage: false, extra: null, completedTasks: [] }))
      .toEqual({ phases, op: "read", completedTasks: [] });
  });

  it.each([
    {},
    null,
    [],
    "invalid",
    { name: 1, tasks: [] },
    { name: "Missing tasks" },
    { name: "Invalid tasks", tasks: null },
    { name: "Invalid tasks", tasks: {} },
    { name: "Invalid task", tasks: [null] },
    { name: "Invalid task", tasks: [[]] },
    { name: "Invalid task", tasks: [{ content: "A" }] },
    { name: "Invalid task", tasks: [{ status: "pending" }] },
    { name: "Invalid task", tasks: [{ content: 1, status: "pending" }] },
    { name: "Invalid task", tasks: [{ content: "A", status: "unknown" }] },
    { name: "Invalid task", tasks: [{ content: "A", status: 1 }] },
    { name: "Mixed tasks", tasks: [{ content: "A", status: "pending" }, { content: "B" }] },
  ].map((invalidPhase) => ({ invalidPhase })))("rejects the whole snapshot for a malformed phase/task: %j", ({ invalidPhase }) => {
    expect(parseTodoDetails({ phases: [invalidPhase] })).toBeNull();
    expect(parseTodoDetails({ phases: [...phases, invalidPhase] })).toBeNull();
    expect(parseTodoDetails({ phases: [invalidPhase, ...phases] })).toBeNull();
  });

  it.each([undefined, null, {}, "nope", 1])("rejects missing or non-array phases: %j", (invalidPhases) => {
    expect(parseTodoDetails({ phases: invalidPhases })).toBeNull();
  });

  it("rejects absent payloads", () => {
    expect(parseTodoDetails({ op: "read" })).toBeNull();
    expect(parseTodoDetails(null)).toBeNull();
    expect(parseTodoDetails([])).toBeNull();
  });

  it.each([{ empty: [] }, { empty: [{ name: "Build", tasks: [] }] }])("PIN accepts explicit empty shapes: %j", ({ empty }) => {
    expect(parseTodoDetails({ phases: empty })).toEqual({ phases: empty });
  });

  it("PIN accepts every supported status and string fields without imposing new restrictions", () => {
    const valid = [{ name: "", tasks: ["pending", "in_progress", "completed", "abandoned"].map(
      (status) => ({ content: "", status }),
    ) }];
    expect(parseTodoDetails({ phases: valid })).toEqual({ phases: valid });
  });
});
