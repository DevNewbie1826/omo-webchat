import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate } from "../../i18n";
import type { LifeLatchedActivityState } from "./activityState";
import {
  activityState,
  iso,
  makeDag,
  makeTask,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { ActivityShelf } from "./ActivityShelf";
import type { ActivityTask } from "./activityTypes";

/** Renders the interpolation vars for the keys under test; keys otherwise. */
const formatVarsT = (key: string, vars?: Readonly<Record<string, string | number>>): string => {
  if (key === "activity.tokensPerSecond") return `${String(vars?.["n"])} tok/s`;
  if (key === "activity.agentCounts") return `${String(vars?.["running"])} running / ${String(vars?.["done"])} done`;
  return key;
};

describe("ActivityShelf", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
    vi.useRealTimers();
  });

  it("orders agents and DAGs live-first with newest starts within each group", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [
          makeTask({ taskId: "completed-old", name: "Completed old", status: "completed", createdAt: iso(300_000) }),
          makeTask({ taskId: "running-old", name: "Running old", createdAt: iso(200_000) }),
          makeTask({ taskId: "completed-new", name: "Completed new", status: "completed", createdAt: iso(100_000) }),
          makeTask({ taskId: "running-new", name: "Running new", createdAt: iso(50_000) }),
        ],
        dags: [
          makeDag({ runId: "dag-completed-old", name: "DAG completed old", status: "completed", createdAt: iso(300_000) }),
          makeDag({ runId: "dag-running-old", name: "DAG running old", createdAt: iso(200_000) }),
          makeDag({ runId: "dag-completed-new", name: "DAG completed new", status: "completed", createdAt: iso(100_000) }),
          makeDag({ runId: "dag-running-new", name: "DAG running new", createdAt: iso(50_000) }),
        ],
      }),
    );
    openShelf(harness.container);

    const agentNames = [...harness.container.querySelectorAll(".th-activity-agent-name")].map((row) => row.textContent);
    // Workflow node children share the agents list (live-first, newest start
    // first, ties keep task rows ahead of node rows): each fixture dag has
    // alpha/beta completed and gamma running, so gamma rides the live group
    // with its run's start time while alpha/beta land in the terminal group.
    expect(agentNames).toEqual([
      "Running new",
      "(DAG running new) - gamma step",
      "(DAG completed new) - gamma step",
      "Running old",
      "(DAG running old) - gamma step",
      "(DAG completed old) - gamma step",
      "(DAG running new) - alpha step",
      "(DAG running new) - beta step",
      "Completed new",
      "(DAG completed new) - alpha step",
      "(DAG completed new) - beta step",
      "(DAG running old) - alpha step",
      "(DAG running old) - beta step",
      "Completed old",
      "(DAG completed old) - alpha step",
      "(DAG completed old) - beta step",
    ]);
    const dagNames = [...harness.container.querySelectorAll(".th-activity-dag-name")].map((row) => row.textContent);
    expect(dagNames).toEqual(["DAG running new", "DAG running old", "DAG completed new", "DAG completed old"]);
  });

  it("shows agent rows with summary name, status chip, current tool, turns and last activity", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask({ taskSummary: "Survey the repo", liveProgress: { currentTool: "ripgrep", turns: 7 } })],
      }),
    );
    openShelf(harness.container);
    const row = requireElement(harness.container.querySelector(".th-activity-agent"), "agent row");
    expect(row.textContent).toContain("Survey the repo");
    expect(row.textContent).toContain("ripgrep");
    expect(row.textContent).toContain("activity.turns");
    expect(row.textContent).toContain("activity.startedAgo");
    expect(row.textContent).toContain("activity.status.running");
  });

  it("prefixes agent rows with their route and omits it when absent", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [
          makeTask({ taskId: "routed", agentType: "explore", taskSummary: "Survey the repo" }),
          makeTask({ taskId: "unrouted", name: "Plain agent", taskSummary: "No route" }),
        ],
      }),
    );
    openShelf(harness.container);
    const names = [...harness.container.querySelectorAll(".th-activity-agent-name")];
    expect(names[0]?.textContent).toContain("(explore) - Survey the repo");
    expect(names[1]?.textContent).not.toContain("(");
  });

  it("labels terminal agents with start time too", () => {
    renderShelf(
      harness,
      activityState({
        tasks: [makeTask(), makeTask({ taskId: "done", status: "completed" })],
      }),
    );
    openShelf(harness.container);
    const doneRow = [...harness.container.querySelectorAll(".th-activity-agent")].find((row) =>
      row.textContent?.includes("activity.status.completed"));
    expect(doneRow).toBeDefined();
    expect(doneRow?.textContent).toContain("activity.startedAgo");
    expect(doneRow?.textContent).not.toContain("activity.completedAgo");
  });

  it("renders quiet agents without any alarm class, only a muted last-update note", () => {
    const tasks = (): readonly ActivityTask[] => [
      makeTask({ taskId: "fresh" }),
      makeTask({ taskId: "stale", updatedAt: iso(45_000) }),
    ];
    renderShelf(harness, activityState({ tasks: tasks() }));
    openShelf(harness.container);
    // Idle pane: no alarm classes and no age notes at all.
    expect(harness.container.querySelectorAll(".th-activity-stale, .th-activity-severed").length).toBe(0);
    expect(harness.container.querySelectorAll(".th-activity-quiet-note").length).toBe(0);

    renderShelf(harness, { ...activityState({ tasks: tasks() }), runInFlight: true });
    // The stale alarm is gone; quiet rows carry only a muted info note.
    expect(harness.container.querySelectorAll(".th-activity-stale, .th-activity-severed").length).toBe(0);
    const quietRows = harness.container.querySelectorAll(".th-activity-quiet-note");
    expect(quietRows.length).toBe(2);
    expect(quietRows[0]?.textContent).toContain("activity.lastUpdateAgo");
  });

  it("shows a 120s-quiet agent without life this run as quiet, never severed", () => {
    renderShelf(
      harness,
      {
        ...activityState({ tasks: [makeTask({ taskId: "gone-quiet", updatedAt: iso(120_000) })] }),
        runInFlight: true,
      },
    );
    openShelf(harness.container);
    expect(harness.container.querySelectorAll(".th-activity-severed").length).toBe(0);
    expect(harness.container.querySelectorAll(".th-activity-stale").length).toBe(0);
    const row = requireElement(harness.container.querySelector(".th-activity-agent"), "agent row");
    expect(row.textContent).toContain("activity.lastUpdateAgo");
    expect(row.textContent).not.toContain("activity.severed");
  });

  it("still severs an agent that showed life this run after 90s of quiet", () => {
    const state: LifeLatchedActivityState = {
      ...activityState({ tasks: [makeTask({ taskId: "gone-quiet", updatedAt: iso(120_000) })] }),
      runInFlight: true,
      lifeSeenThisRun: new Set(["gone-quiet"]),
    };
    renderShelf(harness, state);
    openShelf(harness.container);
    const severedRows = harness.container.querySelectorAll(".th-activity-severed");
    expect(severedRows.length).toBe(1);
    expect(severedRows[0]?.textContent).toContain("activity.severed");
    expect(requireElement(
      harness.container.querySelector(".th-activity-severed-note"),
      "severed note",
    ).textContent).toContain("activity.severed");
    // Severed rows show the alarm, not the quiet info note.
    expect(severedRows[0]?.textContent).not.toContain("activity.lastUpdateAgo");
  });

  it("renders the quiet note localized for the active locale", () => {
    const localized = (lang: "ko" | "en"): void => {
      act(() => {
        harness.root.render(
          <I18nContext.Provider
            value={{ ...i18n, lang, t: (key, vars) => translate(lang, key, vars) }}
          >
            <ActivityShelf
              activities={{
                ...activityState({ tasks: [makeTask({ taskId: "quiet", updatedAt: iso(45_000) })] }),
                runInFlight: true,
              }}
            />
          </I18nContext.Provider>,
        );
      });
      // The component instance persists across re-renders: only the first
      // locale render needs the shelf opened.
      if (harness.container.querySelector(".th-activity-panel") === null) openShelf(harness.container);
      const note = requireElement(
        harness.container.querySelector(".th-activity-quiet-note"),
        "quiet note",
      );
      expect(note.textContent).toBe(lang === "ko" ? "마지막 업데이트 45s 전" : "last update 45s ago");
    };

    localized("ko");
    localized("en");
  });

  it("renders the last assistant line, a compact tok/s rate, and the tool call count", () => {
    act(() => {
      harness.root.render(
        <I18nContext.Provider value={{ ...i18n, t: formatVarsT }}>
          <ActivityShelf
            activities={activityState({
              tasks: [
                makeTask({
                  liveProgress: {
                    currentTool: "ripgrep",
                    turns: 4,
                    lastAssistantLine: "Patching useChatSession.ts",
                    tokensPerSecond: 6589,
                    toolCalls: 12,
                  },
                }),
              ],
            })}
          />
        </I18nContext.Provider>,
      );
    });
    openShelf(harness.container);
    const row = requireElement(harness.container.querySelector(".th-activity-agent"), "agent row");
    const lastLine = requireElement(
      row.querySelector(".th-activity-agent-lastline"),
      "last assistant line",
    );
    expect(lastLine.textContent).toBe("Patching useChatSession.ts");
    expect(row.textContent).toContain("6.6k tok/s");
    expect(row.textContent).toContain("activity.toolCalls");
    expect(row.textContent).toContain("12");
  });

  it("omits the live progress fields the stream has not provided", () => {
    renderShelf(harness, activityState({ tasks: [makeTask()] }));
    openShelf(harness.container);
    const row = requireElement(harness.container.querySelector(".th-activity-agent"), "agent row");
    expect(row.querySelector(".th-activity-agent-lastline")).toBeNull();
    expect(row.textContent).not.toContain("tok/s");
    expect(row.textContent).not.toContain("activity.toolCalls");
  });

  it("shows running and done roster counts in the agents section header", () => {
    act(() => {
      harness.root.render(
        <I18nContext.Provider value={{ ...i18n, t: formatVarsT }}>
          <ActivityShelf
            activities={activityState({
              tasks: [
                makeTask({ taskId: "a" }),
                makeTask({ taskId: "b", updatedAt: iso(45_000) }),
                makeTask({ taskId: "pending", status: "pending" }),
                makeTask({ taskId: "c", status: "completed" }),
                makeTask({ taskId: "d", status: "failed" }),
                makeTask({ taskId: "cancelled", status: "cancelled" }),
              ],
            })}
          />
        </I18nContext.Provider>,
      );
    });
    openShelf(harness.container);
    const counts = requireElement(
      harness.container.querySelector(".th-activity-section-counts"),
      "agents roster counts",
    );
    expect(counts.textContent).toBe("2 running / 3 done");
  });

  it("advances live ages once per second and stops ticking after work becomes terminal", () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(new Date(startedAt.getTime() + 5_000));
    const liveTask = makeTask({
      createdAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      liveProgress: {},
    });
    const renderWithStatus = (status: string): void => {
      act(() => {
        harness.root.render(
          <I18nContext.Provider
            value={{
              ...i18n,
              t: (key, vars) => key === "activity.startedAgo" ? String(vars?.["n"]) : key,
            }}
          >
            <ActivityShelf activities={activityState({ tasks: [{ ...liveTask, status }] })} />
          </I18nContext.Provider>,
        );
      });
    };

    renderWithStatus("running");
    openShelf(harness.container);
    const age = (): string | null =>
      harness.container.querySelector(".th-activity-agent-meta")?.textContent ?? null;
    expect(age()).toBe("5s");
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(2_000));
    expect(age()).toBe("7s");

    renderWithStatus("completed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
