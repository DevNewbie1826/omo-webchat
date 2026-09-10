import { useEffect, useRef, useState, type ComponentProps } from "react";
import { DAG_STATES } from "./activityCompleteParse";
import { DagSection } from "./activityShelfDag";
import { statusLabel, type DagView } from "./activityShelfModel";
import type { ActivityState } from "./activityTypes";
import { useCompleteDagRun, type CompleteDagRow, type useCompleteDag } from "./useCompleteDag";

type CompleteDagSectionProps = Omit<ComponentProps<typeof DagSection>, "dags"> & {
  readonly data: ReturnType<typeof useCompleteDag>;
  readonly activities: ActivityState;
};

/** One newest-first list row: header (name, status chip, done/total), its own
 *  graph/list toggle, and expandable full details. The row owns retrieval for
 *  its run; graphs paint only from an accepted full original document, never
 *  from a truncated live summary. */
function CompleteDagRunRow({ row, index, base, active, connected, activities, facts, retryEpoch,
  panelActive, view, onViewChange, clipIdPrefix, nodeHistory, onMotionEnd, t }: {
  readonly row: CompleteDagRow;
  readonly index: number;
  readonly base: string;
  readonly active: boolean;
  readonly connected: boolean;
  readonly activities: ActivityState;
  readonly facts: ReturnType<typeof useCompleteDag>["runScope"]["facts"];
  readonly retryEpoch: number;
  readonly panelActive: boolean;
  readonly view: DagView;
  readonly onViewChange: (runId: string, view: DagView) => void;
  readonly clipIdPrefix: string;
  readonly nodeHistory: ComponentProps<typeof DagSection>["nodeHistory"];
  readonly onMotionEnd: ComponentProps<typeof DagSection>["onMotionEnd"];
  readonly t: ComponentProps<typeof DagSection>["t"];
}) {
  useCompleteDagRun(base, active, row.entry.runId, connected, activities, facts, retryEpoch);
  const run = row.run;
  return (
    <article className="th-activity-dag-run" data-activity-dag-run={row.entry.runId}
      data-activity-dag-status={row.status} data-content-token={run === null ? undefined : row.contentToken}>
      {run === null
        ? <p className="th-activity-dag-freshness" role={row.error ? "alert" : "status"}>
            {row.entry.name} - {t(`activity.dagFull.${row.status}`)}
          </p>
        : <>
          <DagSection
            t={t}
            dags={[run]}
            view={view}
            onViewChange={(next) => onViewChange(row.entry.runId, next)}
            active={panelActive && row.status === "complete"}
            // Positional per-row prefix keeps clip/marker ids unique across
            // rows; run and node ids are free-form and unsafe in url(#…).
            clipIdPrefix={`${clipIdPrefix}-${index}`}
            nodeHistory={nodeHistory}
            onMotionEnd={onMotionEnd}
          />
          {row.status !== "complete" && <p className="th-activity-dag-freshness" role={row.error ? "alert" : "status"}>{t(`activity.dagFull.${row.status}`)}</p>}
          <details className="th-activity-dag-details" data-activity-dag-total={run.counts.total}>
            <summary>{t("activity.dagDetails", { total: run.counts.total })}</summary>
            <dl className="th-activity-dag-state-counts">
              {DAG_STATES.map(state => <div key={state} data-activity-dag-count={state} data-count={run.counts[state]}>
                <dt>{statusLabel(t, state)}</dt><dd>{run.counts[state]}</dd>
              </div>)}
            </dl>
            {run.nodes.map(node => <details key={node.id} className="th-activity-dag-node-detail" data-activity-dag-node={node.id}>
              <summary>{node.label ?? node.id} - {statusLabel(t, node.state)}</summary>
              <dl>
                <dt>{t("activity.dagNodeId")}</dt><dd>{node.id}</dd>
                <dt>{t("activity.dagDependencies")}</dt><dd>{node.dependsOn.length === 0 ? t("activity.dagNoDependencies") : node.dependsOn.map((id, index) => <div key={index}>{id}</div>)}</dd>
                {node.taskId !== undefined && <><dt>{t("activity.dagTaskId")}</dt><dd>{node.taskId}</dd></>}
                {node.attempt !== undefined && <><dt>{t("activity.dagAttempt")}</dt><dd data-activity-dag-attempt>{node.attempt}</dd></>}
                {node.startedAt !== undefined && <><dt>{t("activity.dagStarted")}</dt><dd>{node.startedAt}</dd></>}
                {node.completedAt !== undefined && <><dt>{t("activity.dagCompleted")}</dt><dd>{node.completedAt}</dd></>}
              </dl>
              <p className="th-activity-dag-prompt" data-activity-dag-prompt>{node.prompt}</p>
              {(node.currentTool || node.activity || node.lastAssistantLine) && <p className="th-activity-dag-prompt" data-activity-dag-progress>{[node.activity, node.currentTool, node.lastAssistantLine].filter(Boolean).join("\n")}</p>}
            </details>)}
          </details>
        </>}
    </article>
  );
}

