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
