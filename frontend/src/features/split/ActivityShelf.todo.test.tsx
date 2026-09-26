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

  it("renders todo phases as timeline rows with a status glyph per task", () => {
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
    const glyphOf = (index: number): string | null => {
      const glyph = items[index]?.querySelector(".th-activity-lane > .th-activity-glyph");
      const kind = [...(glyph?.classList ?? [])].find(
        (name) => name.startsWith("th-activity-glyph--") && name !== "th-activity-glyph--live",
      );
      return kind?.slice("th-activity-glyph--".length) ?? null;
    };
    expect(glyphOf(0)).toBe("done");
    expect(glyphOf(1)).toBe("running");
    expect(glyphOf(2)).toBe("stopped");
    expect(glyphOf(3)).toBe("pending");
    // The glyph is decorative; the localized status word rides in SR text.
    expect(items[1]?.querySelector(".th-activity-lane")?.getAttribute("aria-hidden")).toBe("true");
    expect(items[1]?.querySelector(".th-activity-sr")?.textContent).toBe("activity.todoStatus.in_progress");
    expect(items[0]?.className).toContain("th-activity-todo-task--completed");
    expect(items[1]?.className).toContain("th-activity-todo-task--in_progress");

    // Honest motion: the in-progress arc spins only while a run is in flight.
    expect(harness.container.querySelector(".th-activity-glyph--live")).toBeNull();
    renderShelf(harness, { ...activityState({ todo }), runInFlight: true });
    const live = harness.container.querySelectorAll(".th-activity-glyph--live");
    expect(live.length).toBe(1);
    expect(live[0]?.closest(".th-activity-todo-task")?.className).toContain("th-activity-todo-task--in_progress");
  });
});
