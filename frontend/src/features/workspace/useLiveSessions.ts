import { useEffect, useState } from "react";
import { listLiveSessions } from "./workspace";

const POLL_MS = 4000;
const STALL_MS = 30000;

function sameLiveSet(previous: ReadonlySet<string>, ids: readonly string[]): boolean {
  if (previous.size !== ids.length) return false;
  for (const id of ids) {
    if (!previous.has(id)) return false;
  }
  return true;
}

export function useLiveSessions(enabled: boolean): ReadonlySet<string> {
  const [liveSessions, setLiveSessions] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!enabled) {
      setLiveSessions(new Set());
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let stallGuard: number | undefined;
    let activeCtrl: AbortController | undefined;
    // Chained scheduling serializes polls: the next request starts only after the
    // current one settles, so requests never overlap (no stale overwrite, no
    // pile-up) and every successful response applies (no starvation under a slow
    // backend). A transient failure leaves the last known-good set in place, and
    // a snapshot that matches the previous one is reused to avoid a rerender.
    // The stall guard aborts a request that never settles before rescheduling,
    // so a hung backend cannot accumulate overlapping requests.
    const tick = (): void => {
      if (cancelled) return;
      let settled = false;
      let superseded = false;
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const reschedule = (): void => {
        if (settled) return;
        settled = true;
        if (stallGuard !== undefined) window.clearTimeout(stallGuard);
        if (activeCtrl === ctrl) activeCtrl = undefined;
        if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
      };
      void listLiveSessions(ctrl.signal).then(
        (ids) => {
          if (!cancelled && !superseded) {
            setLiveSessions((previous) => (
              sameLiveSet(previous, ids) ? previous : new Set(ids)
            ));
          }
          reschedule();
        },
        reschedule,
      );
      stallGuard = window.setTimeout(() => {
        superseded = true;
        ctrl.abort();
        reschedule();
      }, STALL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (stallGuard !== undefined) window.clearTimeout(stallGuard);
      activeCtrl?.abort();
    };
  }, [enabled]);

  return liveSessions;
}
