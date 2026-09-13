import { describe, expect, it } from "vitest";
import { compareLiveSessions, isLiveSessionListed } from "./liveSessionOrder";
import type { LiveSessionOrderable } from "./liveSessionOrder";

function session(partial: Partial<LiveSessionOrderable> & { readonly id: string }): LiveSessionOrderable {
  return { title: partial.id, runningCount: 0, ...partial };
}

function sorted(
  sessions: readonly LiveSessionOrderable[],
  recency: ReadonlyMap<string, number>,
): readonly string[] {
  return [...sessions].sort((a, b) => compareLiveSessions(a, b, recency)).map((s) => s.id);
}

describe("compareLiveSessions", () => {
  it("sorts a working session before an idle one even when the idle one is more recent", () => {
    const idle = session({ id: "idle" });
    const working = session({ id: "working", runningCount: 2 });
    const recency = new Map([["idle", 9000], ["working", 100]]);

    expect(sorted([idle, working], recency)).toEqual(["working", "idle"]);
  });

  it("treats main-session activity as working even with zero running children", () => {
    const active = session({ id: "active", active: true });
    const idle = session({ id: "idle" });

    expect(sorted([idle, active], new Map([["idle", 9000]]))).toEqual(["active", "idle"]);
  });

  it("orders by most recent activity inside each group", () => {
    const sessions = [
      session({ id: "idle-old" }),
      session({ id: "work-old", runningCount: 1 }),
      session({ id: "idle-new" }),
      session({ id: "work-new", active: true }),
    ];
    const recency = new Map([
      ["idle-old", 10],
      ["idle-new", 20],
      ["work-old", 30],
      ["work-new", 40],
    ]);

    expect(sorted(sessions, recency)).toEqual(["work-new", "work-old", "idle-new", "idle-old"]);
  });

  it("sorts sessions with a missing timestamp last within their group", () => {
    const sessions = [session({ id: "unknown" }), session({ id: "known" })];
    const recency = new Map([["known", 5]]);

    expect(sorted(sessions, recency)).toEqual(["known", "unknown"]);
  });

  it("breaks full ties by title then id so the order is total and stable", () => {
    const a = session({ id: "b-id", title: "Alpha" });
    const b = session({ id: "a-id", title: "Beta" });
    const c = session({ id: "c-id", title: "Alpha" });

    expect(sorted([c, b, a], new Map())).toEqual(["b-id", "c-id", "a-id"]);
    // Equal inputs compare as zero in both directions.
    expect(compareLiveSessions(a, session({ id: "b-id", title: "Alpha" }), new Map())).toBe(0);
  });
});

describe("isLiveSessionListed", () => {
  it("excludes legacy rows with no active flag and no running agents", () => {
    expect(isLiveSessionListed(session({ id: "done" }))).toBe(false);
  });

  it("lists sessions the server explicitly flags as attached, even when idle", () => {
    expect(isLiveSessionListed(session({ id: "idle", active: false }))).toBe(true);
    expect(isLiveSessionListed(session({ id: "busy", active: true }))).toBe(true);
  });

  it("lists sessions with running agents even without an active flag", () => {
    expect(isLiveSessionListed(session({ id: "agents", runningCount: 2 }))).toBe(true);
  });
});
