import { flushSync } from "react-dom";
import { runViewTransition } from "../../lib/viewTransition";

/**
 * Session-switch continuity (G15/S22): the pane's transcript crossfades to the
 * new session while the rest of the shell holds still. SplitView renders each
 * leaf as `.th-pane-wrap[data-pane-id]`; the transcript lives in
 * `.th-chat-scrollport` and remounts per session, so the region is named
 * twice — before the transition (outgoing snapshot) and inside the update
 * callback after React commits (incoming snapshot) — under one unique
 * view-transition-name, paired with the th-pane-session class that
 * view-transitions.css clocks with --th-dur / --th-ease-out.
 *
 * The update runs exactly once on every path; rapid repeats join the helper's
 * latest-wins lane so a burst of clicks ends on the last session.
 */
const TRANSCRIPT_REGION_SELECTOR = ".th-chat-scrollport";

export const PANE_SESSION_TRANSITION_CLASS = "th-pane-session";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const FALLBACK_CROSSFADE_MS = 200;
const CLEANUP_MARGIN_MS = 50;

let transitionSeq = 0;
// Per-pane guard so a stale cleanup timer cannot un-name a newer switch.
const cleanupEpochs = new Map<string, number>();

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

// Same precondition as the helper's animated path (DESIGN.md, Motion).
function canAnimate(): boolean {
  return typeof document.startViewTransition === "function" && !prefersReducedMotion();
}

function findPane(paneId: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(".th-pane-wrap[data-pane-id]")) {
    if (el.dataset["paneId"] === paneId) return el;
  }
  return null;
}

function findRegion(paneId: string): HTMLElement | null {
  return findPane(paneId)?.querySelector<HTMLElement>(TRANSCRIPT_REGION_SELECTOR) ?? null;
}

function supportsTransitionClass(): boolean {
  try {
    return (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("view-transition-class", PANE_SESSION_TRANSITION_CLASS)
    );
  } catch {
    return false;
  }
}

function nameRegion(region: HTMLElement, name: string): void {
  region.style.setProperty("view-transition-name", name);
  if (supportsTransitionClass()) {
    region.style.setProperty("view-transition-class", PANE_SESSION_TRANSITION_CLASS);
  }
}

function crossfadeMs(): number {
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue("--th-dur");
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* jsdom and pre-hydration hosts: contract default below */
  }
  return FALLBACK_CROSSFADE_MS;
}

function scheduleNameCleanup(paneId: string, name: string, epoch: number): void {
  cleanupEpochs.set(paneId, epoch);
  window.setTimeout(() => {
    if (cleanupEpochs.get(paneId) !== epoch) return;
    cleanupEpochs.delete(paneId);
    const region = findRegion(paneId);
    if (region && region.style.getPropertyValue("view-transition-name") === name) {
      region.style.removeProperty("view-transition-name");
      region.style.removeProperty("view-transition-class");
    }
  }, crossfadeMs() + CLEANUP_MARGIN_MS);
}

export function applyPaneSessionTransition(paneId: string, update: () => void): void {
  if (!canAnimate()) {
    update();
    return;
  }

  transitionSeq += 1;
  const name = `th-pane-session-${transitionSeq}`;
  const epoch = transitionSeq;

  const outgoing = findRegion(paneId);
  if (outgoing) nameRegion(outgoing, name);

  runViewTransition(() => {
    flushSync(update);
    const incoming = findRegion(paneId);
    if (incoming) nameRegion(incoming, name);
  }, { latestWins: true });

  scheduleNameCleanup(paneId, name, epoch);
}
