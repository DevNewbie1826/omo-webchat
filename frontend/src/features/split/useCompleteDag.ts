import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../../lib/api";
import { CompleteDagError, parseCompleteDag, parseDagCatalog, type CompleteDag, type DagCatalogEntry } from "./activityCompleteParse";
import { parseDagUpdatedAt } from "./activityParseDag";
import type { ActivityDagRun, ActivityState } from "./activityTypes";

export interface DagSource {
  readonly wsId: string;
  readonly chatId: string;
  readonly connected: boolean;
}
export type CompleteDagStatus = "loading" | "complete" | "refreshing" | "stale" | "error";
export type DagCatalogStatus = "loading" | "ready" | "empty" | "error";
/** The DAG tab list advances one fixed-size catalog page at a time. */
export const DAG_PAGE_SIZE = 10;

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

/** Progress is an overlay, never topology/status authority. Attempt and state
 *  identity prevent a late progress event from reviving an old attempt. */
function withLiveProgress(run: ActivityDagRun, summary: ActivityDagRun | undefined): ActivityDagRun {
  if (summary === undefined) return run;
  return { ...run, nodes: run.nodes.map(node => {
    const live = summary.nodes.find(candidate => candidate.id === node.id);
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
}

export interface CompleteDagRunState {
  readonly document: CompleteDag | null;
  readonly fingerprint: string;
  readonly status: CompleteDagStatus;
  readonly error: boolean;
}

/** Facts shared by every run row: freshness high-water marks and accepted
 *  full facts (both keyed by run id and cleared, never replaced, on a source
 *  binding change) plus the document store updater. The maps are stable
 *  objects so per-run effects can capture them once and read forever. */
export interface CompleteDagFacts {
  readonly known: Map<string, number>;
  readonly accepted: Map<string, { revision: number | undefined; facts: string }>;
  readonly update: (runId: string, next: (previous: CompleteDagRunState) => CompleteDagRunState) => void;
}

/** Per-run retrieval for one catalog row. The document lives in the shelf
 *  level store, so folding the transient panel only aborts the read; the
 *  accepted facts and their fencing authority survive every DOM change. */
export function useCompleteDagRun(base: string, active: boolean, runId: string, connected: boolean,
  activities: ActivityState, facts: CompleteDagFacts, retryEpoch: number): void {
  const summary = activities.dags.get(runId);
  const fingerprint = topologyKey(summary);
  const latest = useRef({ fingerprint, connected, summary });
  latest.current = { fingerprint, connected, summary };
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active || !base) return;
    const controller = new AbortController();
    let requested = 0;
    let running = false;
    let observed = latest.current;
    const invalidate = (): void => {
      requested++;
      facts.update(runId, previous => previous.document !== null
        ? { document: previous.document, fingerprint: previous.fingerprint, status: "refreshing", error: false }
        : { document: null, fingerprint: previous.fingerprint, status: "loading", error: false });
      if (running) return;
      running = true;
      const load = async (): Promise<void> => {
        let completed = 0;
        while (!controller.signal.aborted && completed < requested) {
          const ticket = requested;
          const inputKey = latest.current.fingerprint;
          try {
            const value = await apiJson<unknown>(`${base}/${encodeURIComponent(runId)}`, { signal: controller.signal });
            if (controller.signal.aborted) return;
            // A meaningful change during this read requires one post-fetch read.
            // Do not cancel a stable document on every update/heartbeat.
            if (ticket !== requested) { completed = ticket; continue; }
            const document = parseCompleteDag(value);
            if (document === null || document.run.runId !== runId) throw new CompleteDagError("invalid");
            const revision = parseDagUpdatedAt(document.run.updatedAt);
            const highWater = facts.known.get(runId);
            if (highWater !== undefined && (revision === undefined || revision < highWater)) throw new CompleteDagError("stale");
            const { summary: knownSummary } = latest.current;
            const prior = facts.accepted.get(runId);
            const nextFacts = fullFactsKey(document.run);
            // Equal revisions permit enrichment, not conflicting state replacement.
            // Opaque tokens prove equality only; a different token supplies no order.
            if (knownSummary !== undefined && revision === parseDagUpdatedAt(knownSummary.updatedAt)
              && conflictsWithSummary(document.run, knownSummary)) throw new CompleteDagError("stale");
            if (prior !== undefined && revision === prior.revision
              && nextFacts !== prior.facts) throw new CompleteDagError("stale");
            if (revision !== undefined) facts.known.set(runId, revision);
            facts.accepted.set(runId, { revision, facts: nextFacts });
            facts.update(runId, () => ({ document, fingerprint: inputKey, status: "complete", error: false }));
          } catch (error: unknown) {
            if (controller.signal.aborted) return;
            if (!(error instanceof Error)) throw error;
            if (ticket === requested) facts.update(runId, previous => ({ ...previous,
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
  }, [base, active, runId, retryEpoch, facts]);

  useEffect(() => { refresh.current?.(); }, [fingerprint, connected]);
}

export interface CompleteDagRow {
  readonly entry: DagCatalogEntry;
  readonly run: ActivityDagRun | null;
  readonly status: CompleteDagStatus;
  readonly error: boolean;
  readonly contentToken: string;
}

export interface CompleteDagData {
  /** The newest-first run list: one row per catalog entry, in catalog order. */
  readonly rows: readonly CompleteDagRow[];
  readonly catalogStatus: DagCatalogStatus;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMore: () => void;
  readonly retry: () => void;
  /** Binding for the per-run retrieval hook rendered by each row. */
  readonly runScope: {
    readonly base: string;
    readonly active: boolean;
    readonly connected: boolean;
    readonly facts: CompleteDagFacts;
    readonly retryEpoch: number;
  };
}

export function useCompleteDag(source: DagSource | undefined, active: boolean, activities: ActivityState): CompleteDagData {
  const base = source === undefined ? "" : `/api/workspaces/${encodeURIComponent(source.wsId)}/chats/${encodeURIComponent(source.chatId)}/dag-runs`;
  const connected = source?.connected === true;
  const [binding, setBinding] = useState(base);
  const [catalog, setCatalog] = useState<{ entries: readonly DagCatalogEntry[]; nextCursor: string | null }>({ entries: [], nextCursor: null });
  const [catalogStatus, setCatalogStatus] = useState<DagCatalogStatus>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [docs, setDocs] = useState<ReadonlyMap<string, CompleteDagRunState>>(new Map());
  const [retryEpoch, setRetryEpoch] = useState(0);
  const known = useRef(new Map<string, number>());
  const accepted = useRef(new Map<string, { revision: number | undefined; facts: string }>());
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const controllerRef = useRef<AbortController | null>(null);
  const pageInFlight = useRef(false);
  const update = useCallback((runId: string, next: (previous: CompleteDagRunState) => CompleteDagRunState): void => {
    setDocs(previous => {
      const prior = previous.get(runId) ?? { document: null, fingerprint: "", status: "loading", error: false };
      const value = next(prior);
      if (value === prior) return previous;
      const docs = new Map(previous);
      docs.set(runId, value);
      return docs;
    });
  }, []);
  const facts = useMemo<CompleteDagFacts>(() => ({ known: known.current, accepted: accepted.current, update }), [update]);
  // React restarts this render before committing children, so a new chat can
  // never paint the previous binding's graph. Panel folding does not reset it.
  if (binding !== base) {
    setBinding(base);
    setCatalog({ entries: [], nextCursor: null });
    setCatalogStatus("loading");
    setLoadingMore(false);
    setDocs(new Map());
    pageInFlight.current = false;
    // Clearing keeps the shared fact objects stable across bindings while
    // still establishing a fresh authority domain for the new chat.
    known.current.clear();
    accepted.current.clear();
  }
  for (const [id, revision] of activities.dagFreshness ?? []) known.current.set(id, Math.max(known.current.get(id) ?? -Infinity, revision));
  for (const [id, run] of activities.dags) {
    const revision = parseDagUpdatedAt(run.updatedAt);
    if (revision !== undefined) known.current.set(id, Math.max(known.current.get(id) ?? -Infinity, revision));
  }
  const membership = JSON.stringify([...activities.dags.keys()].sort());

  const loadPage = useCallback(async (controller: AbortController, cursor: string | null, replace: boolean): Promise<void> => {
    try {
      const query = `limit=${DAG_PAGE_SIZE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const value = await apiJson<unknown>(`${base}?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const page = parseDagCatalog(value);
      if (page === null) throw new CompleteDagError("invalid");
      if (replace) {
        setCatalog({ entries: page.runs, nextCursor: page.nextCursor });
        setCatalogStatus(page.runs.length === 0 ? "empty" : "ready");
      } else {
        // A run repeating across pages breaks the cursor walk's uniqueness.
        const seen = new Set(catalogRef.current.entries.map(entry => entry.runId));
        if (page.runs.some(entry => seen.has(entry.runId))) throw new CompleteDagError("invalid");
        setCatalog(previous => ({ entries: [...previous.entries, ...page.runs], nextCursor: page.nextCursor }));
        setCatalogStatus("ready");
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      // HTTP/JSON failures are explicit UI errors, never an authoritative empty catalog.
      if (error instanceof Error) setCatalogStatus("error");
      else throw error;
    } finally {
      if (!controller.signal.aborted) {
        pageInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }, [base]);

  // Reconnection, retained-snapshot membership changes and explicit retries
  // all restart the list at the newest page; deeper pages return on scroll.
  useEffect(() => {
    if (!active || !base) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    pageInFlight.current = true;
    setLoadingMore(false);
    setCatalogStatus("loading");
    void loadPage(controller, null, true);
    return () => { controller.abort(); controllerRef.current = null; };
  }, [base, active, connected, membership, retryEpoch, loadPage]);

  const loadMore = useCallback((): void => {
    const controller = controllerRef.current;
    if (controller === null || pageInFlight.current) return;
    const cursor = catalogRef.current.nextCursor;
    if (cursor === null) return;
    pageInFlight.current = true;
    setLoadingMore(true);
    void loadPage(controller, cursor, false);
  }, [loadPage]);

  useEffect(() => {
    const visible = (): void => { if (document.visibilityState === "visible") setRetryEpoch(epoch => epoch + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);

  const rows = catalog.entries.map(entry => {
    const state = docs.get(entry.runId);
    const summary = activities.dags.get(entry.runId);
    const stored = state?.status ?? "loading";
    const status: CompleteDagStatus = !connected ? "stale"
      : stored === "complete" && state !== undefined && state.fingerprint !== topologyKey(summary) ? "refreshing"
      : stored;
    const document = state?.document ?? null;
    return { entry, run: document === null ? null : withLiveProgress(document.run, summary), status,
      error: state?.error ?? false, contentToken: document?.contentToken ?? "" };
  });
  return { rows, catalogStatus, hasMore: catalog.nextCursor !== null, loadingMore,
    loadMore, retry: () => setRetryEpoch(epoch => epoch + 1),
    runScope: { base, active, connected, facts, retryEpoch } };
}
