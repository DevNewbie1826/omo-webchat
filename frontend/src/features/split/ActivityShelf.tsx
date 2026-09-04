import { useEffect, useId, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import { IconChevron } from "../../components/icons";
import { useT } from "../../i18n";
import { lifeSeenThisRunOf, runActivityMsByTaskOf } from "./activityState";
import { DagSection } from "./activityShelfDag";
import {
  agentTimeMs,
  dagTimeMs,
  orderActivities,
  TERMINAL_DAG_STATUSES,
  TERMINAL_TASK_STATUSES,
  todoCounts,
  type DagView,
} from "./activityShelfModel";
import { AgentSection, TodoSection } from "./activityShelfSections";
import { workflowNodeTasks } from "./activityWorkflowNodes";
import type { ActivityState } from "./activityTypes";

export interface ActivityShelfProps {
  readonly activities: ActivityState;
}

/** Summary segments join through this one separator so the " · " gap stays
 *  symmetric by construction (same convention as ToolCard's .th-tool-sep). */
function BarSeparator(): ReactElement {
  return (
    <>
      {" "}
      <span className="th-activity-bar-sep" aria-hidden="true">
        {"·"}
      </span>
      {" "}
    </>
  );
}

const PANEL_MIN = 120;
const PANEL_KEY_STEP = 24;
const PANEL_STORAGE_KEY = "th-activity-panel-height";

/** Rendered panel content height below which a section header row paints as
 *  half-clipped glyphs at the scrollport edge: below this the headless state
 *  hides the header chrome until the panel has room to show it legibly. The
 *  trigger is the panel's own measured box (ResizeObserver on the panel
 *  element), never the pane height — a roomy panel in a short pane, or a
 *  short split pane with a usable panel, keeps its headers and DAG
 *  List/Graph controls. */
const PANEL_HEADLESS_BELOW_PX = 40;

function maxPanelHeight(): number {
  return Math.round(window.innerHeight * 0.6);
}

function clampPanelHeight(px: number): number {
  return Math.min(maxPanelHeight(), Math.max(PANEL_MIN, Math.round(px)));
}

function detectPanelHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampPanelHeight(parsed) : null;
  } catch {
    return null;
  }
}

