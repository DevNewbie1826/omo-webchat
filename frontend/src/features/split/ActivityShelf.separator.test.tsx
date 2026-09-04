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
 * The spacing must be symmetric ("a · b") and come from the BarSeparator
 * markup: spaces are sibling text nodes around its aria-hidden middot span,
 * not CSS margins on the separator span. The rendered bar text is exactly the
 * segments joined by " · " and no stylesheet change can silently skew the gap.
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

  it("keeps separator spaces outside the aria-hidden middot", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask()],
        dags: [makeDag()],
        todo: [{ name: "phase", tasks: [] }],
      }),
    );
    const seps = harness.container.querySelectorAll(".th-activity-bar-sep");
    expect(seps.length).toBeGreaterThan(0);
    for (const sep of seps) {
      expect(sep.textContent).toBe("·");
      expect(sep.getAttribute("aria-hidden")).toBe("true");
      expect(sep.previousSibling?.nodeType).toBe(Node.TEXT_NODE);
      expect(sep.previousSibling?.textContent).toMatch(/\s$/);
      expect(sep.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
      expect(sep.nextSibling?.textContent).toMatch(/^\s/);
    }
  });

  it("keeps all horizontal spacing in the separator text, not CSS margins", () => {
    const body = activityShelfCss.match(/\.th-activity-bar-sep\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body, "activity-shelf.css must keep a .th-activity-bar-sep rule").not.toBe("");
    const marginDecls = [
      ...body.matchAll(
        /(?:^|;)\s*(margin(?:-left|-right|-inline(?:-start|-end)?)?)\s*:\s*([^;]*)/gi,
      ),
    ];
    for (const [, prop, raw] of marginDecls) {
      const value = (raw ?? "").trim();
      expect(
        /^0+$/.test(value.replace(/\s+/g, "")),
        `.th-activity-bar-sep must not carry horizontal margins (found "${prop}: ${value}"); ` +
          "the symmetric gap lives in sibling text nodes around the hidden middot",
      ).toBe(true);
    }
  });
});
