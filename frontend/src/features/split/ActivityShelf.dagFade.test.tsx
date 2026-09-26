import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityState,
  makeDag,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";
import type { ActivityDagRun } from "./activityTypes";

/** A wave stack far taller than any shelf panel, so every assertion isolates
 *  the boundary measurement rather than the fixture height. */
function tallDag(nodeCount: number): ActivityDagRun {
  return makeDag({
    nodes: Array.from({ length: nodeCount }, (_unused, index) => ({
      id: `n${index}`,
      prompt: `step ${index}`,
      dependsOn: [],
      state: "pending",
    })),
    edges: [],
    waves: [],
  });
}

/** jsdom has no layout engine: pin the boxes the component measures. */
function pinRect(element: Element, top: number, bottom: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      left: 0,
      top,
      right: 320,
      bottom,
      width: 320,
      height: bottom - top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** Controllable ResizeObserver fake: tests fire the measured resize
 *  explicitly, mirroring ActivityShelf.resize.test.tsx. */
class FadeResizeObserver {
  static instances: FadeResizeObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FadeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function graphAndPanel(harness: ActivityShelfHarness): { graph: HTMLElement; panel: HTMLElement } {
  const graph = requireElement(
    harness.container.querySelector<HTMLElement>(".th-activity-graph"),
    "graph reel",
  );
  const panel = requireElement(
    graph.closest<HTMLElement>(".th-activity-panel"),
    "panel clipper",
  );
  return { graph, panel };
}

describe("ActivityShelf DAG bottom fade", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    FadeResizeObserver.instances = [];
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("dissolves the bottom row at the clipping ancestor's visible bottom", () => {
    renderShelf(harness, activityState({ dags: [tallDag(16)] }));
    openShelf(harness.container);
    const { graph, panel } = graphAndPanel(harness);
    // jsdom loads no stylesheet: inline overflow stands in for the panel's
    // overflow:hidden rule when marking the clipping ancestor.
    panel.style.overflowY = "hidden";
    pinRect(graph, 100, 700);
    pinRect(panel, 0, 400);

    panel.dispatchEvent(new Event("scroll"));

    expect(graph.getAttribute("data-fade-bottom")).toBe("true");
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("300px");
  });

  it("shows no bottom fade when the graph fits its clipping ancestor", () => {
    renderShelf(harness, activityState({ dags: [tallDag(16)] }));
    openShelf(harness.container);
    const { graph, panel } = graphAndPanel(harness);

    expect(graph.hasAttribute("data-fade-bottom")).toBe(false);

    panel.style.overflowY = "hidden";
    pinRect(graph, 100, 700);
    pinRect(panel, 0, 700);
    panel.dispatchEvent(new Event("scroll"));
    expect(graph.hasAttribute("data-fade-bottom")).toBe(false);
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("");

    pinRect(panel, 0, 400);
    panel.dispatchEvent(new Event("scroll"));
    expect(graph.getAttribute("data-fade-bottom")).toBe("true");
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("300px");

    pinRect(panel, 0, 800);
    panel.dispatchEvent(new Event("scroll"));
    expect(graph.hasAttribute("data-fade-bottom")).toBe(false);
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("");
  });

  it("recomputes the fade boundary when the clipping ancestor resizes", () => {
    vi.stubGlobal("ResizeObserver", FadeResizeObserver);
    renderShelf(harness, activityState({ dags: [tallDag(16)] }));
    openShelf(harness.container);
    const { graph, panel } = graphAndPanel(harness);
    panel.style.overflowY = "hidden";
    pinRect(graph, 100, 700);
    pinRect(panel, 0, 400);
    const observer = FadeResizeObserver.instances.find((instance) => instance.targets.has(graph));
    expect(observer).toBeDefined();

    act(() => observer?.fire());
    expect(graph.getAttribute("data-fade-bottom")).toBe("true");
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("300px");

    pinRect(panel, 0, 640);
    act(() => observer?.fire());
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("60px");

    pinRect(panel, 0, 800);
    act(() => observer?.fire());
    expect(graph.hasAttribute("data-fade-bottom")).toBe(false);
    expect(graph.style.getPropertyValue("--dag-fade-lift")).toBe("");
  });
});
