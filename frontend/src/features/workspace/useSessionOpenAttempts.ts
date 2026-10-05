import { useCallback, useRef, useState } from "react";
import type { Workspace, WorkspaceSession } from "./workspace";

export type SessionOpenAttemptStatus = "opening" | "session-active" | "failed";
export type SessionOpenAttemptResult = "opened" | "session-active" | "failed" | void;

export function sessionOpenAttemptKey(wsId: string, sessionId: string): string {
  return `${wsId}:${sessionId}`;
}

export function useSessionOpenAttempts(
  onOpen: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active" | void>,
) {
  const [attempts, setAttempts] = useState<ReadonlyMap<string, SessionOpenAttemptStatus>>(new Map());
  const openingRef = useRef(new Set<string>());

  const open = useCallback(async (
    ws: Workspace,
    session: WorkspaceSession,
    force = false,
  ): Promise<SessionOpenAttemptResult> => {
    const key = sessionOpenAttemptKey(ws.id, session.id);
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
  }, [onOpen]);

  return { attempts, open };
}
