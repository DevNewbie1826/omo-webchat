import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CommandEntry } from "../../lib/chatWs";
import type { ChatSessionRef } from "../workspace/workspace";
import type { PendingImage } from "./chatSessionTypes";

type SessionIdentity = Pick<ChatSessionRef, "wsId" | "id">;
interface ComposerDraft {
  readonly text: string;
  readonly image: PendingImage | null;
  readonly command: CommandEntry | null;
}
const EMPTY_DRAFT: ComposerDraft = { text: "", image: null, command: null };
const draftKey = (session: SessionIdentity): string => JSON.stringify([session.wsId, session.id]);
type DraftPatch = Partial<ComposerDraft>;
interface SessionDraftStore {
  readonly drafts: ReadonlyMap<string, ComposerDraft>;
  readonly patch: (key: string, update: DraftPatch) => void;
}
const SessionDraftContext = createContext<SessionDraftStore | null>(null);

/** Mounted inside the authenticated App: placement never owns or deletes a draft. */
export function SessionDraftProvider({ sessions, children }: {
  readonly sessions: ReadonlyMap<string, ChatSessionRef>;
  readonly children: ReactNode;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ComposerDraft>>(() => new Map());
  const keys = useMemo(() => new Set([...sessions.values()].map(draftKey)), [sessions]);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const patch = useCallback((key: string, update: DraftPatch): void => {
    // A file read may finish after its session was deleted, but not resurrect it.
    if (!keysRef.current.has(key)) return;
    setDrafts(current => new Map(current).set(key, { ...(current.get(key) ?? EMPTY_DRAFT), ...update }));
  }, []);
  useEffect(() => {
    setDrafts(current => [...current.keys()].every(key => keys.has(key))
      ? current
      : new Map([...current].filter(([key]) => keys.has(key))));
  }, [keys]);
  const store = useMemo(() => ({ drafts, patch }), [drafts, patch]);
  return <SessionDraftContext.Provider value={store}>{children}</SessionDraftContext.Provider>;
}

export function useSessionDraft(session?: SessionIdentity) {
  const store = useContext(SessionDraftContext);
  // Standalone composers keep their existing component-local lifecycle.
  const [local, setLocal] = useState(EMPTY_DRAFT);
  const key = session ? draftKey(session) : null;
  const patch = store?.patch;
  const update = useCallback((value: DraftPatch): void => {
    if (patch && key !== null) patch(key, value);
    else setLocal(current => ({ ...current, ...value }));
  }, [key, patch]);
  const draft = store && key !== null ? store.drafts.get(key) ?? EMPTY_DRAFT : local;
  const setInput = useCallback((text: string) => update({ text }), [update]);
  const setPendingImage = useCallback((image: PendingImage | null) => update({ image }), [update]);
  const setDraftCommand = useCallback((command: CommandEntry | null) => update({ command }), [update]);
  return { input: draft.text, pendingImage: draft.image, draftCommand: draft.command, setInput, setPendingImage, setDraftCommand };
}
