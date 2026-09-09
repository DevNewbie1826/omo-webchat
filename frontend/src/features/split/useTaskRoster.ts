import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";
import { parseTaskUpdated } from "./activityParseTask";
import type { ActivityTask } from "./activityTypes";
import type { DagSource } from "./useCompleteDag";

export type TaskRosterStatus = "idle" | "loading" | "ready" | "error";

export function useTaskRoster(source: DagSource | undefined, active: boolean) {
  const base = source === undefined
    ? ""
    : `/api/workspaces/${encodeURIComponent(source.wsId)}/chats/${encodeURIComponent(source.chatId)}/tasks`;
  const connected = source?.connected === true;
  const enabled = active && Boolean(base) && connected;
  const [binding, setBinding] = useState(base);
  const [tasks, setTasks] = useState<readonly ActivityTask[]>([]);
  const [status, setStatus] = useState<TaskRosterStatus>("idle");
  const [retryEpoch, setRetryEpoch] = useState(0);

  if (binding !== base) {
    setBinding(base);
    setTasks([]);
    setStatus("idle");
  }

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setStatus("loading");
    void apiJson<unknown>(base, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      const parsed = parseTaskUpdated(value);
      if (parsed === null || parsed.truncatedTasks === true) {
        setTasks([]);
        setStatus("error");
        return;
      }
      setTasks(parsed.tasks);
      setStatus("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof Error) setStatus("error");
      else throw error;
    });
    return () => controller.abort();
  }, [base, enabled, retryEpoch]);

  return {
    tasks,
    status: enabled ? (status === "idle" ? "loading" : status) : "idle",
    retry: () => setRetryEpoch((epoch) => epoch + 1),
  };
}
