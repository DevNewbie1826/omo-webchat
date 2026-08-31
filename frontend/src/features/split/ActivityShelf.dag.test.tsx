import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityState,
  click,
  makeDag,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";

describe("ActivityShelf", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("keeps every DAG node visible when wave metadata omits one", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({ waves: [{ index: 0, nodeIds: ["a", "b"] }] })],
    }));
    openShelf(harness.container);
    const graphBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    );
    click(graphBtn);

    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    expect(graph.querySelectorAll(".th-activity-gnode").length).toBe(3);
    expect(graph.querySelector('.th-activity-gnode[data-node="c"]')).not.toBeNull();
  });

  it("toggles the DAG view between list and graph with layered nodes", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openShelf(harness.container);
    const graphBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    );
    expect(graphBtn.getAttribute("aria-pressed")).toBe("false");
    expect(harness.container.querySelector(".th-activity-graph")).toBeNull();
    expect(harness.container.querySelectorAll(".th-activity-dnode").length).toBe(3);
    click(graphBtn);
    expect(graphBtn.getAttribute("aria-pressed")).toBe("true");
    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    const nodes = graph.querySelectorAll(".th-activity-gnode");
    expect(nodes.length).toBe(3);
    const layerOf = (id: string): string | null =>
      graph.querySelector(`.th-activity-gnode[data-node="${id}"]`)?.getAttribute("data-layer") ?? null;
    expect(layerOf("a")).toBe("0");
    expect(layerOf("b")).toBe("0");
    expect(layerOf("c")).toBe("1");
  });
});
