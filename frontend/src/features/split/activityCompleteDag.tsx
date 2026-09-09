import type { ComponentProps } from "react";
import { DAG_STATES } from "./activityCompleteParse";
import { DagSection } from "./activityShelfDag";
import { statusLabel } from "./activityShelfModel";
import type { ActivityState } from "./activityTypes";
import type { useCompleteDag } from "./useCompleteDag";

type CompleteDagSectionProps = Omit<ComponentProps<typeof DagSection>, "dags"> & {
  readonly data: ReturnType<typeof useCompleteDag>;
  readonly activities: ActivityState;
};

export function CompleteDagSection({ data, activities, ...props }: CompleteDagSectionProps) {
  const { t } = props;
  const run = data.run;
  const options = data.catalog.some(entry => entry.runId === data.selected) || data.selected === null
    ? data.catalog : [{ runId: data.selected, name: activities.dags.get(data.selected)?.name ?? data.selected, contentToken: "" }, ...data.catalog];
  return (
    <section className="th-activity-dag-complete" data-activity-dag-status={data.status} data-content-token={data.contentToken}>
      <div className="th-activity-dag-picker">
        <label>
          <span>{t("activity.dagSelect")}</span>
          <select data-activity-dag-select value={data.selected ?? ""} onChange={event => data.select(event.target.value)} disabled={options.length === 0}>
            {options.map(entry => <option key={entry.runId} value={entry.runId}>{entry.name} ({entry.runId})</option>)}
          </select>
        </label>
        <button type="button" className="th-activity-view-btn" data-activity-dag-retry onClick={data.retry}>{t("activity.dagRefresh")}</button>
      </div>
      <p className="th-activity-dag-freshness" role={data.error ? "alert" : "status"}>
        {data.status === "empty" ? t("activity.emptyDag") : t(`activity.dagFull.${data.status}`)}
      </p>
      {data.catalogLoading && <p className="th-activity-dag-freshness" role="status">{t("activity.dagCatalogLoading")}</p>}
      {data.catalogError && <p className="th-activity-dag-freshness" role="alert">{t("activity.dagCatalogError")}</p>}
      {run !== null && <>
        <DagSection {...props} active={props.active && data.status === "complete"} dags={[run]} />
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
    </section>
  );
}
