import { apiJson } from "../../lib/api";

export interface SystemStats {
  readonly cpuPercent: number;
  readonly memTotalBytes: number;
  readonly memUsedBytes: number;
  readonly memPercent: number;
  readonly numGoroutine: number;
  readonly goHeapAllocBytes: number;
  readonly uptimeSeconds: number;
  readonly os: string;
  readonly arch: string;
  readonly numCpu: number;
}

export async function getSystemStats(): Promise<SystemStats> {
  return apiJson<SystemStats>("/api/system/stats");
}

export interface EngineRestartResult {
  readonly restarted: boolean;
  readonly engineVersionBefore: string;
  readonly engineVersionAfter: string;
  readonly activeChats: number;
}

/** Replace the running engine with a fresh process. The endpoint accepts
 * only an empty JSON object; there is deliberately no parameter surface. */
export async function restartEngine(): Promise<EngineRestartResult> {
  return apiJson<EngineRestartResult>("/api/system/engine/restart", { method: "POST", body: {} });
}
