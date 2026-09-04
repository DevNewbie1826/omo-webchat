import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityState,
  makeDag,
  makeTask,
  mountActivityShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";

/**
 * Summary-bar separator symmetry contract.
 *
 * The collapsed bar joins its summary segments with a middot separator.
 * The spacing must be symmetric ("a · b") and come from a single source:
 * the separator text itself (" · ", the same convention ToolCard pins in
 * ToolCard.anatomy.test.tsx), not CSS margins on the separator span. With
 * margins removed, the rendered text is exactly the segments joined by
 * " · " and no stylesheet change can silently skew the gap on one side.
 */

const activityShelfCss = readFileSync("src/styles/activity-shelf.css", "utf8");

describe("ActivityShelf summary separator", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("joins summary segments with a symmetric middot separator", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask()],
        dags: [makeDag()],
        todo: [{ name: "phase", tasks: [] }],
      }),
    );
    const text = requireElement(
      harness.container.querySelector<HTMLElement>(".th-activity-bar-text"),
      "summary bar text",
    );
    expect(text.textContent).toBe(
      ["activity.summaryTodo", "activity.summaryAgents", "activity.summaryDag"].join(" · "),
    );
  });

  it("joins the partial-history marker with the same symmetric separator", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()], truncatedTasks: true }));
    const text = requireElement(
      harness.container.querySelector<HTMLElement>(".th-activity-bar-text"),
      "summary bar text",
    );
    expect(text.textContent).toBe("activity.summaryAgents · activity.partial");
  });

  it("keeps all horizontal spacing in the separator text, not CSS margins", () => {
    const body = activityShelfCss.match(/\.th-activity-bar-sep\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body, "activity-shelf.css must keep a .th-activity-bar-sep rule").not.toBe("");
    const margin = body.match(/(?:^|;)\s*margin(?:-(?:left|right))?\s*:\s*([^;]*)/i)?.[1]?.trim();
    expect(
      margin === undefined || /^0+$/.test(margin.replace(/\s+/g, "")),
      `.th-activity-bar-sep must not carry horizontal margins (found "${margin ?? "none"}"); ` +
        "the symmetric gap lives in the separator text itself",
    ).toBe(true);
  });
});
