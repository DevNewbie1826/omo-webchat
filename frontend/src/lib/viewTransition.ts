/**
 * Apply a DOM update, using a same-document view transition when motion is allowed.
 *
 * `update` is invoked exactly once on every path that applies it. If
 * `document.startViewTransition` is missing or throws, or if the transition is
 * skipped and `ready`, `finished`, or `updateCallbackDone` rejects before the
 * callback runs, `update` still runs. A rejection after the callback has run
 * does not apply it again. Visual failure never blocks or repeats the state change.
 *
 * Latest-wins is opt-in (`{ latestWins: true }`) on one shared lane. A newer
 * latest-wins call drops an older latest-wins update that has not yet run, so
 * rapid repeats apply only the last write. An update that has already run is
 * not rolled back. Calls that omit the flag always apply; they neither drop
 * nor are dropped by the lane. Reduced motion and a missing API apply
 * immediately, so each of those calls is already current when it runs.
 *
 * Session-switch choreography belongs to T2. This helper only owns the update
 * guarantee and the root crossfade clock in global.css.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Monotonic id for the latest-wins lane. Calls that omit the flag do not touch it. */
let latestWinsEpoch = 0;

export interface RunViewTransitionOptions {
  /**
   * Join the shared latest-wins lane. A newer latest-wins call drops this
   * update when it has not run yet. Omit to apply this update exactly once
   * regardless of other calls.
   */
  readonly latestWins?: boolean;
}

/** Synchronous state write. A returned promise is forwarded to the view-transition API. */
export type ViewTransitionUpdate = () => void | Promise<void>;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/** A skipped or failed transition must still reach `apply`, and must not surface as an unhandled rejection. */
function recoverAfterVisualFailure(promise: Promise<void>, apply: () => unknown): void {
  void promise.catch(() => {
    apply();
  });
}

export function runViewTransition(update: ViewTransitionUpdate, options?: RunViewTransitionOptions): void {
  const latestWins = options?.latestWins === true;
  const ticket = latestWins ? ++latestWinsEpoch : 0;
  let settled = false;

  const apply = (): void | Promise<void> => {
    if (settled) return;
    if (latestWins && ticket !== latestWinsEpoch) {
      settled = true;
      return;
    }
    settled = true;
    return update();
  };

  if (prefersReducedMotion() || typeof document.startViewTransition !== "function") {
    apply();
    return;
  }

  try {
    const transition = document.startViewTransition(() => apply());
    recoverAfterVisualFailure(transition.ready, apply);
    recoverAfterVisualFailure(transition.finished, apply);
    recoverAfterVisualFailure(transition.updateCallbackDone, apply);
  } catch (error) {
    // The callback already ran (and may have thrown). Repeating it would double-apply.
    if (settled) throw error;
    apply();
  }
}
