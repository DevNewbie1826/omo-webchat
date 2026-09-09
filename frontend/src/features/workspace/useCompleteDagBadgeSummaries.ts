import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../../lib/api";
import { isRecord } from "../../lib/chatWsParseFields";
import { CompleteDagError, parseCompleteDag, parseDagCatalog } from "../split/activityCompleteParse";
import { parseDagUpdated, parseDagUpdatedAt } from "../split/activityParseDag";
import type { ActivityDagCounts, ActivityDagNode, ActivityDagRun } from "../split/activityTypes";
import { TERMINAL_DAG_STATUSES } from "../split/activityShelfModel";
import { summarizeLiveSession } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { Workspace } from "./workspace";

/** A complete run document accepted as a substitute for one payload run. */
interface RecoveredRun {
  readonly run: ActivityDagRun;
  /** The document revision is strictly newer than the payload run's revision. */
  readonly strictlyNewer: boolean;
}

/** Per-session recovery result: the dag payload rebuilt in the original wire
 * shape plus whether every substitution carried a strictly newer revision. */
interface RecoveredEntry {
  readonly dag: Record<string, unknown>;
  readonly newerThanPayload: boolean;
  /** Identity of the exact payload revision and retained content certified. */
  readonly fingerprint: string;
}

interface RecoveryTarget {
  readonly id: string;
  readonly base: string;
  readonly fingerprint: string;
  readonly dag: unknown;
  /** The payload's run membership cannot be trusted as complete. */
  readonly catalogMembership: boolean;
}

function wireCounts(counts: ActivityDagCounts): Record<string, number> {
  return {
    total: counts.total,
    pending: counts.pending,
    blocked: counts.blocked,
    scheduled: counts.scheduled,
    running: counts.running,
    completed: counts.completed,
    failed: counts.failed,
    cancelled: counts.cancelled,
    skipped: counts.skipped,
  };
}

function wireNode(node: ActivityDagNode): Record<string, unknown> {
  return {
    id: node.id,
    ...(node.label === undefined ? {} : { label: node.label }),
    prompt: node.prompt,
    depends_on: node.dependsOn,
    state: node.state,
    ...(node.taskId !== undefined
      ? { task_id: node.taskId }
      : node.taskIdPrefix !== undefined ? { task_id: node.taskIdPrefix, task_id_truncated: true } : {}),
    ...(node.attempt === undefined ? {} : { attempt: node.attempt }),
    ...(node.startedAt === undefined ? {} : { started_at: node.startedAt }),
    ...(node.completedAt === undefined ? {} : { completed_at: node.completedAt }),
  };
}

/** Re-encode an accepted run in the live payload's wire shape so
 * summarizeLiveSession can re-read it through the same tolerant parser. */
function wireRun(run: ActivityDagRun): Record<string, unknown> {
  return {
    run_id: run.runId,
    run_key: run.runKey,
    name: run.name,
    status: run.status,
    ...(run.createdAt === undefined ? {} : { created_at: run.createdAt }),
    ...(run.updatedAt === undefined ? {} : { updated_at: run.updatedAt }),
    counts: wireCounts(run.counts),
    nodes: run.nodes.map(wireNode),
    edges: run.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    waves: run.waves.map((wave) => ({ index: wave.index, node_ids: wave.nodeIds })),
  };
}

/** At the same revision a complete document may fill in missing members but
 * must never contradict retained node state or advertise fewer running
 * agents than the payload's own counts. */
function contradictsPayloadRun(payloadRun: ActivityDagRun, docRun: ActivityDagRun): boolean {
  const states = new Map(docRun.nodes.map((node) => [node.id, node.state]));
  return payloadRun.nodes.some((node) => states.get(node.id) !== node.state)
    || docRun.counts.running < payloadRun.counts.running;
}

/** Parse and revision-check one complete document. A document whose revision
 * is older than the payload run's is stale; one that is not provably strictly
 * newer must additionally agree with everything the payload retained. */
