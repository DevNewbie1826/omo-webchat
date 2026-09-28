import { useEffect, useRef, useState } from "react";
import { fetchOlderHistory } from "../../lib/api";
import type { ChatSessionRef } from "../workspace/workspace";
import type { useChatFrameState } from "./useChatFrameState";

type OlderHistoryState = "idle" | "loading" | "error" | "complete" | "unavailable";

/** One pane owns one abortable page request, never the socket's replay queue. */
export function useOlderHistory(
  session: Pick<ChatSessionRef, "wsId" | "id">,
  frames: ReturnType<typeof useChatFrameState>,
  resync: () => boolean,
): { readonly state: OlderHistoryState; readonly loadOlder: () => void } {
  const [state, setState] = useState<OlderHistoryState>("idle");
  const requestRef = useRef<AbortController | null>(null);
  const staleRecoveredRef = useRef(false);
  const latestRef = useRef(frames);
  latestRef.current = frames;
  frames.olderHistoryInvalidationRef.current = (newConnection) => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (newConnection) staleRecoveredRef.current = false;
    setState("idle");
  };
  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, [session.wsId, session.id]);

  const loadOlder = (): void => {
    const context = latestRef.current.getOlderHistoryContext();
    if (requestRef.current || !context.ready || context.rootKnown || !context.cursor || state === "unavailable") return;
    const { cursor, connectionGeneration, replayGeneration } = context;
    const controller = new AbortController();
    requestRef.current = controller;
    setState("loading");
    void fetchOlderHistory(session.wsId, session.id, {
      session: cursor.sessionId, before: cursor.firstEntryId, limit: 100,
    }, controller.signal).then((result) => {
      if (requestRef.current !== controller || controller.signal.aborted) return;
      requestRef.current = null;
      const current = latestRef.current.getOlderHistoryContext();
      if (current.connectionGeneration !== connectionGeneration
        || current.replayGeneration !== replayGeneration
        || current.cursor?.sessionId !== cursor.sessionId
        || current.cursor.firstEntryId !== cursor.firstEntryId) {
        setState("idle");
        return;
      }
      switch (result.kind) {
        case "page":
          if (result.sessionId !== cursor.sessionId) {
            setState("error");
            return;
          }
          latestRef.current.handleFrame({
            type: "entries", sessionId: session.id, segment: "head",
            historySessionId: result.sessionId, historyComplete: result.historyComplete,
            entries: result.entries,
          }, connectionGeneration);
          staleRecoveredRef.current = false;
          setState(result.historyComplete ? "complete" : "idle");
          return;
        case "stale":
          if (staleRecoveredRef.current) {
            setState("error");
            return;
          }
          staleRecoveredRef.current = true;
          if (!resync()) setState("error");
          return;
        case "gone":
          setState("unavailable");
          return;
        case "busy":
        case "error":
          setState("error");
          return;
        case "aborted":
          setState("idle");
          return;
      }
    });
  };

  return { state: frames.historyRootKnown ? "complete" : state, loadOlder };
}
