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
    expect(membership.values()).toEqual([row]);
  });
  it("recovers main activity without resurrecting completed children on a tied REST receipt", () => {
    const membership = new LiveSessionMembership();
    membership.poll([running], 1);
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: true, ...completed.lean }, 2);
    membership.disconnect(4);
    membership.poll([running], 3);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.poll([running], 5);
    expect(membership.values()[0]).toMatchObject({ active: true, lean: completed.lean });
    membership.poll([{ ...running, active: false }], 6);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: false, ...completed.lean }, 7);
    membership.poll([running], 8);
    expect(membership.values()[0]).toMatchObject({ active: false, lean: completed.lean });
    membership.poll([{ ...running, lean: { ...running.lean, last_activity_ms: 201 } }], 9);
    expect(membership.values()[0]).toMatchObject({ active: true, lean: { running: { agents: 7 } } });
  });
  it("accepts the later same-receipt REST observation", () => {
    // Given a running REST snapshot.
    const membership = new LiveSessionMembership();
    membership.poll([running], 1);
    // When the same transport reports completion at the same receipt.
    membership.poll([completed], 2);
    // Then completion is accepted, rather than rejecting every tied receipt.
    expect(membership.values()).toEqual([completed]);
  });
  it("keeps push provenance after subsequent polls consume the membership fence", () => {
    // Given a pushed completion and a later poll that acknowledges membership.
    const membership = new LiveSessionMembership();
    membership.push({ type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false,
      active: false, ...completed.lean }, 2);
    membership.poll([completed], 3);
    // When another REST observation ties the pushed receipt with stale work.
    membership.poll([running], 4);
    // Then cross-transport ties still favor push, independently of membership retention.
    expect(membership.values()[0]).toMatchObject({ active: false, lean: { running: { agents: 0 }, done: 7 } });
  });
});
