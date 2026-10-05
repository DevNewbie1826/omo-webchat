import { useCallback, useEffect, useRef, useState } from "react";
import { listWorkspaceRpcLiveSessions, type RpcLiveSession } from "./rpcSessions";

export interface UseRpcSessionsResult {
  /** Latest always-complete live section per workspace. */
  readonly liveByWs: ReadonlyMap<string, readonly RpcLiveSession[]>;
  /** Replace a workspace's live section. The section is always complete, so
   * a row absent from the new snapshot is gone. */
  readonly applyRows: (wsId: string, rows: readonly RpcLiveSession[]) => void;
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
  const inFlightRef = useRef(new Map<string, object>());

  const applyRows = useCallback((wsId: string, rows: readonly RpcLiveSession[]): void => {
    const next = new Map(liveByWsRef.current);
    next.set(wsId, rows);
    liveByWsRef.current = next;
    setLiveByWs(next);
  }, []);

  const removeWorkspace = useCallback((wsId: string): void => {
    if (!liveByWsRef.current.has(wsId)) return;
    const next = new Map(liveByWsRef.current);
    next.delete(wsId);
    liveByWsRef.current = next;
    setLiveByWs(next);
  }, []);

  const prune = useCallback((validIds: ReadonlySet<string>): void => {
    const stale = [...liveByWsRef.current.keys()].filter((id) => !validIds.has(id));
    if (stale.length === 0) return;
    const next = new Map(liveByWsRef.current);
    for (const id of stale) next.delete(id);
    liveByWsRef.current = next;
    setLiveByWs(next);
  }, []);

  const refresh = useCallback((wsId: string): void => {
    if (inFlightRef.current.has(wsId)) return;
    const request = {};
    inFlightRef.current.set(wsId, request);
    void listWorkspaceRpcLiveSessions(wsId)
      .then((rows) => {
        if (inFlightRef.current.get(wsId) !== request) return;
        applyRows(wsId, rows);
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

  return { liveByWs, applyRows, refresh, removeWorkspace, prune };
}
