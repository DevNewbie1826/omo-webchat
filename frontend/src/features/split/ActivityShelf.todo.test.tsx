import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TodoPhase } from "./activityTypes";
import {
  activityState,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";

describe("ActivityShelf", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("renders todo phases with OMO todo markers", () => {
    const todo: readonly TodoPhase[] = [
      {
        name: "Phase 1",
        tasks: [
          { content: "completed item", status: "completed" as const },
          { content: "active item", status: "in_progress" as const },
          { content: "dropped item", status: "abandoned" as const },
          { content: "later item", status: "pending" as const },
        ],
      },
    ];
    renderShelf(harness, activityState({ todo }));
    openShelf(harness.container);
    const items = harness.container.querySelectorAll(".th-activity-todo-task");
    expect(items.length).toBe(4);
    const markerOf = (index: number): string | null =>
      items[index]?.querySelector(".th-activity-todo-marker")?.textContent ?? null;
    expect(markerOf(0)).toContain("✓");
    expect(markerOf(1)).toContain("•");
    expect(markerOf(2)).toContain("×");
    expect(markerOf(3)).toContain("[ ]");
    expect(items[0]?.className).toContain("th-activity-todo-task--completed");
    expect(items[1]?.className).toContain("th-activity-todo-task--in_progress");
  });
});
