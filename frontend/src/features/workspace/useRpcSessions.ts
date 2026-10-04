import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { listRpcSessions } from "./rpcSessions";
import type { RpcSessionInfo } from "./rpcSessions";
import type { Workspace } from "./workspace";

const POLL_MS = 4000;
const EMPTY_SESSIONS: readonly RpcSessionInfo[] = [];
const listeners = new Set<() => void>();
let sessions: readonly RpcSessionInfo[] = EMPTY_SESSIONS;
let polling = false;
let timer: number | undefined;
let activeCtrl: AbortController | undefined;
let generation = 0;

function publish(next: readonly RpcSessionInfo[]): void {
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  for (const listener of listeners) listener();
}

function tick(): void {
  if (!polling) return;
  const requestGeneration = generation;
  const ctrl = new AbortController();
  activeCtrl = ctrl;
  let settled = false;
  const reschedule = (): void => {
    if (settled) return;
    settled = true;
    if (activeCtrl === ctrl) activeCtrl = undefined;
    if (polling && generation === requestGeneration) {
      timer = window.setTimeout(tick, POLL_MS);
    }
  };
  void listRpcSessions(ctrl.signal).then(
    (infos) => {
      if (polling && generation === requestGeneration) publish(infos);
      reschedule();
    },
    reschedule,
  );
}

function start(): void {
  if (polling) return;
  polling = true;
  tick();
}

function stop(): void {
  polling = false;
  generation += 1;
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  activeCtrl?.abort();
  activeCtrl = undefined;
  sessions = EMPTY_SESSIONS;
}

function subscribeRpcSessions(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) stop();
  };
}

const getSessions = (): readonly RpcSessionInfo[] => sessions;
const noopSubscribe = (): (() => void) => () => undefined;
const getEmptySessions = (): readonly RpcSessionInfo[] => EMPTY_SESSIONS;

/** Live RPC daemon sessions for the sidebar tree; shared 4s poll across
 * every consumer, stopped entirely while nobody subscribes. */
export function useRpcSessions(enabled: boolean): readonly RpcSessionInfo[] {
  return useSyncExternalStore(
    enabled ? subscribeRpcSessions : noopSubscribe,
    enabled ? getSessions : getEmptySessions,
  );
}

export type RpcOpenAttemptStatus = "opening" | "failed";
export type RpcOpenAttemptResult = "opened" | "failed" | void;

export function rpcSessionAttemptKey(wsId: string, sessionId: string): string {
  return `${wsId}:${sessionId}`;
}

/** Per-row open state for RPC sessions, keyed by workspace + daemon session
 * id; mirrors useSessionOpenAttempts without its session-active branch. */
export function useRpcSessionOpenAttempts(
  onOpen: (ws: Workspace, rpc: RpcSessionInfo) => Promise<RpcOpenAttemptResult>,
) {
  const [attempts, setAttempts] = useState<ReadonlyMap<string, RpcOpenAttemptStatus>>(new Map());
  const openingRef = useRef(new Set<string>());

  const open = useCallback(async (
    ws: Workspace,
    rpc: RpcSessionInfo,
  ): Promise<RpcOpenAttemptResult> => {
    const key = rpcSessionAttemptKey(ws.id, rpc.sessionId);
    if (openingRef.current.has(key)) return;
    openingRef.current.add(key);
    setAttempts((current) => new Map(current).set(key, "opening"));
    try {
      const result = await onOpen(ws, rpc);
      setAttempts((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      return result;
    } catch {
      setAttempts((current) => new Map(current).set(key, "failed"));
      return "failed";
    } finally {
      openingRef.current.delete(key);
    }
  }, [onOpen]);

  return { attempts, open };
}
