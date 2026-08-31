import { useEffect, useMemo, useState } from "react";
import {
  detectFileTrigger,
  isPathBrowseQuery,
  listDir,
  searchFiles,
  type FileMatch,
  type MentionListError,
} from "./fileSearch";

export type MentionMode = "search" | "browse";
export type MentionStatus = "ok" | "empty" | "outsideRoot" | "notFound";

export interface FileMention {
  readonly open: boolean;
  readonly results: readonly FileMatch[];
  readonly loading: boolean;
  readonly activeIndex: number;
  readonly setActiveIndex: (index: number) => void;
  readonly hide: () => void;
  readonly reset: () => void;
  readonly mode: MentionMode;
  readonly status: MentionStatus;
  readonly capped: boolean;
}

const SEARCH_DEBOUNCE_MS = 120;

interface FetchOutcome {
  readonly entries: readonly FileMatch[];
  readonly capped: boolean;
  readonly error: MentionListError | undefined;
}

export function useFileMention(cwd: string, input: string, caret: number): FileMention {
  const trigger = useMemo(() => detectFileTrigger(input, caret), [input, caret]);
  const query = trigger?.query ?? "";
  const browse = isPathBrowseQuery(query);
  const [results, setResults] = useState<readonly FileMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<MentionStatus>("ok");
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    setHidden(false);
  }, [trigger?.start ?? -1, query]);

  useEffect(() => {
    if (!trigger || hidden) {
      setResults([]);
      setLoading(false);
      setActiveIndex(-1);
      setStatus("ok");
      setCapped(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    const handle = window.setTimeout(() => {
      const outcome: Promise<FetchOutcome> = browse
        ? listDir(cwd, query, ctrl.signal)
            .then((r): FetchOutcome => ({ entries: r.entries, capped: r.capped, error: undefined }))
            .catch((e: MentionListError): FetchOutcome => ({ entries: [], capped: false, error: e }))
        : searchFiles(cwd, query, ctrl.signal).then(
            (r): FetchOutcome => ({ entries: r, capped: false, error: undefined }),
          );
      void outcome.then(({ entries, capped: cap, error }) => {
        if (cancelled) return;
        setResults(entries);
        setLoading(false);
        setCapped(cap);
        if (error) setStatus(error.kind);
        else {
          // A browsed folder always carries the synthetic ".." row, so "empty"
          // means no real entries (covers both browse and search modes).
          const real = entries.filter((e) => !e.isParent);
          setStatus(real.length === 0 ? "empty" : "ok");
        }
        setActiveIndex(entries.length > 0 ? (entries[0]?.isParent && entries.length > 1 ? 1 : 0) : -1);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(handle);
    };
  }, [cwd, trigger, query, hidden, browse]);

  const open = !!trigger && !hidden;
  const clamped = results.length > 0 ? Math.min(Math.max(activeIndex, 0), results.length - 1) : -1;

  return {
    open,
    results,
    loading: open && loading,
    activeIndex: clamped,
    setActiveIndex,
    hide: () => setHidden(true),
    reset: () => {
      setHidden(false);
      setActiveIndex(-1);
      setResults([]);
      setStatus("ok");
      setCapped(false);
    },
    mode: browse ? "browse" : "search",
    status,
    capped,
  };
}
