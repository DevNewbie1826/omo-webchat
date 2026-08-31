import { describe, expect, it } from "vitest";
import { extractTodoPhases } from "./chatTodoHistory";

describe("extractTodoPhases", () => {
  it("extracts phases from a bare todo tool history entry", () => {
    const phases = [{ name: "Bare tool", tasks: [{ content: "z", status: "completed" as const }] }];

    const result = extractTodoPhases([
      { type: "tool", toolName: "todo", result: { details: { op: "write", phases } } },
    ]);

    expect(result).toEqual(phases);
  });
});
