/**
 * Apply a DOM update, using a same-document view transition when motion is allowed.
 *
 * `update` is invoked exactly once on every path that applies it. If
 * `document.startViewTransition` is missing or throws, or if the transition is
 * skipped and `ready`, `finished`, or `updateCallbackDone` rejects before the
 * callback runs, `update` still runs. A rejection after the callback has run
 * does not apply it again. Visual failure never blocks or repeats the state change.
 *
 * Latest-wins is opt-in (`{ latestWins: true }`), on a shared lane by default
 * or a named lane with `latestWinsKey`. A newer call drops pending work only
 * in its own lane. Calls that omit the flag always apply; reduced motion and
 * a missing API apply immediately in call order.
 *
 * Session-switch choreography belongs to T2. This helper only owns the update
 * guarantee and the root crossfade clock in global.css.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const SHARED_LANE = Symbol("shared-view-transition-lane");
/** Only pending tickets are retained; completed lanes need no history. */
const pendingLanes = new Map<string | symbol, symbol>();

export interface RunViewTransitionOptions {
  /**
   * Drop pending updates in this lane on a newer call. Omit to apply every
   * update exactly once regardless of other calls.
   */
  readonly latestWins?: boolean;
  /** Separate pending work by destination; omitted latest-wins calls share a lane. */
  readonly latestWinsKey?: string;
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
  const lane = options?.latestWinsKey ?? SHARED_LANE;
  const ticket = Symbol("view-transition-ticket");
  if (latestWins) pendingLanes.set(lane, ticket);
  let settled = false;

  const apply = (): void | Promise<void> => {
    if (settled) return;
    if (latestWins) {
      if (pendingLanes.get(lane) !== ticket) {
        settled = true;
        return;
      }
      pendingLanes.delete(lane);
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
