import { useMemo, useSyncExternalStore } from "react";
import { connectChat } from "../../lib/chatWs";
import type { ChatClient } from "../../lib/chatWs";
import { adoptLiveBadgeInstance, nextLiveActivitySequence } from "./liveBadgeStore";
import { LiveSessionMembership } from "./liveSessionMembership";
import { listLiveSummarySessions } from "./useLiveSessionsLean";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

const POLL_MS = 4000;
const STALL_MS = 30000;
const EMPTY_SESSIONS: readonly LiveSessionInfo[] = [];
const membership = new LiveSessionMembership();
const listeners = new Set<() => void>();
let sessions: readonly LiveSessionInfo[] = EMPTY_SESSIONS;
let polling = false;
let timer: number | undefined;
let activeCtrl: AbortController | undefined;
let generation = 0;
let refreshRequested = false;
let pushClient: ChatClient | undefined;
let pushOpen = false;
let instanceId: string | undefined;
let retiredInstances = new Set<string>();
let transportGeneration = 0;
let socketConnection = 0;
let helloGeneration: number | undefined;
let revalidateOnHello = false;

function publish(): void {
  const next = membership.values();
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  for (const listener of listeners) listener();
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

/** Revisions and ownership belong to one server instance, never to wall time. */
function acceptInstance(incoming: string | undefined, mayAdopt = false): boolean {
  if (incoming === undefined) return instanceId === undefined; // older servers omit the optional epoch
  if (retiredInstances.has(incoming)) return false;
  if (instanceId !== incoming) {
    if (!mayAdopt) return false;
    if (instanceId !== undefined) retiredInstances.add(instanceId);
    instanceId = incoming;
    membership.reset();
    adoptLiveBadgeInstance(incoming);
    publish();
  }
  return true;
}

function startPush(): void {
  if (pushClient !== undefined) return;
  let openedSynchronously = false;
  let socketInstanceId: string | undefined;
  try {
    const client = connectChat({
      onAttempt: (connection) => {
        transportGeneration += 1;
        socketConnection = connection;
        helloGeneration = undefined;
        socketInstanceId = undefined;
        pushOpen = false;
      },
      onOpen: (connection) => {
        if (connection !== undefined && connection < socketConnection) return;
        // Connector test doubles may invoke onOpen without an attempt.
        if (connection === undefined || connection !== socketConnection) transportGeneration += 1;
        socketConnection = connection ?? socketConnection + 1;
        helloGeneration = undefined;
        socketInstanceId = undefined;
        pushOpen = true;
        openedSynchronously = true;
        pushClient?.send({ type: "sessions.subscribe", mode: "all_live" });
      },
      onHello: (id, connection) => {
        if (connection !== undefined && (!pushOpen || connection !== socketConnection)) return;
        socketInstanceId = id;
        helloGeneration = transportGeneration;
        acceptInstance(id, true);
        if (revalidateOnHello) {
          revalidateOnHello = false;
          requestFallbackRefresh();
        }
      },
      onFrame: (frame, connection) => {
        if ((connection !== undefined && (!pushOpen || connection !== socketConnection))
          || frame.type !== "sessions.activity" || !acceptInstance(socketInstanceId)) return;
        membership.push(frame, nextLiveActivitySequence());
        publish();
        if (frame.overflow) requestFallbackRefresh();
      },
      onClose: (_code, connection) => {
        if (connection !== undefined && connection !== socketConnection) return;
        pushOpen = false;
        transportGeneration += 1;
        helloGeneration = undefined;
        if (!acceptInstance(socketInstanceId)) return;
        membership.disconnect(nextLiveActivitySequence());
        publish();
      },
    });
    pushClient = client;
    if (openedSynchronously) client.send({ type: "sessions.subscribe", mode: "all_live" });
  } catch (error) {
    // A browser without WebSocket support keeps the established REST path.
    if (!(error instanceof Error)) throw error;
    pushClient = undefined;
    pushOpen = false;
  }
}

function tick(): void {
  if (!polling) return;
  const requestGeneration = generation;
  const requestTransportGeneration = transportGeneration;
  const startedAfterHello = helloGeneration === transportGeneration;
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
  void listLiveSummarySessions(ctrl.signal).then(
    ({ sessions: infos, instanceId: responseInstance }) => {
      if (polling && generation === requestGeneration && !superseded
        && requestTransportGeneration === transportGeneration) {
        const unfamiliar = responseInstance !== undefined && responseInstance !== instanceId;
        const mayAdopt = pushClient === undefined || (startedAfterHello && helloGeneration === transportGeneration);
        if (!startedAfterHello && helloGeneration === transportGeneration && pushClient !== undefined) {
          // The socket completed its handshake after this request started.
          // Only a post-hello request may project membership for that epoch.
          if (unfamiliar && responseInstance !== undefined && !retiredInstances.has(responseInstance)) refreshRequested = true;
        } else if (unfamiliar && !mayAdopt && !retiredInstances.has(responseInstance)) {
          revalidateOnHello = helloGeneration !== transportGeneration;
          refreshRequested = !revalidateOnHello;
        } else if (acceptInstance(responseInstance, mayAdopt)) {
          membership.poll(infos, requestSequence);
          publish();
        }
      }
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
  startPush();
  tick();
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
  if (pushOpen) pushClient?.send({ type: "sessions.subscribe", mode: "none" });
  pushClient?.close();
  pushClient = undefined;
  pushOpen = false;
  transportGeneration += 1;
  socketConnection = 0;
  helloGeneration = undefined;
  revalidateOnHello = false;
  membership.reset();
  instanceId = undefined;
  retiredInstances = new Set();
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

const getSessions = (): readonly LiveSessionInfo[] => sessions;
const noopSubscribe = (): (() => void) => () => undefined;
const getEmptySessions = (): readonly LiveSessionInfo[] => EMPTY_SESSIONS;

/** Lean records from sessions.activity push and GET /api/sessions/live fallback. */
export function useLiveSessionInfos(enabled: boolean): readonly LiveSessionInfo[] {
  return useSyncExternalStore(
    enabled ? subscribeLiveSessions : noopSubscribe,
    enabled ? getSessions : getEmptySessions,
  );
}

/** Ids of sessions with a live provider process (established contract). */
export function useLiveSessions(enabled: boolean): ReadonlySet<string> {
  const infos = useLiveSessionInfos(enabled);
  return useMemo(() => new Set(infos.map((info) => info.id)), [infos]);
}
