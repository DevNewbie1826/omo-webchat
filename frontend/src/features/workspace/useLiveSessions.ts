import { useMemo, useSyncExternalStore } from "react";
import { connectChat } from "../../lib/chatWs";
import type { ChatClient, ChatServerFrame } from "../../lib/chatWs";
import { parseDagDigest, parseTaskDigest } from "./activityDigest";
import {
  nextLiveActivitySequence,
  settleLiveBadgePoll,
  settleLiveBadgePush,
} from "./liveBadgeStore";
import { listLiveSessions } from "./workspace";
import type { LiveSessionInfo } from "./workspace";

const POLL_MS = 4000;
const STALL_MS = 30000;
const MAX_PUSHED_SESSIONS = 256;

const EMPTY_SESSIONS: readonly LiveSessionInfo[] = [];

interface PushedSession {
  readonly info: LiveSessionInfo;
  readonly membershipArrival: number;
  readonly taskArrival?: number;
  readonly dagArrival?: number;
}

// One module-level source feeds every overview/sidebar consumer. REST remains
// the compatibility and outage fallback; sessions.activity snapshots override
// each activity side only until a poll that started after that side arrived.
const listeners = new Set<() => void>();
let sessions: readonly LiveSessionInfo[] = EMPTY_SESSIONS;
let polledSessions: readonly LiveSessionInfo[] = EMPTY_SESSIONS;
let pushedSessions = new Map<string, PushedSession>();
let sessionAliases = new Map<string, string>();
let polling = false;
let timer: number | undefined;
let activeCtrl: AbortController | undefined;
let generation = 0;
let refreshRequested = false;
let pushClient: ChatClient | undefined;
let pushOpen = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function parentSessionIdOf(info: LiveSessionInfo): string | undefined {
  for (const payload of [info.task, info.dag]) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const parent = (payload as Record<string, unknown>)["parent_session_id"];
    if (typeof parent === "string" && parent.length > 0) return parent;
  }
  return undefined;
}

function publishMerged(): void {
  const merged = new Map(polledSessions.map((info) => [info.id, info]));
  for (const [id, pushed] of pushedSessions) {
    const polled = merged.get(id);
    const taskPushed = pushed.taskArrival !== undefined;
    const dagPushed = pushed.dagArrival !== undefined;
    const taskDigest = taskPushed ? pushed.info.taskDigest : polled?.taskDigest;
    const dagDigest = dagPushed ? pushed.info.dagDigest : polled?.dagDigest;
    merged.set(id, {
      id,
      title: polled?.title ?? pushed.info.title,
      task: taskPushed ? pushed.info.task : polled?.task ?? null,
      dag: dagPushed ? pushed.info.dag : polled?.dag ?? null,
      ...(taskPushed
        ? { taskOversized: pushed.info.taskOversized === true }
        : polled?.taskOversized === true ? { taskOversized: true } : {}),
      ...(dagPushed
        ? { dagOversized: pushed.info.dagOversized === true }
        : polled?.dagOversized === true ? { dagOversized: true } : {}),
      ...(taskDigest === undefined ? {} : { taskDigest }),
      ...(dagDigest === undefined ? {} : { dagDigest }),
    });
  }
  const next = [...merged.values()];
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  emit();
}

function mergePushedSessions(id: string, first: PushedSession, second: PushedSession): PushedSession {
  const taskSource = (first.taskArrival ?? -1) >= (second.taskArrival ?? -1) ? first : second;
  const dagSource = (first.dagArrival ?? -1) >= (second.dagArrival ?? -1) ? first : second;
  const newest = first.membershipArrival >= second.membershipArrival ? first : second;
  const taskArrival = Math.max(first.taskArrival ?? -1, second.taskArrival ?? -1);
  const dagArrival = Math.max(first.dagArrival ?? -1, second.dagArrival ?? -1);
  return {
    info: {
      id,
      title: newest.info.title,
      task: taskSource.info.task,
      dag: dagSource.info.dag,
      ...(taskSource.info.taskOversized === true ? { taskOversized: true } : {}),
      ...(dagSource.info.dagOversized === true ? { dagOversized: true } : {}),
      ...(taskSource.info.taskDigest === undefined ? {} : { taskDigest: taskSource.info.taskDigest }),
      ...(dagSource.info.dagDigest === undefined ? {} : { dagDigest: dagSource.info.dagDigest }),
    },
    membershipArrival: newest.membershipArrival,
    ...(taskArrival < 0 ? {} : { taskArrival }),
    ...(dagArrival < 0 ? {} : { dagArrival }),
  };
}

