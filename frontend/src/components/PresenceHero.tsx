import type { ReactNode } from "react";

export interface PresenceHeroProps {
  readonly greeting: string;
  readonly hint: string;
  readonly action?: ReactNode;
}

/** Orb + Display-tier greeting + hint, shared by the single-pane empty state
 * and the desktop session picker (G32). The CSS entrance replays whenever
 * these nodes remount, so callers must keep them unkeyed and unconditional to
 * play exactly once per mount. */
export function PresenceHero({ greeting, hint, action }: PresenceHeroProps) {
  return (
    <div className="th-empty-hero">
      <div className="th-empty-orb" aria-hidden="true" />
      <h2 className="th-empty-title">{greeting}</h2>
      <p className="th-empty-hint">{hint}</p>
      {action}
    </div>
  );
}
