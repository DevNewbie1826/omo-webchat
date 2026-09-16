import { useRef } from "react";
import { concatEntries } from "./chatEntries";

/**
 * The binding's ordered history entries, in branch order.
 *
 * Non-final pages accumulate here and reconcile once, when the final page
 * arrives, instead of per frame; that terminal page commits the list and opens
 * the pane. A backward warm chunk (segment "head") carries entries EARLIER
 * than everything committed so far and prepends them, so the rendered branch
 * is always [head..., tail...].
 *
 * `historyRootKnown` is false while the committed list is known to start below
 * the branch root: the tail page says so with historyComplete false, and a
 * head chunk is itself proof that earlier history existed. Root-relative
 * bookkeeping (steer-mark ordinals) is only meaningful once it is true again.
 * Absent historyComplete keeps today's meaning — a terminal page is the whole
 * branch. Reset on reconnect so a partial load never mixes into a fresh one.
 */
export function useEntriesPageBuffer() {
  const bufferRef = useRef<unknown[]>([]);
  const committedRef = useRef<unknown[] | null>(null);
  const rootKnownRef = useRef(true);

  const push = (page: unknown): void => {
    bufferRef.current.push(page);
  };

  const consume = (finalPage: unknown, historyComplete?: boolean): unknown => {
    const buffered = bufferRef.current;
    bufferRef.current = [];
    const entries = buffered.length > 0 ? concatEntries([...buffered, finalPage]) : finalPage;
    committedRef.current = concatEntries([entries]);
    rootKnownRef.current = historyComplete !== false;
    return entries;
  };

  /**
   * Prepend one warm chunk and yield the whole ordered list. Null when no
   * terminal page has opened this binding yet: an orphan chunk left over from
   * a retired stream must never become the transcript on its own.
   */
  const prepend = (page: unknown, historyComplete?: boolean): unknown | null => {
    const committed = committedRef.current;
    if (committed === null) return null;
    const entries = concatEntries([page, committed]);
    committedRef.current = entries;
    rootKnownRef.current = historyComplete === true;
    return entries;
  };

  const historyRootKnown = (): boolean => rootKnownRef.current;

  const reset = (): void => {
    bufferRef.current = [];
    committedRef.current = null;
    rootKnownRef.current = true;
  };

  return { push, consume, prepend, historyRootKnown, reset };
}