export function ActivityShelf({ activities }: ActivityShelfProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<DagView>("list");
  const [height, setHeight] = useState<number | null>(() => detectPanelHeight());
  const [resizing, setResizing] = useState(false);
  const [headless, setHeadless] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const [nowMs, setNowMs] = useState(Date.now);
  const taskRows = [...activities.tasks.values()];
  const tasks = orderActivities(
    [...taskRows, ...workflowNodeTasks([...activities.dags.values()], new Set(taskRows.map((task) => task.taskId)))],
    (task) => TERMINAL_TASK_STATUSES.has(task.status),
    agentTimeMs,
  );
  const dags = orderActivities(
    [...activities.dags.values()],
    (run) => TERMINAL_DAG_STATUSES.has(run.status),
    dagTimeMs,
  );
  // The shelf is the transcript's record of agent and DAG work: finished
  // entries stay mounted (sorted behind live ones) instead of vanishing the
  // moment everything turns terminal. It hides only when there is genuinely
  // nothing to show, including no marker for omitted historical rows.
  const historyPartial = activities.truncatedTasks === true || activities.truncatedDags === true;
  const hasActivity = activities.todo !== null || tasks.length > 0 || dags.length > 0 || historyPartial;
  const hasLiveActivity = tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))
    || dags.some((run) => !TERMINAL_DAG_STATUSES.has(run.status));

  useEffect(() => {
    if (!hasLiveActivity) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasLiveActivity]);

  // Headless measurement: watch the expanded panel's rendered content height
  // and toggle data-headless around PANEL_HEADLESS_BELOW_PX. Environments
  // without ResizeObserver (old jsdom) simply never enter the headless state.
  // The panel element exists exactly while open && hasActivity (the component
  // returns null without unmounting when the activity empties), so both belong
  // in the deps: each re-run disconnects the observer bound to the previous
  // element — resetting headless — and, once a panel is back, observes the
  // CURRENT one. An observer must never outlive its element.
  useEffect(() => {
    if (!open || !hasActivity) {
      setHeadless(false);
      return undefined;
    }
    const panel = panelRef.current;
    if (panel === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setHeadless(entry.contentRect.height < PANEL_HEADLESS_BELOW_PX);
    });
    observer.observe(panel);
    return () => {
      observer.disconnect();
      setHeadless(false);
    };
  }, [open, hasActivity]);

  if (!hasActivity) return null;

  const applyHeight = (px: number | null): void => {
    setHeight(px);
    try {
      if (px === null) window.localStorage.removeItem(PANEL_STORAGE_KEY);
      // Re-clamp against the live viewport at save time so a height stored
      // here can never exceed the current window (restore re-clamps too).
      else window.localStorage.setItem(PANEL_STORAGE_KEY, String(clampPanelHeight(px)));
    } catch {
      // Private modes may throw; the choice simply will not persist.
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const startHeight = height ?? panel.getBoundingClientRect().height;
    const startY = event.clientY;
    setResizing(true);
    const move = (pointerEvent: PointerEvent): void => {
      applyHeight(clampPanelHeight(startHeight + (startY - pointerEvent.clientY)));
    };
    const up = (): void => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setResizing(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const onKeyResize = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = height ?? panelRef.current?.getBoundingClientRect().height ?? PANEL_MIN;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      applyHeight(clampPanelHeight(current + PANEL_KEY_STEP));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      applyHeight(clampPanelHeight(current - PANEL_KEY_STEP));
    } else if (event.key === "Home") {
      event.preventDefault();
      applyHeight(PANEL_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      applyHeight(maxPanelHeight());
    }
  };

  const segments: string[] = [];
  if (activities.todo !== null) {
    segments.push(t("activity.summaryTodo", todoCounts(activities.todo)));
  }
  if (tasks.length > 0) {
    segments.push(t("activity.summaryAgents", {
      running: tasks.filter((task) => task.status === "running").length,
    }));
  }
  if (dags.length > 0) {
    segments.push(t("activity.summaryDag", {
      running: dags.reduce((sum, run) => sum + run.counts.running, 0),
      done: dags.reduce((sum, run) => sum + run.counts.completed, 0),
    }));
  }

  return (
    <section className="th-activity-shelf">
      <div className="th-activity-bar-row" role="status">
        <button
          type="button"
          className="th-activity-bar"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="th-activity-bar-text">
            {segments.map((segment, index) => (
              <span key={segment} className="th-activity-bar-seg">
                {index > 0 && <BarSeparator />}
                {segment}
              </span>
            ))}
            {historyPartial && (
              <span className="th-activity-bar-seg">
                {segments.length > 0 && <BarSeparator />}
                <span className="th-activity-partial">{t("activity.partial")}</span>
              </span>
            )}
          </span>
          <IconChevron
            size={12}
            className={`th-activity-caret${open ? " th-activity-caret--open" : ""}`}
          />
        </button>
      </div>
      {open && (
        <>
          <div
            className="th-activity-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("activity.resize")}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={maxPanelHeight()}
            aria-valuenow={height ?? undefined}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={onKeyResize}
            onDoubleClick={() => applyHeight(null)}
          />
          <div
            ref={panelRef}
            id={panelId}
            role="group"
            aria-label={t("activity.panel")}
            data-headless={headless ? "true" : undefined}
            className={`th-activity-panel${height === null ? "" : " th-activity-panel--sized"}${resizing ? " th-activity-panel--resizing" : ""}`}
            style={height === null ? undefined : { height: `${height}px` }}
          >
            {tasks.length > 0 && (
              <AgentSection
                tasks={tasks}
                nowMs={nowMs}
                freshnessCtx={{
                  runInFlight: activities.runInFlight === true,
                  lifeSeenThisRun: lifeSeenThisRunOf(activities),
                  runActivityMsByTask: runActivityMsByTaskOf(activities),
                }}
                t={t}
              />
            )}
            {dags.length > 0 && (
              <DagSection dags={dags} t={t} view={view} onViewChange={setView} clipIdPrefix={panelId.replace(/[^A-Za-z0-9_-]/g, "")} />
            )}
            {activities.todo !== null && <TodoSection phases={activities.todo} t={t} />}
          </div>
        </>
      )}
    </section>
  );
}
