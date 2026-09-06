import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { ChatSendStore } from "./chatSendState";
import type { ReactNode } from "react";
import type { CommandEntry } from "../../lib/chatWs";
import type { ChatSessionRef } from "../workspace/workspace";
import type { PendingImage, RecoveredChatDraft } from "./chatSessionTypes";

type SessionIdentity = Pick<ChatSessionRef, "wsId" | "id">;
interface ComposerDraft {
  readonly text: string;
  readonly image: PendingImage | null;
  readonly command: CommandEntry | null;
  /** Cleared by every user mutation, even an edit back to identical content. */
  readonly recoveryRequestId: string | null;
}
const EMPTY_DRAFT: ComposerDraft = { text: "", image: null, command: null, recoveryRequestId: null };
const draftKey = (session: SessionIdentity): string => JSON.stringify([session.wsId, session.id]);
type DraftPatch = Partial<ComposerDraft>;
type DraftUpdate = (current: ComposerDraft) => ComposerDraft;
interface SessionDraftStore {
  readonly sends: Map<string, ChatSendStore>;
  readonly drafts: ReadonlyMap<string, ComposerDraft>;
  readonly patch: (key: string, update: DraftUpdate) => void;
}
const SessionDraftContext = createContext<SessionDraftStore | null>(null);

/** Mounted inside the authenticated App: placement never owns or deletes a draft. */
export function SessionDraftProvider({ sessions, children }: {
  readonly sessions: ReadonlyMap<string, ChatSessionRef>;
  readonly children: ReactNode;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ComposerDraft>>(() => new Map());
  const [sends] = useState(() => new Map<string, ChatSendStore>());
  const keys = useMemo(() => new Set([...sessions.values()].map(draftKey)), [sessions]);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const patch = useCallback((key: string, update: DraftUpdate): void => {
    // A file read may finish after its session was deleted, but not resurrect it.
    if (!keysRef.current.has(key)) return;
    setDrafts(current => {
      const before = current.get(key) ?? EMPTY_DRAFT;
      const after = update(before);
      return after === before ? current : new Map(current).set(key, after);
    });
  }, []);
  useEffect(() => {
    for (const key of sends.keys()) if (!keys.has(key)) sends.delete(key);
    setDrafts(current => [...current.keys()].every(key => keys.has(key))
      ? current
      : new Map([...current].filter(([key]) => keys.has(key))));
  }, [keys, sends]);
  const store = useMemo(() => ({ drafts, patch, sends }), [drafts, patch, sends]);
  return <SessionDraftContext.Provider value={store}>{children}</SessionDraftContext.Provider>;
}

export function useSessionDraft(session?: SessionIdentity) {
  const store = useContext(SessionDraftContext);
  // Standalone composers keep their existing component-local lifecycle.
  const [local, setLocal] = useState(EMPTY_DRAFT);
  const key = session ? draftKey(session) : null;
  const patch = store?.patch;
  const mutate = useCallback((update: DraftUpdate): void => {
    if (patch && key !== null) patch(key, update);
    else setLocal(update);
  }, [key, patch]);
  const update = useCallback((value: DraftPatch): void => {
    mutate(current => ({ ...current, ...value, recoveryRequestId: null }));
  }, [mutate]);
  const restoreDraft = useCallback((recovered: RecoveredChatDraft): void => {
    mutate(current => {
      if (!recovered.explicit && (current.text !== "" || current.image !== null || current.command !== null)) return current;
      return { text: recovered.text, image: recovered.image, command: recovered.command ?? null,
        recoveryRequestId: recovered.explicit ? null : recovered.requestId ?? null };
    });
  }, [mutate]);
  const cancelRecovery = useCallback((requestIds: ReadonlySet<string>): void => {
    mutate(current => current.recoveryRequestId && requestIds.has(current.recoveryRequestId) ? EMPTY_DRAFT : current);
  }, [mutate]);
  const draft = store && key !== null ? store.drafts.get(key) ?? EMPTY_DRAFT : local;
  const setInput = useCallback((text: string) => update({ text }), [update]);
  const setPendingImage = useCallback((image: PendingImage | null) => update({ image }), [update]);
  const setDraftCommand = useCallback((command: CommandEntry | null) => update({ command }), [update]);
  return { input: draft.text, pendingImage: draft.image, draftCommand: draft.command, setInput, setPendingImage, setDraftCommand, restoreDraft, cancelRecovery };
}

/** Same authenticated workspace/chat lifetime as unsent composer drafts. */
export function useSessionSends(session?: SessionIdentity) {
  const owner = useContext(SessionDraftContext);
  const [local] = useState(() => new ChatSendStore());
  let store = local;
  if (owner && session) {
    const key = draftKey(session);
    let shared = owner.sends.get(key);
    if (!shared) { shared = new ChatSendStore(); owner.sends.set(key, shared); }
    store = shared;
  }
  const requests = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, requests };
}
