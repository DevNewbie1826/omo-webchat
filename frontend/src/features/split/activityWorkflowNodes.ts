import type { ActivityDagRun, ActivityTask } from "./activityTypes";

/**
 * The omo runtime reports workflow children in TWO channels: dag run nodes
 * (always) and omo.task.updated events for children spawned as in-process
 * tasks (observed live: the same child appeared as both a node row and a
 * task row). Project each run's nodes into the agents-section shape so
 * workflow subagents appear when only nodes exist, but drop a node whose
 * taskId already has a task row so a child is never listed twice.
 * A prefix overlapping any task row cannot establish a distinct child:
 * suppress that node and retain the identity uncertainty for count callers.
 */
export function workflowNodeTasks(
  runs: readonly ActivityDagRun[],
  knownTaskIds: ReadonlySet<string> = new Set(),
): { readonly tasks: readonly ActivityTask[]; readonly identityPartial: boolean } {
  let identityPartial = false;
  const tasks = runs.flatMap((run) =>
    run.nodes
      .filter((node) => {
        if (node.taskIdPrefix !== undefined) {
          for (const taskId of knownTaskIds) {
            if (taskId.startsWith(node.taskIdPrefix)) {
              identityPartial = true;
              return false;
            }
          }
        }
        return node.taskId === undefined || !knownTaskIds.has(node.taskId);
      })
      .map((node): ActivityTask => {
      const title = node.label ?? node.prompt;
      const liveProgress
        = node.currentTool !== undefined
          || node.activity !== undefined
          || node.turns !== undefined
          || node.lastAssistantLine !== undefined
          ? {
            ...(node.activity === undefined ? {} : { activity: node.activity }),
            ...(node.currentTool === undefined ? {} : { currentTool: node.currentTool }),
            ...(node.lastAssistantLine === undefined ? {} : { lastAssistantLine: node.lastAssistantLine }),
            ...(node.turns === undefined ? {} : { turns: node.turns }),
          }
          : undefined;
      const createdAt = node.startedAt ?? run.createdAt;
      return {
        taskId: node.taskId ?? `${run.runId}/${node.id}`,
        name: title,
        status: node.state,
        taskSummary: title,
        category: run.name,
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(node.lastActivityAt === undefined ? {} : { updatedAt: node.lastActivityAt }),
        ...(liveProgress === undefined ? {} : { liveProgress }),
      };
      }),
  );
  return { tasks, identityPartial };
}
