import { useEffect, useRef, useState } from "react";
import { apiJson } from "../../lib/api";
import { CompleteDagError, parseCompleteDag, parseDagCatalog, type CompleteDag, type DagCatalogEntry } from "./activityCompleteParse";
import { parseDagUpdatedAt } from "./activityParseDag";
import type { ActivityDagRun, ActivityState } from "./activityTypes";

export interface DagSource {
  readonly wsId: string;
  readonly chatId: string;
  readonly connected: boolean;
}
export type CompleteDagStatus = "loading" | "complete" | "refreshing" | "stale" | "error" | "empty";
interface FullState {
  readonly selected: string | null;
  readonly document: CompleteDag | null;
  readonly fingerprint: string;
  readonly status: CompleteDagStatus;
  readonly error: boolean;
}

/** Activity clocks and heartbeat sequence numbers are not topology revisions. */
function topologyKey(run: ActivityDagRun | undefined): string {
  if (!run) return "";
  return JSON.stringify([run.runId, run.updatedAt, run.status, run.truncated, run.counts, run.edges, run.waves,
    run.nodes.map(node => [node.id, node.label, node.prompt, node.dependsOn, node.state, node.attempt, node.taskId, node.taskIdPrefix, node.startedAt, node.completedAt])]);
}

/** A bounded projection can omit topology/text, but not contradict known runtime facts. */
function conflictsWithSummary(run: ActivityDagRun, summary: ActivityDagRun): boolean {
  if (run.status !== summary.status) return true;
  const nodes = new Map(run.nodes.map(node => [node.id, node]));
  return summary.nodes.some(knownNode => {
    const node = nodes.get(knownNode.id);
    // Projection IDs may themselves be truncated. Never infer identity by prefix.
    if (node === undefined) return false;
    // The parser keeps lossy task text out of exact taskId authority. Compare
    // only metadata on this EXACT node ID; an exact live taskId still wins.
    if (knownNode.taskId === undefined && knownNode.taskIdPrefix !== undefined
      && (node.taskId === undefined || node.taskId === knownNode.taskIdPrefix
        || !node.taskId.startsWith(knownNode.taskIdPrefix))) return true;
    return node.state !== knownNode.state || (["attempt", "taskId", "startedAt", "completedAt"] as const)
      .some(key => knownNode[key] !== undefined && knownNode[key] !== node[key]);
  });
}

function fullFactsKey(run: ActivityDagRun): string {
  return JSON.stringify([run.runKey, run.name, run.createdAt, topologyKey(run)]);
}

