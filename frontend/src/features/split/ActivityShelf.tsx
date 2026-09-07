import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useT } from "../../i18n";
import { lifeSeenThisRunOf, runActivityMsByTaskOf } from "./activityState";
import { DagSection, type DagNodeMotion } from "./activityShelfDag";
import {
  agentTimeMs,
  dagTimeMs,
  orderActivities,
  SHELF_TABS,
  TERMINAL_DAG_STATUSES,
  TERMINAL_TASK_STATUSES,
  todoCounts,
  type DagView,
  type ShelfTab,
} from "./activityShelfModel";
import { AgentSection, TodoSection } from "./activityShelfSections";
import { workflowNodeTasks } from "./activityWorkflowNodes";
import type { ActivityState } from "./activityTypes";
import { useShelfAvailableSpace } from "./useShelfAvailableSpace";

export interface ActivityShelfProps {
  readonly activities: ActivityState;
}

const PANEL_MIN = 120;
const PANEL_KEY_STEP = 24;
const PANEL_STORAGE_KEY = "th-activity-panel-height";

/** Mirrors the `.th-activity-panel` max-height cap in activity-shelf.css:
 *  the default content-sized panel never grows past this, with or without
 *  a measured column clamp. */
const PANEL_CONTENT_MAX_PX = 280;

/** Normal content-sized panels keep enough room for a section header and row. */
const PANEL_NATURAL_MIN_PX = 48;

/** Rendered panel content height below which a section header row paints as
 *  half-clipped glyphs at the scrollport edge: below this the headless state
 *  hides the header chrome until the panel has room to show it legibly. The
 *  trigger is the panel's own measured box (ResizeObserver on the panel
 *  element), never the pane height — a roomy panel in a short pane, or a
 *  short split pane with a usable panel, keeps its headers and DAG
 *  List/Graph controls. The column clamp below reserves the panel's target
 *  height in normal use, so only a genuinely crushed panel box (~one
 *  compact row) crosses this. */
const PANEL_HEADLESS_BELOW_PX = 24;

function maxPanelHeight(): number {
  return Math.round(window.innerHeight * 0.6);
}

function tabIdPrefix(tab: ShelfTab, panelId: string): string {
  return `th-activity-tab-${panelId.replace(/[^A-Za-z0-9_-]/g, "")}-${tab}`;
}

function panelElementId(tab: ShelfTab, panelId: string): string {
  return `th-activity-tabpanel-${panelId.replace(/[^A-Za-z0-9_-]/g, "")}-${tab}`;
}

function clampPanelHeight(px: number): number {
  return Math.min(maxPanelHeight(), Math.max(PANEL_MIN, Math.round(px)));
}

function detectPanelHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.max(PANEL_MIN, parsed) : null;
  } catch {
    return null;
  }
}

