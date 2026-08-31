import { describe, expect, it } from "vitest";
import { applyTodoToolDetails, emptyActivityState } from "./activityState";

describe("todo phases", () => {
  const phases = [
    {
      name: "Build",
      tasks: [
        { content: "Compile", status: "completed" as const },
        { content: "Test", status: "in_progress" as const },
      ],
    },
  ];

  it("extracts the latest phases from todo tool details", () => {
    const next = applyTodoToolDetails(emptyActivityState(), { op: "write", phases });
    expect(next.todo).toEqual(phases);
  });

});
