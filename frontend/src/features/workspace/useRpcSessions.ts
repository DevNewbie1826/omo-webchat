import { useCallback, useEffect, useRef, useState } from "react";
import { listWorkspaceRpcLiveSessions, parseRpcLiveState, type RpcBoundSession, type RpcLiveSession, type RpcLiveState } from "./rpcSessions";

export interface UseRpcSessionsResult {
  /** Latest always-complete live section per workspace. */
  readonly liveByWs: ReadonlyMap<string, readonly RpcLiveSession[]>;
  readonly boundByWs: ReadonlyMap<string, ReadonlyMap<string, RpcLiveState>>;
  /** Replace a workspace's live section. The section is always complete, so
   * a row absent from the new snapshot is gone. */
  readonly applyRows: (wsId: string, rows: readonly RpcLiveSession[], items?: readonly RpcBoundSession[]) => void;
  /** Fire-and-forget live-section refetch; concurrent refreshes of one
   * workspace dedupe, and a failed refresh keeps the last good snapshot. */
  readonly refresh: (wsId: string) => void;
  readonly removeWorkspace: (wsId: string) => void;
  /** Drop every workspace not in the valid set (workspace list reload). */
  readonly prune: (validIds: ReadonlySet<string>) => void;
}

export function useRpcSessions(): UseRpcSessionsResult {
  const [liveByWs, setLiveByWs] = useState<ReadonlyMap<string, readonly RpcLiveSession[]>>(new Map());
  const liveByWsRef = useRef<ReadonlyMap<string, readonly RpcLiveSession[]>>(liveByWs);
  const [boundByWs, setBoundByWs] = useState<ReadonlyMap<string, ReadonlyMap<string, RpcLiveState>>>(new Map());
  const boundByWsRef = useRef(boundByWs);
  const inFlightRef = useRef(new Map<string, object>());

  const applyRows = useCallback((wsId: string, rows: readonly RpcLiveSession[], items: readonly RpcBoundSession[] = []): void => {
    const next = new Map(liveByWsRef.current);
    next.set(wsId, rows);
    liveByWsRef.current = next;
    setLiveByWs(next);
    const bound = new Map(boundByWsRef.current.get(wsId));
    for (const item of items) {
      if (item.source !== "stored") continue;
      const live = parseRpcLiveState(item.live);
      if (live) bound.set(item.id, live);
      else bound.delete(item.id);
    }
    const nextBound = new Map(boundByWsRef.current);
    nextBound.set(wsId, bound);
    boundByWsRef.current = nextBound;
    setBoundByWs(nextBound);
  }, []);

  const removeWorkspace = useCallback((wsId: string): void => {
    if (!liveByWsRef.current.has(wsId) && !boundByWsRef.current.has(wsId)) return;
    const next = new Map(liveByWsRef.current);
    next.delete(wsId);
    liveByWsRef.current = next;
    setLiveByWs(next);
    const nextBound = new Map(boundByWsRef.current);
    nextBound.delete(wsId);
    boundByWsRef.current = nextBound;
    setBoundByWs(nextBound);
  }, []);

  const prune = useCallback((validIds: ReadonlySet<string>): void => {
    const stale = [...new Set([...liveByWsRef.current.keys(), ...boundByWsRef.current.keys()])]
      .filter((id) => !validIds.has(id));
    if (stale.length === 0) return;
    const next = new Map(liveByWsRef.current);
    for (const id of stale) next.delete(id);
    liveByWsRef.current = next;
    setLiveByWs(next);
    const nextBound = new Map(boundByWsRef.current);
    for (const id of stale) nextBound.delete(id);
    boundByWsRef.current = nextBound;
    setBoundByWs(nextBound);
  }, []);

  const refresh = useCallback((wsId: string): void => {
    if (inFlightRef.current.has(wsId)) return;
    const request = {};
    inFlightRef.current.set(wsId, request);
    void listWorkspaceRpcLiveSessions(wsId)
      .then((snapshot) => {
        if (inFlightRef.current.get(wsId) !== request) return;
        applyRows(wsId, snapshot.live, snapshot.items);
      })
      .catch(() => {
        /* A failed refresh keeps the previous snapshot; the next cadence
         * tick retries. */
      })
      .finally(() => {
        if (inFlightRef.current.get(wsId) === request) inFlightRef.current.delete(wsId);
      });
  }, [applyRows]);

  useEffect(() => () => {
    inFlightRef.current.clear();
  }, []);

  return { liveByWs, boundByWs, applyRows, refresh, removeWorkspace, prune };
}