export function useCompleteDag(source: DagSource | undefined, active: boolean, activities: ActivityState) {
  const base = source === undefined ? "" : `/api/workspaces/${encodeURIComponent(source.wsId)}/chats/${encodeURIComponent(source.chatId)}/dag-runs`;
  const connected = source?.connected === true;
  const [binding, setBinding] = useState(base);
  const [catalog, setCatalog] = useState<readonly DagCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [chosen, setChosen] = useState<{ id: string | null; explicit: boolean }>(() => ({
    id: activities.dags.keys().next().value ?? null, explicit: false,
  }));
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [full, setFull] = useState<FullState>({ selected: null, document: null, fingerprint: "", status: "loading", error: false });
  const selected = chosen.id ?? catalog[0]?.runId ?? null;
  const summary = selected === null ? undefined : activities.dags.get(selected);
  const fingerprint = topologyKey(summary);
  const membership = JSON.stringify([...activities.dags.keys()].sort());
  const known = useRef(new Map<string, number>());
  // Accepted full authority outlives picker changes, but never a source binding.
  // Retain equality facts, not opaque tokens or another run's display document.
  const accepted = useRef(new Map<string, { revision: number | undefined; facts: string }>());
  // React restarts this render before committing children, so a new chat can
  // never paint the previous binding's graph. Panel folding does not reset it.
  if (binding !== base) {
    setBinding(base);
    setCatalog([]);
    setCatalogLoading(true);
    setCatalogError(false);
    setChosen({ id: activities.dags.keys().next().value ?? null, explicit: false });
    setFull({ selected: null, document: null, fingerprint: "", status: "loading", error: false });
    known.current = new Map();
    accepted.current = new Map();
  }
  for (const [id, revision] of activities.dagFreshness ?? []) known.current.set(id, Math.max(known.current.get(id) ?? -Infinity, revision));
  for (const [id, run] of activities.dags) {
    const revision = parseDagUpdatedAt(run.updatedAt);
    if (revision !== undefined) known.current.set(id, Math.max(known.current.get(id) ?? -Infinity, revision));
  }
  const latest = useRef({ fingerprint, connected, summary });
  latest.current = { fingerprint, connected, summary };
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active || !base) return;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(false);
    const load = async (): Promise<void> => {
      const entries = new Map<string, DagCatalogEntry>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const value = await apiJson<unknown>(`${base}${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const page = parseDagCatalog(value);
        if (page === null) throw new CompleteDagError("invalid");
        for (const run of page.runs) {
          if (entries.has(run.runId)) throw new CompleteDagError("invalid");
          entries.set(run.runId, run);
        }
        setCatalog([...entries.values()]);
        setChosen(previous => {
          // Only a finished catalog establishes absence. Explicit choices survive
          // pagination, refresh failures, and closing/reopening the panel.
          if (previous.explicit || (previous.id !== null && (page.nextCursor !== null || entries.has(previous.id)))) return previous;
          return { id: entries.keys().next().value ?? null, explicit: false };
        });
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (cursors.has(cursor)) throw new CompleteDagError("invalid");
          cursors.add(cursor);
        }
      } while (cursor !== null);
    };
    void load().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      // HTTP/JSON failures are explicit UI errors, never an authoritative empty catalog.
      if (error instanceof Error) setCatalogError(true);
      else throw error;
    }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [base, active, connected, membership, retryEpoch]);

  useEffect(() => {
    if (!active || !base || selected === null) return;
    const controller = new AbortController();
    let requested = 0;
    let running = false;
    let observed = latest.current;
    const invalidate = (): void => {
      requested++;
      setFull(previous => ({
        selected, document: previous.selected === selected ? previous.document : null,
        fingerprint: previous.fingerprint, status: previous.selected === selected && previous.document ? "refreshing" : "loading", error: false,
      }));
      if (running) return;
      running = true;
      const load = async (): Promise<void> => {
        let completed = 0;
        while (!controller.signal.aborted && completed < requested) {
          const ticket = requested;
          const inputKey = latest.current.fingerprint;
          try {
            const value = await apiJson<unknown>(`${base}/${encodeURIComponent(selected)}`, { signal: controller.signal });
            if (controller.signal.aborted) return;
            // A meaningful change during this read requires one post-fetch read.
            // Do not cancel a stable document on every update/heartbeat.
            if (ticket !== requested) { completed = ticket; continue; }
            const document = parseCompleteDag(value);
            if (document === null || document.run.runId !== selected) throw new CompleteDagError("invalid");
            const revision = parseDagUpdatedAt(document.run.updatedAt);
            const highWater = known.current.get(selected);
            if (highWater !== undefined && (revision === undefined || revision < highWater)) throw new CompleteDagError("stale");
            const { summary: knownSummary } = latest.current;
            const prior = accepted.current.get(selected);
            const facts = fullFactsKey(document.run);
            // Equal revisions permit enrichment, not conflicting state replacement.
            // Opaque tokens prove equality only; a different token supplies no order.
            if (knownSummary !== undefined && revision === parseDagUpdatedAt(knownSummary.updatedAt)
              && conflictsWithSummary(document.run, knownSummary)) throw new CompleteDagError("stale");
            if (prior !== undefined && revision === prior.revision
              && facts !== prior.facts) throw new CompleteDagError("stale");
            if (revision !== undefined) known.current.set(selected, revision);
            accepted.current.set(selected, { revision, facts });
            setFull({ selected, document, fingerprint: inputKey, status: "complete", error: false });
          } catch (error: unknown) {
            if (controller.signal.aborted) return;
            if (!(error instanceof Error)) throw error;
            if (ticket === requested) setFull(previous => ({ ...previous,
              status: previous.document !== null || (error instanceof CompleteDagError && error.kind === "stale") ? "stale" : "error",
              error: true,
            }));
          }
          completed = ticket;
        }
        running = false;
      };
      void load();
    };
    refresh.current = () => {
      const next = latest.current;
      if (next.fingerprint === observed.fingerprint && next.connected === observed.connected) return;
      observed = next;
      if (next.connected) invalidate();
    };
    invalidate();
    return () => { controller.abort(); refresh.current = null; };
  }, [base, active, selected, retryEpoch]);

  useEffect(() => { refresh.current?.(); }, [fingerprint, connected]);
  useEffect(() => {
    const visible = (): void => { if (document.visibilityState === "visible") setRetryEpoch(epoch => epoch + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);

  const complete = full.selected === selected ? full.document : null;
  const current = full.status === "complete" && full.fingerprint === fingerprint && connected;
  const status: CompleteDagStatus = selected === null ? (catalogLoading ? "loading" : catalogError ? "error" : "empty")
    : full.selected !== selected ? "loading"
    : !connected ? "stale"
    : full.status === "complete" && !current ? "refreshing" : full.status;
  // Progress is an overlay, never topology/status authority. Attempt and state
  // identity prevent a late progress event from reviving an old attempt.
  const run = complete === null ? null : { ...complete.run, nodes: complete.run.nodes.map(node => {
    const live = summary?.nodes.find(candidate => candidate.id === node.id);
    if (!live || live.state !== node.state || live.attempt !== node.attempt) return node;
    return { ...node,
      ...(live.activity === undefined ? {} : { activity: live.activity }),
      ...(live.currentTool === undefined ? {} : { currentTool: live.currentTool }),
      ...(live.lastAssistantLine === undefined ? {} : { lastAssistantLine: live.lastAssistantLine }),
      ...(live.turns === undefined ? {} : { turns: live.turns }),
      ...(live.toolCalls === undefined ? {} : { toolCalls: live.toolCalls }),
      ...(live.lastActivityAt === undefined ? {} : { lastActivityAt: live.lastActivityAt }),
    };
  }) };
  return { catalog, catalogLoading, catalogError, selected, select: (id: string) => setChosen({ id, explicit: true }), run, status, error: full.error,
    retry: () => setRetryEpoch(epoch => epoch + 1), contentToken: complete?.contentToken };
}
