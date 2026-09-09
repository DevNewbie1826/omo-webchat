/**
 * UI-facing activity-center state. Payloads are parsed into these types at the
 * activityParse boundary; reducers never see raw RPC records.
 */

export interface ActivityLiveProgress {
  readonly activity?: string;
  readonly startedAt?: string | number;
  readonly currentTool?: string;
  readonly lastAssistantLine?: string;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly totalTokens?: number;
  readonly tokensPerSecond?: number;
}

export interface ActivityTask {
  readonly taskId: string;
  readonly name: string;
  readonly status: string;
  readonly parentSessionId?: string;
  readonly taskSummary?: string;
  readonly agentType?: string;
  readonly category?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Original source clock is separate from the presentation/activity clock. */
  readonly rawUpdatedAt?: string | undefined;
  readonly rawStatus?: string;
  readonly activityAt?: string;
  readonly activityProgress?: ActivityLiveProgress;
  readonly compact?: boolean;
  readonly truncated?: boolean;
  readonly finalResponse?: string;
  readonly errorMessage?: string;
  readonly liveProgress?: ActivityLiveProgress;
}

export interface ActivityDagNode {
  readonly id: string;
  readonly label?: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
  readonly state: string;
  readonly attempt?: number;
  readonly taskId?: string;
  /** Explicitly lossy projection text, never an exact task identity or dedup key. */
  readonly taskIdPrefix?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly activity?: string;
  readonly currentTool?: string;
  readonly lastAssistantLine?: string;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly lastActivityAt?: string;
}

export interface ActivityDagCounts {
  readonly total: number;
  readonly pending: number;
  readonly blocked: number;
  readonly scheduled: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

export interface ActivityDagEdge {
  readonly from: string;
  readonly to: string;
}

export interface ActivityDagWave {
  readonly index: number;
  readonly nodeIds: readonly string[];
}

export interface ActivityDagRun {
  readonly runId: string;
  readonly runKey: string;
  readonly name: string;
  readonly status: string;
  readonly parentSessionId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** This accepted row came from a truncated projection, which stale input cannot complete. */
  readonly truncated?: boolean;
  readonly counts: ActivityDagCounts;
  readonly nodes: readonly ActivityDagNode[];
  readonly edges: readonly ActivityDagEdge[];
  readonly waves: readonly ActivityDagWave[];
  readonly lastActivityAt?: string;
}

export interface TodoTask {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "abandoned";
}

export interface TodoPhase {
  readonly name: string;
  readonly tasks: readonly TodoTask[];
}

export interface ActivityHeartbeat {
  readonly runId: string;
  readonly headSeq: number;
  readonly at: string;
}

export interface ActivityState {
  readonly tasks: ReadonlyMap<string, ActivityTask>;
  readonly dags: ReadonlyMap<string, ActivityDagRun>;
  /** Known per-ID high-water marks survive membership removal, without retaining graphs. */
  readonly dagFreshness?: ReadonlyMap<string, number>;
  readonly taskFreshness?: ReadonlyMap<string, number>;
  readonly todo: readonly TodoPhase[] | null;
  readonly heartbeats: ReadonlyMap<string, ActivityHeartbeat>;
  /** The retained task/DAG rows are a bounded prefix of a larger history. */
  readonly truncatedTasks?: boolean;
  readonly truncatedDags?: boolean;
  /** True between chat run.started and run.done; gates shelf staleness. */
  readonly runInFlight?: boolean;
}