function acceptDocument(runId: string, payloadRun: ActivityDagRun | undefined, value: unknown): RecoveredRun {
  const doc = parseCompleteDag(value);
  if (doc === null || doc.run.runId !== runId) throw new CompleteDagError("invalid");
  const docRev = parseDagUpdatedAt(doc.run.updatedAt);
  const payloadRev = payloadRun === undefined ? undefined : parseDagUpdatedAt(payloadRun.updatedAt);
  if (payloadRev !== undefined && (docRev === undefined || docRev < payloadRev)) throw new CompleteDagError("stale");
  const strictlyNewer = docRev !== undefined && payloadRev !== undefined && docRev > payloadRev;
  if (!strictlyNewer && payloadRun !== undefined && contradictsPayloadRun(payloadRun, doc.run)) {
    throw new CompleteDagError("stale");
  }
  return { run: doc.run, strictlyNewer };
}

/** One catalog row with its status read from the raw record (the shared
 * catalog parser validates the page but keeps only identity fields). */
interface CatalogRun {
  readonly runId: string;
  readonly status: string | undefined;
}

/** Enumerate every run of the session through the catalog endpoint, following
 * cursor pagination to the end of the collection. */
async function enumerateCatalog(base: string, signal: AbortSignal): Promise<readonly CatalogRun[]> {
  const entries = new Map<string, CatalogRun>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const value = await apiJson<unknown>(`${base}${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, { signal });
    const page = parseDagCatalog(value);
    if (page === null) throw new CompleteDagError("invalid");
    const rawRuns = isRecord(value) && Array.isArray(value["runs"]) ? value["runs"] as readonly unknown[] : [];
    for (const [index, entry] of page.runs.entries()) {
      if (entries.has(entry.runId)) throw new CompleteDagError("invalid");
      const raw = rawRuns[index];
      entries.set(entry.runId, {
        runId: entry.runId,
        status: isRecord(raw) && typeof raw["status"] === "string" ? raw["status"] : undefined,
      });
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) throw new CompleteDagError("invalid");
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return [...entries.values()];
}

/** Fetch complete documents for every non-terminal run of one session and
 * rebuild its dag payload in the same wire shape with the complete runs
 * substituted. Returns null when recovery could not cover every active run;
 * the caller then keeps the payload's own summary. */
async function recoverSessionDag(target: RecoveryTarget, signal: AbortSignal): Promise<RecoveredEntry> {
  const parsed = parseDagUpdated(target.dag);
  const rawRecord = isRecord(target.dag) ? target.dag : undefined;
  const rawRuns = Array.isArray(rawRecord?.["runs"]) ? rawRecord["runs"] as readonly unknown[] : [];
  const expected = new Map<string, ActivityDagRun | undefined>();
  if (parsed !== null) {
    for (const run of parsed.runs) {
      if (run.runId !== "" && !TERMINAL_DAG_STATUSES.has(run.status)) expected.set(run.runId, run);
    }
  }
  if (target.catalogMembership) {
    for (const entry of await enumerateCatalog(target.base, signal)) {
      // An unreadable status counts as active: fetching its document is
      // conservative, skipping it could silently drop a running run.
      if (entry.status === undefined || !TERMINAL_DAG_STATUSES.has(entry.status)) {
        expected.set(entry.runId, expected.get(entry.runId));
      }
    }
  }
  const docs = new Map<string, RecoveredRun>();
  await Promise.all([...expected].map(async ([runId, payloadRun]) => {
    const value = await apiJson<unknown>(`${target.base}/${encodeURIComponent(runId)}`, { signal });
    docs.set(runId, acceptDocument(runId, payloadRun, value));
  }));
  const runs: unknown[] = [];
  const substituted = new Set<string>();
  parsed?.runs.forEach((run, index) => {
    const doc = run.runId === "" ? undefined : docs.get(run.runId);
    if (doc === undefined || substituted.has(run.runId)) {
      runs.push(rawRuns[index] ?? wireRun(run));
      return;
    }
    substituted.add(run.runId);
    runs.push(wireRun(doc.run));
  });
  for (const [runId, doc] of docs) {
    if (!substituted.has(runId)) runs.push(wireRun(doc.run));
  }
  const dag: Record<string, unknown> = { ...(rawRecord ?? {}), runs, truncated_runs: false };
  delete dag["partial"];
  return {
    dag,
    newerThanPayload: [...docs.values()].every((doc) => doc.strictlyNewer),
    fingerprint: target.fingerprint,
  };
}

/** Sessions whose running count is only a DAG-side lower bound, bound to the
 * workspace/chat HTTP path (a live session id is its chat id). Task-side
 * truncation alone never fetches: no endpoint can recover a truncated task
 * list, so that qualification stays untouched. */
function dagContentDigest(runs: readonly ActivityDagRun[]): string {
  let hash = 0x811c9dc5;
  let fields = 0;
  const add = (value: string | number): void => {
    const text = `${value}\u0000`;
    fields++;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const run of runs) {
    add(run.runId);
    add(run.status);
    add(run.updatedAt ?? "");
    for (const count of Object.values(wireCounts(run.counts))) add(count);
    add(run.nodes.length);
    for (const node of run.nodes) {
      add(node.id);
      add(node.state);
    }
  }
  return `${fields}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

type ParsedDag = NonNullable<ReturnType<typeof parseDagUpdated>>;

/** DAG-only sources of the combined summary qualification. Keep this aligned
 * with the summary boundary so task truncation cannot trigger DAG retrieval. */
function dagPayloadPartial(data: unknown, parsed: ParsedDag | null): boolean {
  if (data == null) return false;
  if (!isRecord(data) || parsed === null || !Array.isArray(data["runs"])) return true;
  if (data["partial"] === true || parsed.truncatedRuns === true || data["runs"].length !== parsed.runs.length) return true;
  const rawRuns = data["runs"];
  const runIds = new Set<string>();
  return parsed.runs.some((run, index) => {
    const raw = rawRuns[index];
    if (!isRecord(raw) || raw["partial"] === true || run.runId === "" || runIds.has(run.runId)) return true;
    runIds.add(run.runId);
    if (!Array.isArray(raw["nodes"]) || run.nodes.length === 0 || raw["nodes"].length !== run.nodes.length) return true;
    for (const key of ["edges", "waves"] as const) {
      const members = raw[key];
      if (members !== undefined && (!Array.isArray(members) || members.length !== run[key].length)) return true;
    }
    const nodeIds = new Set(run.nodes.map((node) => node.id));
    if (nodeIds.has("") || nodeIds.size !== run.nodes.length || run.counts.total !== run.nodes.length) return true;
    const states = new Map<string, number>();
    for (const node of run.nodes) {
      if (!Object.hasOwn(run.counts, node.state) || node.state === "total" || node.dependsOn.some((id) => !nodeIds.has(id))) return true;
      states.set(node.state, (states.get(node.state) ?? 0) + 1);
    }
    for (const [state, count] of Object.entries(run.counts)) {
      if (!Number.isSafeInteger(count) || count < 0 || (state !== "total" && count !== (states.get(state) ?? 0))) return true;
    }
    return run.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      || run.waves.some((wave) => wave.nodeIds.some((id) => !nodeIds.has(id)));
  });
}

function recoveryTargets(summaries: readonly LiveSessionSummary[], workspaces: readonly Workspace[]): readonly RecoveryTarget[] {
  const targets: RecoveryTarget[] = [];
  for (const summary of summaries) {
    const parsed = parseDagUpdated(summary.dag);
    const qualified = summary.dagSideOversized
      || summary.dagDigest?.truncated === true
      || dagPayloadPartial(summary.dag, parsed);
    if (!qualified) continue;
    const ws = workspaces.find((candidate) => candidate.chats.some((chat) => chat.id === summary.id));
    if (ws === undefined) continue;
    const envelopePartial = isRecord(summary.dag) && summary.dag["partial"] === true;
    const truncatedMembership = parsed === null || envelopePartial || parsed.truncatedRuns === true;
    targets.push({
      id: summary.id,
      base: `/api/workspaces/${encodeURIComponent(ws.id)}/chats/${encodeURIComponent(summary.id)}/dag-runs`,
      fingerprint: JSON.stringify([
        ws.id,
        summary.dagSideOversized,
        envelopePartial,
        parsed === null ? "malformed" : dagContentDigest(parsed.runs),
        parsed?.truncatedRuns === true,
      ]),
      dag: summary.dag,
      catalogMembership: truncatedMembership || summary.dagSideOversized,
    });
  }
  return targets;
}

/** Exact running counts for the sidebar badges. Sessions whose summary is only
 * DAG-side qualified fetch the complete run documents over the dag-runs HTTP
 * contract and re-run the summary on a recovered payload; the recovered
 * summary replaces the payload summary only when recovery covered every
 * non-terminal run. Fetches are deduplicated per payload revision fingerprint,
 * aborted on unmount or when a session leaves the summaries, and never issued
 * for unqualified sessions. */
export function useCompleteDagBadgeSummaries(
  summaries: readonly LiveSessionSummary[],
  workspaces: readonly Workspace[],
): readonly LiveSessionSummary[] {
  const targets = useMemo(() => recoveryTargets(summaries, workspaces), [summaries, workspaces]);
  const [recovered, setRecovered] = useState<ReadonlyMap<string, RecoveredEntry>>(new Map());
  const fingerprints = useRef(new Map<string, string>());
  const controllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const previousFingerprints = fingerprints.current;
    const nextFingerprints = new Map<string, string>();
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    for (const target of targets) {
      nextFingerprints.set(target.id, target.fingerprint);
      if (previousFingerprints.get(target.id) === target.fingerprint && controllers.current.has(target.id)) continue;
      controllers.current.get(target.id)?.abort();
      const controller = new AbortController();
      controllers.current.set(target.id, controller);
      void recoverSessionDag(target, controller.signal)
        .then((entry) => {
          if (controller.signal.aborted || fingerprints.current.get(target.id) !== target.fingerprint) return;
          setRecovered((current) => new Map(current).set(target.id, entry));
        })
        .catch(() => {
          if (controller.signal.aborted || fingerprints.current.get(target.id) !== target.fingerprint) return;
          setRecovered((current) => {
            if (!current.has(target.id)) return current;
            const next = new Map(current);
            next.delete(target.id);
            return next;
          });
        });
    }
    for (const id of previousFingerprints.keys()) {
      if (nextFingerprints.has(id)) continue;
      controllers.current.get(id)?.abort();
      controllers.current.delete(id);
    }
    fingerprints.current = nextFingerprints;
    setRecovered((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [id, entry] of current) {
        if (entry.fingerprint === targetsById.get(id)?.fingerprint) continue;
        next.delete(id);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [targets]);

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    fingerprints.current.clear();
  }, []);

  return useMemo(
    () => summaries.map((summary) => {
      const entry = recovered.get(summary.id);
      const target = targets.find((candidate) => candidate.id === summary.id);
      if (entry === undefined || entry.fingerprint !== target?.fingerprint) return summary;
      const candidate = summarizeLiveSession(
        {
          id: summary.id,
          title: summary.title,
          task: summary.task,
          dag: entry.dag,
          taskOversized: summary.taskSideOversized,
          dagOversized: false,
          ...(summary.taskDigest === undefined ? {} : { taskDigest: summary.taskDigest }),
        },
        Date.now(),
        // The poller listing the session is the shared liveness signal, matching
        // the merged summaries this hook receives from the sidebar.
        { sessionLive: true },
      );
      // Recovery never certifies fewer running agents than the payload
      // confirmed unless every substitution is backed by a strictly newer
      // document revision.
      if (candidate.runningCount < summary.runningCount && !entry.newerThanPayload) return summary;
      return candidate;
    }),
    [summaries, recovered, targets],
  );
}