function applyPoll(next: readonly LiveSessionInfo[], requestSequence: number): void {
  settleLiveBadgePoll(next, requestSequence);
  const nextAliases = new Map(sessionAliases);
  for (const info of next) {
    const parentId = parentSessionIdOf(info);
    if (parentId === undefined || parentId === info.id) continue;
    nextAliases.set(parentId, info.id);
    const unbound = pushedSessions.get(parentId);
    if (unbound === undefined) continue;
    const attached = pushedSessions.get(info.id);
    pushedSessions.set(info.id, attached === undefined
      ? { ...unbound, info: { ...unbound.info, id: info.id } }
      : mergePushedSessions(info.id, unbound, attached));
    pushedSessions.delete(parentId);
  }
  sessionAliases = nextAliases;
  polledSessions = next;
  const liveIds = new Set(next.map((info) => info.id));
  for (const [id, pushed] of pushedSessions) {
    const taskArrival = pushed.taskArrival !== undefined && pushed.taskArrival > requestSequence
      ? pushed.taskArrival
      : undefined;
    const dagArrival = pushed.dagArrival !== undefined && pushed.dagArrival > requestSequence
      ? pushed.dagArrival
      : undefined;
    if (liveIds.has(id)) {
      if (taskArrival === undefined && dagArrival === undefined) {
        pushedSessions.delete(id);
      } else {
        pushedSessions.set(id, {
          info: pushed.info,
          membershipArrival: pushed.membershipArrival,
          ...(taskArrival === undefined ? {} : { taskArrival }),
          ...(dagArrival === undefined ? {} : { dagArrival }),
        });
      }
      continue;
    }
    // A frame that raced the request remains visible until the next success.
    if (pushed.membershipArrival <= requestSequence) pushedSessions.delete(id);
  }
  publishMerged();
}

function requestFallbackRefresh(): void {
  if (!polling) return;
  if (activeCtrl !== undefined) {
    refreshRequested = true;
    return;
  }
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(tick, 0);
}

function frameIdentity(frame: Extract<ChatServerFrame, { readonly type: "sessions.activity" }>): {
  readonly id: string;
  readonly sourceIds: readonly string[];
  readonly tombstone: boolean;
} {
  const record = frame as unknown as Record<string, unknown>;
  const replaces = typeof record["replacesSessionId"] === "string" && record["replacesSessionId"].length > 0
    ? record["replacesSessionId"]
    : undefined;
  const durable = typeof record["durableSessionId"] === "string" && record["durableSessionId"].length > 0
    ? record["durableSessionId"]
    : undefined;
  const id = sessionAliases.get(frame.sessionId) ?? frame.sessionId;
  return {
    id,
    sourceIds: [...new Set([replaces, durable].filter((value): value is string => value !== undefined && value !== id))],
    tombstone: record["tombstone"] === true,
  };
}

function applyActivityFrame(frame: Extract<ChatServerFrame, { readonly type: "sessions.activity" }>): void {
  const identity = frameIdentity(frame);
  const arrival = nextLiveActivitySequence();
  if (identity.tombstone) {
    const removedIds = identity.sourceIds.length > 0 ? identity.sourceIds : [identity.id];
    for (const removedId of removedIds) {
      pushedSessions.delete(removedId);
      settleLiveBadgePush(removedId, [], true, true, arrival);
    }
    publishMerged();
    return;
  }

  let pushed = pushedSessions.get(identity.id);
  for (const sourceId of identity.sourceIds) {
    sessionAliases.set(sourceId, identity.id);
    const source = pushedSessions.get(sourceId);
    if (source !== undefined) {
      pushed = pushed === undefined ? { ...source, info: { ...source.info, id: identity.id } }
        : mergePushedSessions(identity.id, source, pushed);
    }
    pushedSessions.delete(sourceId);
  }
  const previous = pushed?.info ?? polledSessions.find((info) => info.id === identity.id);
  const task = frame.snapshots.find((snapshot) => snapshot.name === "omo.task.updated");
  const dag = frame.snapshots.find((snapshot) => snapshot.name === "omo.dag.updated");
  const taskDigest = parseTaskDigest(frame.taskDigest);
  const dagDigest = parseDagDigest(frame.dagDigest);
  const taskUpdated = task !== undefined || taskDigest !== null;
  const dagUpdated = dag !== undefined || dagDigest !== null;
  settleLiveBadgePush(identity.id, identity.sourceIds, taskUpdated, dagUpdated, arrival);
  const info: LiveSessionInfo = {
    id: identity.id,
    title: previous?.title ?? "",
    task: task === undefined
      ? previous?.task ?? null
      : task.data ?? (task.oversized ? previous?.task ?? null : null),
    dag: dag === undefined
      ? previous?.dag ?? null
      : dag.data ?? (dag.oversized ? previous?.dag ?? null : null),
    ...(taskUpdated
      ? { taskOversized: task?.oversized === true }
      : previous?.taskOversized === true ? { taskOversized: true } : {}),
    ...(dagUpdated
      ? { dagOversized: dag?.oversized === true }
      : previous?.dagOversized === true ? { dagOversized: true } : {}),
    ...(taskUpdated
      ? taskDigest === null ? {} : { taskDigest }
      : previous?.taskDigest === undefined ? {} : { taskDigest: previous.taskDigest }),
    ...(dagUpdated
      ? dagDigest === null ? {} : { dagDigest }
      : previous?.dagDigest === undefined ? {} : { dagDigest: previous.dagDigest }),
  };
  pushedSessions.delete(identity.id);
  pushedSessions.set(identity.id, {
    info,
    membershipArrival: arrival,
    ...(taskUpdated ? { taskArrival: arrival } : pushed?.taskArrival === undefined ? {} : { taskArrival: pushed.taskArrival }),
    ...(dagUpdated ? { dagArrival: arrival } : pushed?.dagArrival === undefined ? {} : { dagArrival: pushed.dagArrival }),
  });
  while (pushedSessions.size > MAX_PUSHED_SESSIONS) {
    const oldest = pushedSessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pushedSessions.delete(oldest);
  }
  publishMerged();
  // Overflow can mean another session's latest row was displaced. Recover the
  // complete membership through the existing serialized REST chain.
  if (frame.overflow) requestFallbackRefresh();
}

