import { describe, expect, it } from "vitest";
import { parseTodoDetails } from "./activityParse";

describe("parseTodoDetails", () => {
  it("extracts camelCase phases and tasks from todo details", () => {
    expect(
      parseTodoDetails({
        op: "write",
        completedTasks: 1,
        storage: "session",
        phases: [
          {
            name: "Build",
            tasks: [
              { content: "Compile", status: "completed" },
              { content: "Test", status: "in_progress" },
            ],
          },
        ],
      }),
    ).toEqual({
      op: "write",
      completedTasks: 1,
      storage: "session",
      phases: [
        {
          name: "Build",
          tasks: [
            { content: "Compile", status: "completed" },
            { content: "Test", status: "in_progress" },
          ],
        },
      ],
    });
  });

  it("drops malformed phases and tasks", () => {
    const parsed = parseTodoDetails({
      phases: [
        { name: "Keep", tasks: [{ content: "A", status: "pending" }, { content: "B" }, { status: "pending" }] },
        { tasks: [] },
      ],
    });
    expect(parsed?.phases).toEqual([{ name: "Keep", tasks: [{ content: "A", status: "pending" }] }]);
  });

  it("returns null when phases are absent or not an array", () => {
    expect(parseTodoDetails({ op: "read" })).toBeNull();
    expect(parseTodoDetails({ phases: "nope" })).toBeNull();
    expect(parseTodoDetails(null)).toBeNull();
  });
});
