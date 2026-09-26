import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { i18n, requireElement } from "./chatPaneTestHarness";
import { applyActivityEvent, emptyActivityState } from "./activityState";

describe("ActivityShelf", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("renders engine-shaped task and multi-node DAG snapshots", () => {
    const parentSessionId = "parent-session";
    const taskPayload = {
      parent_session_id: parentSessionId,
      truncated_tasks: false,
      tasks: [
        {
          task_id: "st_child_one",
          child_session_id: "child-session-1",
          status: "running",
          task_summary: "Inspect implementation",
          name: "inspect",
          category: "deep",
          execution_mode: "in-process",
          model: "test/model",
          run_stats: { runtime_ms: 2000, turns: 2, tool_calls: 1, total_tokens: 1200, output_tokens: 200 },
          live_progress: {
            activity: "reading",
            started_at: 1788393600000,
            current_tool: "read",
            last_assistant_line: "Inspecting",
            turns: 2,
            tool_calls: 1,
          },
          residency_state: "resident",
          depth: 1,
          created_at: "2026-09-03T00:00:00Z",
          updated_at: "2026-09-03T00:00:02Z",
        },
        {
          task_id: "st_child_two",
          child_session_id: "child-session-2",
          status: "pending",
          task_summary: "Verify behavior",
          name: "verify",
          category: "quick",
          execution_mode: "in-process",
          depth: 1,
          created_at: "2026-09-03T00:00:01Z",
          updated_at: "2026-09-03T00:00:01Z",
        },
      ],
    };
    const dagPayload = {
      parent_session_id: parentSessionId,
      truncated_runs: false,
      runs: [{
        run_id: "run-activity",
        run_key: "phase-c",
        name: "Phase C verification",
        status: "running",
        created_at: "2026-09-03T00:00:00Z",
        updated_at: "2026-09-03T00:00:02Z",
        counts: { total: 2, pending: 1, blocked: 0, scheduled: 0, running: 1, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
        nodes: [
          { id: "inspect", label: "Inspect", prompt: "Inspect implementation", depends_on: [], state: "running", attempt: 1, task_id: "st_child_one", started_at: "2026-09-03T00:00:00Z" },
          { id: "verify", label: "Verify", prompt: "Verify behavior", depends_on: ["inspect"], state: "pending", attempt: 0, task_id: "st_child_two" },
        ],
        edges: [{ from: "inspect", to: "verify" }],
        waves: [{ index: 0, node_ids: ["inspect"] }, { index: 1, node_ids: ["verify"] }],
      }],
    };
    const withTasks = applyActivityEvent(emptyActivityState(), "omo.task.updated", taskPayload);
    const activities = applyActivityEvent(withTasks, "omo.dag.updated", dagPayload);

    renderShelf(harness, activities);
    openShelf(harness.container);

    expect(harness.container.querySelectorAll(".th-activity-agent")).toHaveLength(2);
    expect(harness.container.textContent).toContain("Inspecting");
    // P6: the DAG renders as a graph by default.
    expect(harness.container.querySelectorAll(".th-activity-gnode")).toHaveLength(2);
    expect(harness.container.textContent).toContain("Phase C verification");
    expect(activities.tasks.get("st_child_one")?.taskSummary).toBe("Inspect implementation");
    expect(activities.tasks.get("st_child_one")?.liveProgress?.currentTool).toBe("read");
    expect(activities.dags.get("run-activity")?.edges).toEqual([{ from: "inspect", to: "verify" }]);
    expect(activities.dags.get("run-activity")?.waves).toEqual([
      { index: 0, nodeIds: ["inspect"] },
      { index: 1, nodeIds: ["verify"] },
    ]);
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

  it("defaults to graph, and the List round trip keeps layered nodes", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openShelf(harness.container);
    const graphBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    );
    const listBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="list"]'),
      "list toggle",
    );
    // P6: graph is the default view.
    expect(graphBtn.getAttribute("aria-pressed")).toBe("true");
    expect(listBtn.getAttribute("aria-pressed")).toBe("false");
    // The optional List remains inside the DAG view.
    click(listBtn);
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");
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

  it("leads every card with its glyph and keeps halo, comet and accent progress to live work", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openShelf(harness.container);
    // Workflow node rows select Subagents first; motion belongs to the shown graph.
    click(requireElement(harness.container.querySelector('[data-activity-tab="dag"]'), "DAG tab"));
    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    const glyphRight = (glyph: Element): number => glyph.tagName === "circle"
      ? Number(glyph.getAttribute("cx")) + Number(glyph.getAttribute("r"))
      : Math.max(...(glyph.getAttribute("d")?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((_, index) => index % 2 === 0));
    for (const node of graph.querySelectorAll(".th-activity-gnode")) {
      const glyph = requireElement(node.querySelector(".th-activity-gstatus"), "status glyph");
      expect(glyphRight(glyph)).toBeLessThan(Number(node.querySelector(".th-activity-glabel")?.getAttribute("x")));
    }
    const haloOwners = () => [...graph.querySelectorAll(".th-activity-gnode-halo")]
      .map(halo => halo.closest("[data-node]")?.getAttribute("data-node"));
    expect(haloOwners()).toEqual(["c"]);
    expect(graph.querySelectorAll(".th-activity-gedge-comet")).toHaveLength(2);
    const fill = requireElement(harness.container.querySelector<HTMLElement>(".th-activity-dag-progress-fill"), "progress fill");
    expect(fill.style.transform).toBe(`scaleX(${2 / 3})`);
    expect(fill.parentElement?.getAttribute("data-live")).toBe("true");

    click(requireElement(harness.container.querySelector('.th-activity-view-btn[data-view="list"]'), "list toggle"));
    const rows = [...harness.container.querySelectorAll(".th-activity-dnode")];
    expect(rows.map(row => row.querySelector(".th-activity-dnode-rail .th-activity-gstatus")?.getAttribute("data-glyph")))
      .toEqual(["check", "check", "running"]);
    expect(rows.map(row => row.querySelector(".th-activity-dnode-state")?.textContent))
      .toEqual(["activity.status.completed", "activity.status.completed", "activity.status.running"]);
    click(requireElement(harness.container.querySelector('.th-activity-view-btn[data-view="graph"]'), "graph toggle"));

    const done = makeDag({
      status: "completed",
      counts: { ...makeDag().counts, running: 0, completed: 3 },
      nodes: makeDag().nodes.map(node => ({ ...node, state: "completed" })),
    });
    renderShelf(harness, activityState({ dags: [done] }));
    const reel = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    expect(reel.querySelectorAll(".th-activity-gnode-halo, .th-activity-gedge-comet, .th-activity-gedge-glow")).toHaveLength(0);
    expect(reel.hasAttribute("data-live")).toBe(false);
    expect(fill.style.transform).toBe("scaleX(1)");
    expect(fill.parentElement?.hasAttribute("data-live")).toBe(false);
  });

  it("fills run progress for succeeded, failed and skipped nodes as states change", () => {
    const translation = vi.spyOn(i18n, "t").mockImplementation((key, vars) =>
      key === "activity.dagCounts" ? `${vars?.["done"]}/${vars?.["total"]}` : key);
    try {
      const nodes = [
        { id: "ok", prompt: "Succeeded", dependsOn: [], state: "completed" },
        { id: "error", prompt: "Failed", dependsOn: [], state: "failed" },
        { id: "skip", prompt: "Skipped", dependsOn: [], state: "skipped" },
        { id: "cancel", prompt: "Cancelled", dependsOn: [], state: "cancelled" },
        { id: "run", prompt: "Running", dependsOn: [], state: "running" },
        { id: "wait", prompt: "Pending", dependsOn: [], state: "pending" },
      ];
      const counts = {
        total: 6, pending: 1, blocked: 0, scheduled: 0, running: 1,
        completed: 1, failed: 1, cancelled: 1, skipped: 1,
      };
      renderShelf(harness, activityState({ dags: [makeDag({ nodes, counts, edges: [] })] }));
      openShelf(harness.container);
      const fill = requireElement(harness.container.querySelector<HTMLElement>(".th-activity-dag-progress-fill"), "progress fill");
      expect(fill.style.transform).toBe(`scaleX(${3 / 6})`);
      expect(harness.container.querySelector(".th-activity-dag-counts")?.textContent).toBe("3/6");

      renderShelf(harness, activityState({ dags: [makeDag({
        nodes: nodes.map(node => node.id === "wait" ? { ...node, state: "completed" } : node),
        counts: { ...counts, pending: 0, completed: 2 },
        edges: [],
      })] }));
      expect(fill.style.transform).toBe(`scaleX(${4 / 6})`);
      expect(harness.container.querySelector(".th-activity-dag-counts")?.textContent).toBe("4/6");
    } finally {
      translation.mockRestore();
    }
  });

  it("keeps running state in the glyph and word, without halo or comet, under reduced motion", () => {
    const original = window.matchMedia;
    const media = Object.assign(new EventTarget(), { matches: true, media: "(prefers-reduced-motion: reduce)", onchange: null, addListener() {}, removeListener() {} });
    vi.stubGlobal("matchMedia", (query: string) => query === media.media ? media : original(query));
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openShelf(harness.container);
    click(requireElement(harness.container.querySelector('[data-activity-tab="dag"]'), "DAG tab"));
    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    expect(graph.querySelectorAll(".th-activity-gnode-halo, .th-activity-gedge-comet, .th-activity-gedge-glow")).toHaveLength(0);
    expect(graph.querySelector('[data-node="c"] .th-activity-gstatus--running')?.getAttribute("data-glyph")).toBe("running");
    expect(graph.querySelector('[data-node="c"] .th-activity-gstate')?.textContent).toBe("activity.status.running");
  });

  it("scrolls the first running node into view on the first visible paint, then leaves the reel to the user", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => { frames[handle - 1] = () => undefined; });
    const reelMetric = (value: number) => function (this: Element): number {
      return this.classList.contains("th-activity-graph") ? value : 0;
    };
    const clientWidth = vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(reelMetric(300));
    const scrollWidth = vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(reelMetric(2000));
    try {
      const chain = makeDag({
        nodes: [
          { id: "a", prompt: "a", dependsOn: [], state: "completed" },
          { id: "b", prompt: "b", dependsOn: ["a"], state: "completed" },
          { id: "c", prompt: "c", dependsOn: ["b"], state: "completed" },
          { id: "d", prompt: "d", dependsOn: ["c"], state: "running" },
        ],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }],
      });
      renderShelf(harness, activityState({ dags: [chain] }));
      openShelf(harness.container);
      const graph = requireElement(harness.container.querySelector<HTMLElement>(".th-activity-graph"), "graph reel");
      const nodeX = Number(/translate\(([-\d.]+)/.exec(graph.querySelector('[data-node="d"]')?.getAttribute("transform") ?? "")?.[1]);
      const cardWidth = Number(graph.querySelector(".th-activity-gnode-card")?.getAttribute("width"));
      expect(graph.scrollLeft).toBeGreaterThan(0);
      expect(nodeX).toBeGreaterThanOrEqual(graph.scrollLeft);
      expect(nodeX + cardWidth).toBeLessThanOrEqual(graph.scrollLeft + 300);

      act(() => { for (const frame of frames.splice(0)) frame(0); });
      graph.scrollLeft = 0;
      renderShelf(harness, activityState({ dags: [{ ...chain, nodes: chain.nodes.map(node => ({ ...node, state: node.id === "a" ? "running" : node.state })) }] }));
      expect(graph.scrollLeft).toBe(0);
    } finally {
      clientWidth.mockRestore();
      scrollWidth.mockRestore();
    }
  });
});