/** The sentinel's real scrollport: the nearest ancestor whose overflow
 *  clips vertically (the DAG tabpanel). Judging the sentinel's intersection
 *  against that container — not the viewport — ties the report to where the
 *  sentinel sits inside the scrolling list alone; its place in the page
 *  cannot mask a flush scroll. The shorthand is read because some layout
 *  engines expose `overflow` but not its `overflow-y` longhand; a non-visible
 *  shorthand always implies a clipping longhand in engines that expose both. */
function scrollportOf(target: Element): Element | null {
  for (let node = target.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clips = style.overflowY === "auto" || style.overflowY === "scroll"
      || style.overflow === "auto" || style.overflow === "scroll";
    if (clips) return node;
  }
  return null;
}

export function CompleteDagSection({ data, activities, ...props }: CompleteDagSectionProps) {
  const { t } = props;
  // The graph/list choice is per run and starts from the shelf's view; once a
  // run is toggled it keeps its own choice for the rest of the session.
  const [runViews, setRunViews] = useState<Readonly<Record<string, DagView>>>({});
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMore = data.hasMore;
  const rowCount = data.rows.length;
  // Continuation arms only from the settled list end: every visible row
  // must be an authorized, terminal row of the current catalog walk — a
  // full document OR a terminal error/stale card whose original read has
  // concluded. A loading placeholder's height is provisional, so a
  // sentinel intersection over placeholders is a layout artifact — never
  // a user's arrival at the end — and must not consume the next page;
  // but one failed original must not bar older runs from loading either.
  const settled = data.catalogStatus === "ready" && rowCount > 0
    && data.rows.every(row => row.authorized && (row.run !== null || row.error));
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!hasMore || !settled || sentinel === null || typeof IntersectionObserver === "undefined") return;
    // The sentinel must intersect the real scrollport at the real list
    // bottom: its shipped min-height keeps the empty box a non-zero layout
    // box (a zero-height target never intersects, even flush inside the
    // clip), and the observer root is the tabpanel scrollport itself.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) data.loadMore();
    }, { root: scrollportOf(sentinel) });
    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-observing after each append lets a still-visible sentinel deliver a
    // fresh initial entry, continuing the scroll without a pointer gesture —
    // but only once the appended rows have settled into their real layout.
  }, [hasMore, settled, rowCount, data.loadMore]);
  return (
    <section className="th-activity-dag-complete" data-activity-dag-catalog={data.catalogStatus}>
      <div className="th-activity-dag-toolbar">
        <button type="button" className="th-activity-view-btn" data-activity-dag-retry onClick={data.retry}>{t("activity.dagRefresh")}</button>
      </div>
      {data.catalogStatus === "loading" && <p className="th-activity-dag-freshness" role="status">{t("activity.dagCatalogLoading")}</p>}
      {data.catalogStatus === "error" && <p className="th-activity-dag-freshness" role="alert">{t("activity.dagCatalogError")}</p>}
      {data.catalogStatus === "empty" && <p className="th-activity-empty">{t("activity.emptyDag")}</p>}
      {data.rows.map((row, index) => (
        <CompleteDagRunRow key={row.entry.runId} row={row} index={index}
          base={data.runScope.base} active={data.runScope.active && row.authorized} connected={data.runScope.connected}
          facts={data.runScope.facts} retryEpoch={data.runScope.retryEpoch}
          activities={activities} panelActive={props.active}
          view={runViews[row.entry.runId] ?? props.view}
          onViewChange={(runId, view) => setRunViews(previous =>
            previous[runId] === view ? previous : { ...previous, [runId]: view })}
          clipIdPrefix={props.clipIdPrefix} nodeHistory={props.nodeHistory} onMotionEnd={props.onMotionEnd}
          t={t}
        />
      ))}
      {data.loadingMore && <p className="th-activity-dag-freshness" role="status">{t("activity.dagCatalogLoading")}</p>}
      {hasMore && <div ref={sentinelRef} className="th-activity-dag-freshness th-activity-dag-sentinel" data-activity-dag-sentinel />}
    </section>
  );
}
