import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TodoPhase } from "./activityTypes";
import {
  activityState,
  click,
  makeDag,
  makeTask,
  mountActivityShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";

/**
 * P5/P6 tabbed activity shelf: three equal primary tabs (Todo / Subagents /
 * DAG) over one content area, a separate compact fold control, DAG defaulting
 * to graph, and motion that only represents state transitions. These tests
 * are the failing-first behavior contract for ui-followup-activity-20260907.
 */

function openPanel(container: ParentNode): HTMLButtonElement {
  const fold = requireElement(
    container.querySelector<HTMLButtonElement>("button.th-activity-fold"),
    "separate fold control",
  );
  click(fold);
  return fold;
}

function tabOf(container: ParentNode, id: string): HTMLButtonElement {
  return requireElement(
    container.querySelector<HTMLButtonElement>(`[role="tab"][data-activity-tab="${id}"]`),
    `${id} tab`,
  );
}

function selectTab(container: ParentNode, id: string): void {
  click(tabOf(container, id));
}

function selectedTab(container: ParentNode): string | null {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-activity-tab") ?? null;
}

function pressKey(tab: HTMLButtonElement, key: string): void {
  act(() => {
    tab.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

const todoPhases: readonly TodoPhase[] = [
  {
    name: "Phase 1",
    tasks: [
      { content: "done item", status: "completed" },
      { content: "active item", status: "in_progress" },
      { content: "later item", status: "pending" },
    ],
  },
  { name: "Phase 2", tasks: [{ content: "another done", status: "completed" }] },
];

describe("ActivityShelf tabs", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("renders three equal primary tabs in user order with compact counts", () => {
    renderShelf(harness, activityState({
      todo: todoPhases,
      tasks: [makeTask(), makeTask({ taskId: "t2", status: "completed" })],
      dags: [makeDag()],
    }));
    openPanel(harness.container);

    const tabs = [...harness.container.querySelectorAll<HTMLButtonElement>("[role='tab'][data-activity-tab]")];
    expect(tabs.map((tab) => tab.getAttribute("data-activity-tab"))).toEqual(["todo", "agents", "dag"]);
    for (const tab of tabs) {
      expect(tab.getAttribute("role")).toBe("tab");
      expect(tab.getAttribute("aria-selected")).not.toBeNull();
      expect(tab.getAttribute("aria-controls")).not.toBeNull();
    }
    expect(harness.container.querySelector("[role='tablist']")).not.toBeNull();
    // Compact counts: todo done/total; agents running/total including the
    // projected DAG node rows (workflow children surface as agent rows).
    const counts = tabs.map((tab) => tab.querySelector(".th-activity-tab-count")?.textContent);
    expect(counts).toEqual(["2/4", "2/5", "2/3"]);
  });

  it("shows exactly the selected tabpanel and hides the others", () => {
    renderShelf(harness, activityState({
      todo: todoPhases,
      tasks: [makeTask()],
      dags: [makeDag()],
    }));
    openPanel(harness.container);
    const panelOf = (id: string): HTMLElement =>
      requireElement(
        harness.container.querySelector<HTMLElement>(`[data-activity-tabpanel="${id}"]`),
        `${id} tabpanel`,
      );
    expect(selectedTab(harness.container)).toBe("todo");
    expect(panelOf("todo").hidden).toBe(false);
    expect(panelOf("agents").hidden).toBe(true);
    expect(panelOf("dag").hidden).toBe(true);
    expect(panelOf("todo").getAttribute("role")).toBe("tabpanel");

    selectTab(harness.container, "dag");
    expect(panelOf("todo").hidden).toBe(true);
    expect(panelOf("agents").hidden).toBe(true);
    expect(panelOf("dag").hidden).toBe(false);
    expect(panelOf("dag").querySelector(".th-activity-dag")).not.toBeNull();
  });

  it("initially selects the first available content in user order", async () => {
    renderShelf(harness, activityState({ todo: todoPhases, tasks: [makeTask()], dags: [makeDag()] }));
    openPanel(harness.container);
    expect(selectedTab(harness.container)).toBe("todo");

    const agentsOnly = mountActivityShelf();
    try {
      renderShelf(agentsOnly, activityState({ tasks: [makeTask()] }));
      openPanel(agentsOnly.container);
      expect(selectedTab(agentsOnly.container)).toBe("agents");
    } finally {
      await unmountActivityShelf(agentsOnly);
    }
  });

  it("never lets new activity steal an explicit selection", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openPanel(harness.container);
    selectTab(harness.container, "dag");
    expect(selectedTab(harness.container)).toBe("dag");

    renderShelf(harness, activityState({ todo: todoPhases, dags: [makeDag()] }));
    expect(selectedTab(harness.container)).toBe("dag");
  });

  it("keeps empty tabs mounted with a proper empty state", () => {
    renderShelf(harness, activityState({ todo: todoPhases }));
    openPanel(harness.container);
    const tabs = [...harness.container.querySelectorAll("[data-activity-tab]")];
    expect(tabs.map((tab) => tab.getAttribute("data-activity-tab"))).toEqual(["todo", "agents", "dag"]);
    const agentsPanel = requireElement(
      harness.container.querySelector<HTMLElement>('[data-activity-tabpanel="agents"]'),
      "agents tabpanel",
    );
    const dagPanel = requireElement(
      harness.container.querySelector<HTMLElement>('[data-activity-tabpanel="dag"]'),
      "dag tabpanel",
    );
    expect(agentsPanel.textContent).toContain("activity.emptyAgents");
    expect(dagPanel.textContent).toContain("activity.emptyDag");
  });

  it("keeps collapse on a separate compact chevron control, not the summary bar", () => {
    renderShelf(harness, activityState({ todo: todoPhases, tasks: [makeTask()], dags: [makeDag()] }));
    const fold = requireElement(
      harness.container.querySelector<HTMLButtonElement>("button.th-activity-fold"),
      "fold control",
    );
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.getAttribute("aria-controls")).not.toBeNull();
    const bar = requireElement(harness.container.querySelector(".th-activity-bar"), "summary bar");
    expect(bar.closest("button")).toBeNull();
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    // The tab strip is permanent chrome: reachable while collapsed.
    expect(tabOf(harness.container, "todo")).toBeDefined();

    click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();

    // Tab click while collapsed opens the panel and selects that tab.
    click(fold);
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    selectTab(harness.container, "dag");
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();
    expect(selectedTab(harness.container)).toBe("dag");
  });

  it("navigates tabs from the keyboard with a roving tabindex", () => {
    renderShelf(harness, activityState({ todo: todoPhases, tasks: [makeTask()], dags: [makeDag()] }));
    openPanel(harness.container);
    const todo = tabOf(harness.container, "todo");
    const agents = tabOf(harness.container, "agents");
    const dag = tabOf(harness.container, "dag");
    expect(todo.tabIndex).toBe(0);
    expect(agents.tabIndex).toBe(-1);
    expect(dag.tabIndex).toBe(-1);

    pressKey(todo, "ArrowRight");
    expect(selectedTab(harness.container)).toBe("agents");
    expect(agents.tabIndex).toBe(0);
    expect(todo.tabIndex).toBe(-1);
    pressKey(agents, "End");
    expect(selectedTab(harness.container)).toBe("dag");
    pressKey(dag, "Home");
    expect(selectedTab(harness.container)).toBe("todo");
    pressKey(todo, "ArrowLeft");
    expect(selectedTab(harness.container)).toBe("dag");
  });

  it("defaults the DAG tab to graph and keeps the user's view across tab and fold switches", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openPanel(harness.container);
    expect(harness.container.querySelector('[data-activity-tabpanel="dag"] .th-activity-graph svg')).not.toBeNull();

    const listBtn = requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="list"]'),
      "list toggle",
    );
    click(listBtn);
    expect(harness.container.querySelector('[data-activity-tabpanel="dag"] .th-activity-dagnodes')).not.toBeNull();

    // Survives a tab round trip.
    selectTab(harness.container, "agents");
    selectTab(harness.container, "dag");
    expect(harness.container.querySelector('[data-activity-tabpanel="dag"] .th-activity-dagnodes')).not.toBeNull();
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");

    // Survives fold/unfold.
    const fold = requireElement(
      harness.container.querySelector<HTMLButtonElement>("button.th-activity-fold"),
      "fold control",
    );
    click(fold);
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    click(fold);
    expect(harness.container.querySelector('[data-activity-tabpanel="dag"] .th-activity-dagnodes')).not.toBeNull();
  });

  it("keeps tabpanel elements mounted so per-view scroll state survives switching", () => {
    renderShelf(harness, activityState({ todo: todoPhases, tasks: [makeTask()], dags: [makeDag()] }));
    openPanel(harness.container);
    const dagPanel = requireElement(
      harness.container.querySelector<HTMLElement>('[data-activity-tabpanel="dag"]'),
      "dag tabpanel",
    );
    const todoPanel = requireElement(
      harness.container.querySelector<HTMLElement>('[data-activity-tabpanel="todo"]'),
      "todo tabpanel",
    );
    selectTab(harness.container, "dag");
    dagPanel.scrollTop = 42;
    selectTab(harness.container, "todo");
    todoPanel.scrollTop = 7;
    selectTab(harness.container, "dag");
    expect(dagPanel.scrollTop).toBe(42);
    selectTab(harness.container, "todo");
    expect(todoPanel.scrollTop).toBe(7);
  });

  it("animates only real state transitions, never ticks or tab switches", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openPanel(harness.container);
    selectTab(harness.container, "dag");
    const nodeClass = (id: string): string =>
      harness.container.querySelector(`.th-activity-gnode[data-node="${id}"]`)?.getAttribute("class") ?? "";

    // First paint: each node enters once.
    expect(nodeClass("a")).toContain("th-activity-gnode--enter");
    expect(nodeClass("c")).toContain("th-activity-gnode--enter");

    // An identical re-render (an elapsed-time tick) changes nothing: the
    // motion classes are sticky, so no animation is removed and re-added
    // (which is what would restart it).
    const classBefore = nodeClass("a");
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    expect(nodeClass("a")).toBe(classBefore);
    expect(nodeClass("c")).toContain("th-activity-gnode--enter");

    // A status transition carries one brief settle; neighbours stay still.
    const completed = makeDag({
      nodes: [
        { id: "a", prompt: "alpha step", dependsOn: [], state: "completed" },
        { id: "b", prompt: "beta step", dependsOn: [], state: "completed" },
        { id: "c", prompt: "gamma step", dependsOn: ["a", "b"], state: "completed" },
      ],
    });
    renderShelf(harness, activityState({ dags: [completed] }));
    expect(nodeClass("c")).toContain("th-activity-gnode--settle");
    expect(nodeClass("a")).not.toContain("th-activity-gnode--settle");
    expect(nodeClass("b")).not.toContain("th-activity-gnode--settle");

    // A genuinely new node enters once; existing nodes do not re-enter.
    const grown = makeDag({
      nodes: [
        ...completed.nodes,
        { id: "d", prompt: "delta step", dependsOn: ["c"], state: "running" },
      ],
      edges: [...completed.edges, { from: "c" as const, to: "d" as const }],
    });
    renderShelf(harness, activityState({ dags: [grown] }));
    expect(nodeClass("d")).toContain("th-activity-gnode--enter");
    expect(nodeClass("a")).not.toContain("th-activity-gnode--settle");
    expect(nodeClass("c")).toContain("th-activity-gnode--settle");
    expect(nodeClass("c")).not.toContain("th-activity-gnode--enter");

    // Leaving an in-progress entry consumes it, even before animationend.
    // Keeping its class on the recreated DOM would restart the CSS animation.
    const fold = requireElement(
      harness.container.querySelector<HTMLButtonElement>("button.th-activity-fold"),
      "fold control",
    );
    click(fold);
    click(fold);
    selectTab(harness.container, "dag");
    expect(nodeClass("d")).not.toContain("th-activity-gnode--enter");
    expect(nodeClass("c")).not.toContain("th-activity-gnode--settle");
  });

  it("keeps run identity and layout stable when a node changes state", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openPanel(harness.container);
    selectTab(harness.container, "dag");
    const before = harness.container.querySelector<SVGGraphicsElement>('.th-activity-gnode[data-node="c"]')?.getAttribute("transform");
    const completed = makeDag({
      nodes: [
        { id: "a", prompt: "alpha step", dependsOn: [], state: "completed" },
        { id: "b", prompt: "beta step", dependsOn: [], state: "completed" },
        { id: "c", prompt: "gamma step", dependsOn: ["a", "b"], state: "completed" },
      ],
    });
    renderShelf(harness, activityState({ dags: [completed] }));
    const node = requireElement(
      harness.container.querySelector('.th-activity-gnode[data-node="c"]'),
      "status-ticked node",
    );
    expect(node.getAttribute("transform")).toBe(before);
    expect(node.getAttribute("data-layer")).toBe("1");
  });

  it("reads node states as text, not colour alone", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openPanel(harness.container);
    selectTab(harness.container, "dag");
    for (const node of harness.container.querySelectorAll(".th-activity-gnode")) {
      expect(node.querySelector(".th-activity-gstate")?.textContent?.length ?? 0).toBeGreaterThan(0);
      expect(node.querySelector("title")?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
    // Edges are directional.
    for (const edge of harness.container.querySelectorAll(".th-activity-gedge")) {
      expect(edge.getAttribute("marker-end")).toMatch(/^url\(#/);
    }
  });

  it("wraps long labels onto two lines instead of blind-truncating at 13 characters", () => {
    const longKorean = "매우 긴 한글 노드 라벨은 두 줄로 표시되어야 합니다";
    renderShelf(harness, activityState({
      dags: [makeDag({
        nodes: [{ id: "k", label: longKorean, prompt: "long korean label", dependsOn: [], state: "running" }],
        waves: [{ index: 0, nodeIds: ["k"] }],
      })],
    }));
    openPanel(harness.container);
    selectTab(harness.container, "dag");
    const lines = [...harness.container.querySelectorAll(".th-activity-gnode[data-node='k'] .th-activity-glabel")];
    expect(lines.length).toBe(2);
    expect(lines.map((line) => line.textContent).join("")).toContain("매우 긴 한글");
  });
});
