import { afterEach, describe, expect, it } from "vitest";
import { __resetLiveBadgeStoreForTests } from "./liveBadgeStore";
import { LiveSessionMembership } from "./liveSessionMembership";

const running = { id: "s", title: "Session", active: true, task: null, dag: null,
  lean: { last_activity_ms: 200, running: { agents: 7 }, done: 0 } };
const completed = { ...running, active: false, lean: { ...running.lean, running: { agents: 0 }, done: 7 } };

describe("lean membership receipt provenance", () => {
  afterEach(() => __resetLiveBadgeStoreForTests());
  it("restores unchanged activity from post-disconnect polls while fencing an in-flight response", () => {
    const membership = new LiveSessionMembership();
    const row = { ...completed, active: true, lean: { ...completed.lean, last_activity_ms: 300 } };
    membership.poll([row], 1);
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: true, ...row.lean }, 2);
    membership.disconnect(4);
    expect(membership.values()[0]?.active).toBe(false);
    membership.poll([row], 3);
    expect(membership.values()[0]?.active).toBe(false);
    membership.poll([row], 5);
    expect(membership.values()[0]?.active).toBe(true);
    membership.poll([row], 6);
    expect(membership.values()).toEqual([{ ...row, durableSessionId: "s" }]);
  });
  it("rejects older REST children after disconnect and recovers on a newer revision", () => {
    const membership = new LiveSessionMembership();
    const olderRunning = { ...running, lean: { ...running.lean, last_activity_ms: 199 } };
    membership.poll([olderRunning], 1);
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: true, ...completed.lean }, 2);
    membership.disconnect(4);
    membership.poll([olderRunning], 3);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.poll([olderRunning], 5);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.poll([{ ...olderRunning, active: false }], 6);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: false, ...completed.lean }, 7);
    membership.poll([olderRunning], 8);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.poll([{ ...running, lean: { ...running.lean, last_activity_ms: 201 } }], 9);
    expect(membership.values()[0]).toMatchObject({ active: true, lean: { running: { agents: 7 } } });
  });
  it("accepts a newer REST completion observation", () => {
    // Given a running REST snapshot.
    const membership = new LiveSessionMembership();
    membership.poll([running], 1);
    // When the same transport reports a server-issued completion revision.
    const newerCompleted = { ...completed, lean: { ...completed.lean, last_activity_ms: 201 } };
    membership.poll([newerCompleted], 2);
    expect(membership.values()).toEqual([newerCompleted]);
  });
  it("keeps push provenance after subsequent polls consume the membership fence", () => {
    // Given a pushed completion and a later poll that acknowledges membership.
    const membership = new LiveSessionMembership();
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: false, ...completed.lean }, 2);
    membership.poll([completed], 3);
    // When another REST observation carries an older revision with stale work.
    membership.poll([{ ...running, lean: { ...running.lean, last_activity_ms: 199 } }], 4);
    // Then the older REST row cannot replace the pushed completion.
    expect(membership.values()[0]).toMatchObject({ active: false, lean: { running: { agents: 0 }, done: 7 } });
  });
});