function startPush(): void {
  if (pushClient !== undefined) return;
  let openedSynchronously = false;
  try {
    const client = connectChat({
      onOpen: () => {
        pushOpen = true;
        openedSynchronously = true;
        pushClient?.send({ type: "sessions.subscribe", mode: "all_live" });
      },
      onFrame: (frame) => {
        if (frame.type === "sessions.activity") applyActivityFrame(frame);
      },
      onClose: () => {
        pushOpen = false;
        pushedSessions = new Map();
        publishMerged();
      },
    });
    pushClient = client;
    if (openedSynchronously) pushClient?.send({ type: "sessions.subscribe", mode: "all_live" });
  } catch {
    // Browsers without a usable socket stay on the established REST path.
    pushClient = undefined;
    pushOpen = false;
  }
}

function stopPush(): void {
  if (pushOpen) pushClient?.send({ type: "sessions.subscribe", mode: "none" });
  pushClient?.close();
  pushClient = undefined;
  pushOpen = false;
  pushedSessions = new Map();
  sessionAliases = new Map();
}

function tick(): void {
  if (!polling) return;
  const requestGeneration = generation;
  const requestSequence = nextLiveActivitySequence();
  let settled = false;
  let superseded = false;
  const ctrl = new AbortController();
  activeCtrl = ctrl;
  let stallGuard: number | undefined;
  const reschedule = (): void => {
    if (settled) return;
    settled = true;
    if (stallGuard !== undefined) window.clearTimeout(stallGuard);
    if (activeCtrl === ctrl) activeCtrl = undefined;
    if (polling && generation === requestGeneration) {
      const delay = refreshRequested ? 0 : POLL_MS;
      refreshRequested = false;
      timer = window.setTimeout(tick, delay);
    }
  };
  void listLiveSessions(ctrl.signal).then(
    (infos) => {
      if (polling && generation === requestGeneration && !superseded) applyPoll(infos, requestSequence);
      reschedule();
    },
    reschedule,
  );
  stallGuard = window.setTimeout(() => {
    superseded = true;
    ctrl.abort();
    reschedule();
  }, STALL_MS);
}

function start(): void {
  if (polling) return;
  polling = true;
  tick();
  startPush();
}

function stop(): void {
  polling = false;
  generation += 1;
  refreshRequested = false;
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  activeCtrl?.abort();
  activeCtrl = undefined;
  stopPush();
  polledSessions = EMPTY_SESSIONS;
  sessions = EMPTY_SESSIONS;
}

function subscribeLiveSessions(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) stop();
  };
}

function getSessions(): readonly LiveSessionInfo[] {
  return sessions;
}

const noopSubscribe = (): (() => void) => () => undefined;
const getEmptySessions = (): readonly LiveSessionInfo[] => EMPTY_SESSIONS;

/** Live session records merged from sessions.activity push and GET /api/sessions/live fallback. */
export function useLiveSessionInfos(enabled: boolean): readonly LiveSessionInfo[] {
  return useSyncExternalStore(
    enabled ? subscribeLiveSessions : noopSubscribe,
    enabled ? getSessions : getEmptySessions,
  );
}

/** Ids of the sessions with a live provider process (established contract). */
export function useLiveSessions(enabled: boolean): ReadonlySet<string> {
  const infos = useLiveSessionInfos(enabled);
  return useMemo(() => new Set(infos.map((info) => info.id)), [infos]);
}
