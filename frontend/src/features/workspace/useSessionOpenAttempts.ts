import { useCallback, useRef, useState } from "react";
import type { Workspace, WorkspaceSession } from "./workspace";

export type SessionOpenAttemptStatus = "opening" | "session-active" | "failed";
export type SessionOpenAttemptResult = "opened" | "session-active" | "failed" | void;

export function sessionOpenAttemptKey(wsId: string, sessionId: string): string {
  return `${wsId}:${sessionId}`;
}

/** Open-attempt state shared by the catalog and watcher live row families. */
export function useSessionOpenAttempts<S = WorkspaceSession>(
  onOpen: (ws: Workspace, session: S, force?: boolean) => Promise<"opened" | "session-active" | void>,
  sessionKey: (session: S) => string = (session) => (session as WorkspaceSession).id,
) {
  const [attempts, setAttempts] = useState<ReadonlyMap<string, SessionOpenAttemptStatus>>(new Map());
  const openingRef = useRef(new Set<string>());

  const open = useCallback(async (
    ws: Workspace,
    session: S,
    force = false,
  ): Promise<SessionOpenAttemptResult> => {
    const key = sessionOpenAttemptKey(ws.id, sessionKey(session));
    if (openingRef.current.has(key)) return;
    openingRef.current.add(key);
    setAttempts((current) => new Map(current).set(key, "opening"));
    try {
      const result = await onOpen(ws, session, force);
      setAttempts((current) => {
        const next = new Map(current);
        if (result === "session-active") next.set(key, "session-active");
        else next.delete(key);
        return next;
      });
      return result;
    } catch {
      setAttempts((current) => new Map(current).set(key, "failed"));
      return "failed";
    } finally {
      openingRef.current.delete(key);
    }
  }, [onOpen, sessionKey]);

  return { attempts, open };
}