export function ActivityShelf({ activities }: ActivityShelfProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // Graph is the P6 default; the choice survives tab and fold switches.
  const [view, setView] = useState<DagView>("graph");
  // null = no explicit choice yet: selection derives from availability in
  // user order. Once chosen, new activity never steals the selection.
  const [chosenTab, setChosenTab] = useState<ShelfTab | null>(null);
  const [height, setHeight] = useState<number | null>(() => detectPanelHeight());
  const [resizing, setResizing] = useState(false);
  const [shelfElement, setShelfElement] = useState<HTMLElement | null>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  // Per-node last painted state: the graph motion contract (enter/settle) is
  // decided against this history, so elapsed-time ticks, tab switches and
  // fold reopens replay nothing. Lives at the shelf level, above the panel.
  const nodeHistory = useRef<Map<string, DagNodeMotion>>(new Map<string, DagNodeMotion>());
  // Consume completion/cancellation and explicit graph exits separately from
  // data updates. Hidden or unmounted DOM must never restart a pending class.
  const [motionEpoch, setMotionEpoch] = useState(0);
  const onNodeMotionEnd = useCallback((key: string): void => {
    const motion = nodeHistory.current.get(key);
    if (motion === undefined || (!motion.entering && !motion.settling)) return;
    nodeHistory.current.set(key, { ...motion, entering: false, settling: false });
    setMotionEpoch((epoch) => epoch + 1);
  }, []);
  const consumeGraphMotion = (): void => {
    for (const [key, motion] of nodeHistory.current) {
      if (motion.entering || motion.settling) onNodeMotionEnd(key);
    }
  };
  const changeView = (next: DagView): void => {
    if (next !== view) consumeGraphMotion();
    setView(next);
  };
  // Click activation owns the disclosure: open plus a selected-tab click
  // cancels the open intent (never the retained selection), while any other
  // tab click opens or switches. Keyboard selection below always opens and
  // never routes through this close path, so boundary navigation cannot
  // collapse the panel. The decision reads the open intent, not the expanded
  // allocation, so a click during a clamped-down collapse still closes.
  const activateTab = (tab: ShelfTab): void => {
    if (open && selectedTab === tab) {
      consumeGraphMotion();
      setOpen(false);
      return;
    }
    selectTab(tab);
  };
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

  const availability: Readonly<Record<ShelfTab, boolean>> = {
    todo: activities.todo !== null,
    agents: tasks.length > 0,
    dag: dags.length > 0,
  };
  const selectedTab: ShelfTab = chosenTab
    ?? (SHELF_TABS.find((tab) => availability[tab]) ?? "todo");
  const selectTab = (tab: ShelfTab): void => {
    if (selectedTab === "dag" && tab !== "dag") consumeGraphMotion();
    setOpen(true);
    setChosenTab(tab);
  };
  // Keyboard selection keeps the shared always-opening selectTab: it can
  // open a closed shelf and move selection, but never closes — same-target
  // boundary navigation (Home on the first tab, End on the last) recomputes
  // the selected tab and leaves the panel open.
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const index = SHELF_TABS.indexOf(selectedTab);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % SHELF_TABS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + SHELF_TABS.length - 1) % SHELF_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SHELF_TABS.length - 1;
    const target: ShelfTab | undefined = next === null ? undefined : SHELF_TABS[next];
    if (target === undefined) return;
    event.preventDefault();
    selectTab(target);
    // Roving tabindex moves with the selection; focus follows the key.
    tablistRef.current?.querySelector<HTMLButtonElement>(`[data-activity-tab="${target}"]`)?.focus();
  };
  const tabCount = (tab: ShelfTab): string | null => {
    if (tab === "todo") {
      return activities.todo === null ? null : (() => {
        const { done, total } = todoCounts(activities.todo);
        return `${done}/${total}`;
      })();
    }
    if (tab === "agents") {
      return tasks.length === 0
        ? null
        : `${tasks.filter((task) => task.status === "running").length}/${tasks.length}`;
    }
    if (dags.length === 0) return null;
    const done = dags.reduce((sum, run) => sum + run.counts.completed, 0);
    const total = dags.reduce((sum, run) => sum + run.counts.total, 0);
    return `${done}/${total}`;
  };

  useEffect(() => {
    if (!hasLiveActivity) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasLiveActivity]);

  const setPanelRef = useCallback((panel: HTMLDivElement | null): void => {
    panelRef.current = panel;
    setPanelElement(panel);
  }, []);
  const {
    availableSpacePx: columnClampPx,
    selfPanelHeightPx,
  } = useShelfAvailableSpace(open && hasActivity, shelfElement, panelElement, height);
  const naturalFloorActive = height === null
    && columnClampPx !== null
    && columnClampPx >= PANEL_NATURAL_MIN_PX;
  const headless = selfPanelHeightPx !== null
    && selfPanelHeightPx < PANEL_HEADLESS_BELOW_PX
    && !naturalFloorActive;

  const expanded = open && (columnClampPx === null || columnClampPx >= PANEL_NATURAL_MIN_PX);

  if (!hasActivity) return null;

  const applyHeight = (px: number | null): void => {
    setHeight(px);
    try {
      if (px === null) window.localStorage.removeItem(PANEL_STORAGE_KEY);
      // Explicit resize gestures are viewport-bounded; restoring a preference
      // never truncates it to the current allocation.
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

  const panelMaxPx = columnClampPx === null
    ? null
    : Math.min(
        Math.max(columnClampPx, 0),
        height === null ? PANEL_CONTENT_MAX_PX : maxPanelHeight(),
      );

  return (
    <section
      ref={setShelfElement}
      className="th-activity-shelf"
      // While the column clamp is active the expanded shelf keeps its full
      // height (the inline max-height bounds the panel); flexbox shrink is
      // what crushed it when the transcript ran long.
      style={columnClampPx === null ? undefined : { flexShrink: 0 }}
      data-motion-epoch={motionEpoch}
      // Truthful root state for CSS and QA: open is the disclosure intent,
      // expanded the actual allocated panel. The removed fold button used to
      // carry this; the shelf itself owns it now.
      data-open={open}
      data-expanded={expanded}
    >
      {/* The tab strip is the shelf's permanent chrome: visible while
          collapsed so a tab click opens the panel and selects, and kept as
          its own measured fixed band for the shared column allocator. A
          selected-tab click closes while retaining the selection. */}
      <div ref={tablistRef} role="tablist" aria-label={t("activity.tabs")} className="th-activity-tabs">
        {SHELF_TABS.map((tab) => {
          const count = tabCount(tab);
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              className="th-activity-tab"
              data-activity-tab={tab}
              id={`${tabIdPrefix(tab, panelId)}`}
              aria-selected={selectedTab === tab}
              aria-controls={`${panelElementId(tab, panelId)}`}
              tabIndex={selectedTab === tab ? 0 : -1}
              onClick={() => activateTab(tab)}
              onKeyDown={onTabKeyDown}
            >
              <span className="th-activity-tab-label">{t(tab === "agents" ? "activity.subagents" : `activity.${tab}`)}</span>
              {count !== null && <span className="th-activity-tab-count">{count}</span>}
            </button>
          );
        })}
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
          {expanded && <div
            ref={setPanelRef}
            id={panelId}
            role="group"
            aria-label={t("activity.panel")}
            data-headless={headless ? "true" : undefined}
            className={`th-activity-panel${height === null ? "" : " th-activity-panel--sized"}${resizing ? " th-activity-panel--resizing" : ""}`}
            style={
              height === null && panelMaxPx === null
                ? undefined
                : {
                    ...(height === null ? {} : { height: `${height}px` }),
                    ...(panelMaxPx === null ? {} : { maxHeight: `${panelMaxPx}px` }),
                    ...(naturalFloorActive ? { minHeight: `${PANEL_NATURAL_MIN_PX}px` } : {}),
                  }
            }
          >
            {SHELF_TABS.map((tab) => (
              <div
                key={tab}
                role="tabpanel"
                data-activity-tabpanel={tab}
                id={panelElementId(tab, panelId)}
                aria-labelledby={tabIdPrefix(tab, panelId)}
                hidden={selectedTab !== tab}
                className={`th-activity-tabpanel th-activity-tabpanel--${tab}`}
              >
                {tab === "todo" && (activities.todo !== null
                  ? <TodoSection phases={activities.todo} t={t} />
                  : <p className="th-activity-empty">{t("activity.emptyTodo")}</p>)}
                {tab === "agents" && (tasks.length > 0
                  ? <AgentSection
                      tasks={tasks}
                      nowMs={nowMs}
                      freshnessCtx={{
                        runInFlight: activities.runInFlight === true,
                        lifeSeenThisRun: lifeSeenThisRunOf(activities),
                        runActivityMsByTask: runActivityMsByTaskOf(activities),
                      }}
                      t={t}
                    />
                  : <p className="th-activity-empty">{t("activity.emptyAgents")}</p>)}
                {tab === "agents" && activities.truncatedTasks === true
                  && <p className="th-activity-partial">{t("activity.partial")}</p>}
                {tab === "dag" && (dags.length > 0
                  ? <DagSection dags={dags} active={selectedTab === "dag"} t={t} view={view} onViewChange={changeView} clipIdPrefix={panelId.replace(/[^A-Za-z0-9_-]/g, "")} nodeHistory={nodeHistory} onMotionEnd={onNodeMotionEnd} />
                  : <p className="th-activity-empty">{t("activity.emptyDag")}</p>)}
                {tab === "dag" && activities.truncatedDags === true
                  && <p className="th-activity-partial">{t("activity.partial")}</p>}
              </div>
            ))}
          </div>}
        </>
      )}
    </section>
  );
}
