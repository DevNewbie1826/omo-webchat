import { useMemo, useSyncExternalStore } from "react";
import { connectChat } from "../../lib/chatWs";
import type { ChatClient, ChatServerFrame } from "../../lib/chatWs";
import { parseDagDigest, parseTaskDigest } from "./activityDigest";
import { listLiveSessions } from "./workspace";
import type { LiveSessionInfo } from "./workspace";

const POLL_MS = 4000;
const STALL_MS = 30000;

const EMPTY_SESSIONS: readonly LiveSessionInfo[] = [];

// One module-level source feeds every overview/sidebar consumer. REST remains
// the compatibility and outage fallback; sessions.activity snapshots override
// its activity sides while the shared socket is open. The next successful REST
// response also removes a pushed row that is no longer live.
const listeners = new Set<() => void>();
let sessions: readonly LiveSessionInfo[] = EMPTY_SESSIONS;
let polledSessions: readonly LiveSessionInfo[] = EMPTY_SESSIONS;
let pushedSessions = new Map<string, { readonly info: LiveSessionInfo; readonly arrival: number }>();
let polling = false;
let timer: number | undefined;
let activeCtrl: AbortController | undefined;
let generation = 0;
let sequence = 0;
let refreshRequested = false;
let pushClient: ChatClient | undefined;
let pushOpen = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function publishMerged(): void {
  const merged = new Map(polledSessions.map((info) => [info.id, info]));
  for (const [id, pushed] of pushedSessions) {
    const polled = merged.get(id);
    merged.set(id, {
      ...pushed.info,
      title: polled?.title ?? pushed.info.title,
    });
  }
  const next = [...merged.values()];
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  emit();
}

function applyPoll(next: readonly LiveSessionInfo[], requestSequence: number): void {
  polledSessions = next;
  const liveIds = new Set(next.map((info) => info.id));
  for (const [id, pushed] of pushedSessions) {
    // Keep a frame that raced this request; a later poll will settle membership.
    if (!liveIds.has(id) && pushed.arrival < requestSequence) pushedSessions.delete(id);
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

function applyActivityFrame(frame: Extract<ChatServerFrame, { readonly type: "sessions.activity" }>): void {
  const previous = pushedSessions.get(frame.sessionId)?.info
    ?? polledSessions.find((info) => info.id === frame.sessionId);
  const task = frame.snapshots.find((snapshot) => snapshot.name === "omo.task.updated");
  const dag = frame.snapshots.find((snapshot) => snapshot.name === "omo.dag.updated");
  const taskDigest = parseTaskDigest(frame.taskDigest);
  const dagDigest = parseDagDigest(frame.dagDigest);
  const info: LiveSessionInfo = {
    id: frame.sessionId,
    title: previous?.title ?? "",
    task: task === undefined ? null : task.data ?? previous?.task ?? null,
    dag: dag === undefined ? null : dag.data ?? previous?.dag ?? null,
    ...(task?.oversized === true ? { taskOversized: true } : {}),
    ...(dag?.oversized === true ? { dagOversized: true } : {}),
    ...(taskDigest === null ? {} : { taskDigest }),
    ...(dagDigest === null ? {} : { dagDigest }),
  };
  pushedSessions.set(frame.sessionId, { info, arrival: ++sequence });
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
}

function tick(): void {
  if (!polling) return;
  const requestGeneration = generation;
  const requestSequence = ++sequence;
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
