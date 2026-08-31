export const NOW_ISO = "2026-08-19T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);
export const FRESH_AT = "2026-08-19T11:59:00.000Z";
export const STALE_AT = "2026-08-19T11:57:00.000Z";

export function taskSnapshot(tasks: readonly Record<string, unknown>[], parentSessionId = "sess-1"): Record<string, unknown> {
  return { parent_session_id: parentSessionId, tasks };
}

export function dagRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "r1",
    run_key: "plan",
    name: "Ship",
    status: "running",
    counts: { total: 1, pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
    nodes: [{ id: "n1", prompt: "do", depends_on: [], state: "running" }],
    edges: [],
    waves: [{ index: 0, node_ids: ["n1"] }],
    ...overrides,
  };
}
