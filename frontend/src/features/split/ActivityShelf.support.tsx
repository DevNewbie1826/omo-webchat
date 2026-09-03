import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ActivityDagRun, ActivityState, ActivityTask, TodoPhase } from "./activityTypes";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { ActivityShelf } from "./ActivityShelf";

const now = Date.now();
export const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

export function makeTask(overrides: Partial<ActivityTask> = {}): ActivityTask {
  return {
    taskId: "t1",
    name: "Spawned agent",
    status: "running",
    createdAt: iso(180_000),
    updatedAt: iso(5_000),
    liveProgress: { currentTool: "ripgrep", turns: 4 },
    ...overrides,
  };
}

export function makeDag(overrides: Partial<ActivityDagRun> = {}): ActivityDagRun {
  return {
    runId: "r1",
    runKey: "plan",
    name: "Ship",
    status: "running",
    counts: {
      total: 3,
      pending: 0,
      blocked: 0,
      scheduled: 0,
      running: 1,
      completed: 2,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    nodes: [
      { id: "a", prompt: "alpha step", dependsOn: [], state: "completed" },
      { id: "b", prompt: "beta step", dependsOn: [], state: "completed" },
      { id: "c", prompt: "gamma step", dependsOn: ["a", "b"], state: "running" },
    ],
    edges: [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ],
    waves: [],
    ...overrides,
  };
}

export function activityState(
  parts: {
    readonly tasks?: readonly ActivityTask[];
    readonly dags?: readonly ActivityDagRun[];
    readonly todo?: readonly TodoPhase[];
    readonly truncatedTasks?: boolean;
    readonly truncatedDags?: boolean;
  } = {},
): ActivityState {
  return {
    tasks: new Map((parts.tasks ?? []).map((task): readonly [string, ActivityTask] => [task.taskId, task])),
    dags: new Map((parts.dags ?? []).map((run): readonly [string, ActivityDagRun] => [run.runId, run])),
    todo: parts.todo ?? null,
    heartbeats: new Map(),
    ...(parts.truncatedTasks === undefined ? {} : { truncatedTasks: parts.truncatedTasks }),
    ...(parts.truncatedDags === undefined ? {} : { truncatedDags: parts.truncatedDags }),
  };
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function openShelf(container: ParentNode): HTMLButtonElement {
  const bar = requireElement(
    container.querySelector<HTMLButtonElement>(".th-activity-bar"),
    "collapsed summary bar",
  );
  click(bar);
  return bar;
}

/** Mutable React mount — mutation is the fixture purpose. */
export type ActivityShelfHarness = {
  readonly root: Root;
  readonly container: HTMLDivElement;
};

export function mountActivityShelf(): ActivityShelfHarness {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { root: createRoot(container), container };
}

export async function unmountActivityShelf(harness: ActivityShelfHarness): Promise<void> {
  await act(async () => {
    harness.root.unmount();
  });
  harness.container.remove();
  vi.unstubAllGlobals();
}

export function renderShelf(harness: ActivityShelfHarness, activities: ActivityState): void {
  act(() => {
    harness.root.render(
      <I18nContext.Provider value={i18n}>
        <ActivityShelf activities={activities} />
      </I18nContext.Provider>,
    );
  });
}
