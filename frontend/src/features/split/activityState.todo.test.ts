import { describe, expect, it } from "vitest";
import { applyTodoToolDetails, emptyActivityState } from "./activityState";

describe("todo phases", () => {
  const phases = [{
    name: "Build",
    tasks: [
      { content: "Compile", status: "completed" as const },
      { content: "Test", status: "in_progress" as const },
    ],
  }];

  it("extracts the latest phases from todo tool details", () => {
    const next = applyTodoToolDetails(emptyActivityState(), { op: "write", phases });
    expect(next.todo).toEqual(phases);
  });

  it("commits the complete list from an actual completion-transition result", () => {
    const incumbent = applyTodoToolDetails(emptyActivityState(), { phases });
    const completed = [{ name: "Build", tasks: [{ content: "Test", status: "completed" }] }];
    const next = applyTodoToolDetails(incumbent, {
      op: "write", phases: completed, completedTasks: [{ phase: "Build", content: "Test" }],
    });
    expect(next.todo).toEqual(completed);
    expect(incumbent.todo).toEqual(phases);
    expect(next.tasks).toBe(incumbent.tasks);
    expect(next.dags).toBe(incumbent.dags);
    expect(next.heartbeats).toBe(incumbent.heartbeats);
  });

  it.each([
    { phases: [{}] },
    { phases: [phases[0], {}] },
    { phases: [{ name: "Build", tasks: [{ content: "Compile", status: "completed" }, { content: "Test" }] }] },
    { phases: [{ name: "Build", tasks: [null] }] },
    { phases: [{ name: "Build", tasks: [{ content: "Test", status: "unknown" }] }] },
    { phases: null },
    {},
  ])("retains the incumbent whole list on malformed input: %j", (details) => {
    const incumbent = applyTodoToolDetails(emptyActivityState(), { phases });
    expect(applyTodoToolDetails(incumbent, details)).toBe(incumbent);
    const absent = emptyActivityState();
    expect(applyTodoToolDetails(absent, details)).toBe(absent);
  });

  it.each([{ empty: [] }, { empty: [{ name: "Build", tasks: [] }] }])("PIN clears explicitly and permits later initialization: %j", ({ empty }) => {
    const incumbent = applyTodoToolDetails(emptyActivityState(), { phases });
    const cleared = applyTodoToolDetails(incumbent, { op: "remove", phases: empty });
    expect(cleared.todo).toEqual(empty);
    const initialized = applyTodoToolDetails(cleared, { op: "init", phases });
    expect(initialized.todo).toEqual(phases);
  });

  it("PIN permits intentional completed-to-in_progress reopening", () => {
    const completed = [{ name: "Build", tasks: [{ content: "Test", status: "completed" }] }];
    const incumbent = applyTodoToolDetails(emptyActivityState(), { op: "write", phases: completed });
    const reopened = [{ name: "Build", tasks: [{ content: "Test", status: "in_progress" }] }];
    expect(applyTodoToolDetails(incumbent, { op: "write", phases: reopened }).todo).toEqual(reopened);
  });

  it("PIN replaces the whole list through init, append, drop, remove, re-add and rename", () => {
    let state = emptyActivityState();
    const a = { content: "A", status: "pending" };
    const b = { content: "B", status: "abandoned" };
    const snapshots = [
      { op: "init", phases: [{ name: "Build", tasks: [a] }] },
      { op: "append", phases: [{ name: "Build", tasks: [a, b] }] },
      { op: "drop", phases: [{ name: "Build", tasks: [b] }] },
      { op: "remove", phases: [] },
      { op: "append", phases: [{ name: "Build", tasks: [a] }] },
      { op: "write", phases: [{ name: "Renamed", tasks: [a] }] },
    ];
    for (const snapshot of snapshots) {
      state = applyTodoToolDetails(state, snapshot);
      expect(state.todo).toEqual(snapshot.phases);
    }
  });
});
