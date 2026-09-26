import { beforeEach, expect, it } from "vitest";
import { parseChatServerFrame } from "../../lib/chatWs";
import {
  __resetLiveBadgeStoreForTests, bindAttachedBadgeSource, ingestExtensionEvent, projectLiveTaskInfo,
} from "./liveBadgeStore";
import { admitsAttachedBinding } from "./liveAttachedBindings";
import { liveAcceptedBinding } from "./liveSessionIdentity";
import { LiveSessionMembership } from "./liveSessionMembership";
import { parseLiveSummarySessions } from "./useLiveSessionsLean";
import { wire } from "./liveSession.readyOrder.fixture";

beforeEach(__resetLiveBadgeStoreForTests);

const transports = ["poll", "push"] as const;
function acceptRow(membership: LiveSessionMembership, transport: typeof transports[number], bindingId: string, revision: number): void {
  const row = {
    id: "A", sessionId: "A", durableSessionId: "X", bindingId, title: "A",
    type: "sessions.activity", overflow: false, last_activity_ms: revision,
    running: { agents: 2, tasks: 2, dag: 0 },
  };
  if (transport === "poll") {
    membership.poll(parseLiveSummarySessions({ sessions: [row] }), revision);
  } else {
    const frame = parseChatServerFrame(row);
    if (frame?.type !== "sessions.activity") throw new TypeError("Expected overview row");
    membership.push(frame, revision);
  }
}

const provenance = (bindingId: string) => ({
  attemptToken: {}, instanceId: undefined, connection: 1, currentConnection: 1,
  durableSessionId: "X", bindingId,
});

it.each(transports)("promotes a pending ready only when %s accepts its binding", (transport) => {
  // Given a ready whose overview transition has not arrived.
  const membership = new LiveSessionMembership();
  acceptRow(membership, transport, "old", 10);
  const pending = provenance("new");
  bindAttachedBadgeSource("A", pending);
  expect(admitsAttachedBinding(pending, liveAcceptedBinding("A")?.bindingId)).toBe(false);
  acceptRow(membership, transport, "old", 10);
  expect(admitsAttachedBinding(pending, liveAcceptedBinding("A")?.bindingId)).toBe(false);
  // A queued Y heartbeat can arrive after ready(X), despite predating its bind.
  acceptRow(membership, transport, "old", 11);
  expect(admitsAttachedBinding(pending, liveAcceptedBinding("A")?.bindingId)).toBe(false);
  // When the matching incarnation is accepted, its source becomes writable.
  acceptRow(membership, transport, "new", 12);
  expect(admitsAttachedBinding(pending, liveAcceptedBinding("A")?.bindingId)).toBe(true);
});

it.each(transports)("retires a matched ready after %s accepts a newer different binding", (transport) => {
  // Given a pending source, with no authority to write.
  const membership = new LiveSessionMembership();
  acceptRow(membership, transport, "old", 10);
  const pending = provenance("pending");
  bindAttachedBadgeSource("A", pending);
  acceptRow(membership, transport, "pending", 11);
  // Once matched, a newer different publication proves supersession.
  acceptRow(membership, transport, "other", 12);
  acceptRow(membership, transport, "pending", 13);
  expect(admitsAttachedBinding(pending, liveAcceptedBinding("A")?.bindingId)).toBe(false);
  const current = provenance("pending");
  bindAttachedBadgeSource("A", current);
  expect(admitsAttachedBinding(current, liveAcceptedBinding("A")?.bindingId)).toBe(true);
});

it.each(transports)("clears same-durable authority when %s accepts a new binding", (transport) => {
  // Given seven tasks belonging to the old binding on durable X.
  const membership = new LiveSessionMembership();
  acceptRow(membership, transport, "old", 10);
  const old = provenance("old");
  bindAttachedBadgeSource("A", old);
  ingestExtensionEvent("A", wire.task.name, wire.task.data, old, 11);
  expect(projectLiveTaskInfo({ id: "A" })).toHaveProperty("task");
  // When X is rebound without changing its durable ID, old data is removed.
  acceptRow(membership, transport, "new", 11);
  for (const frame of [wire.task, wire.dag, wire.activity]) {
    ingestExtensionEvent("A", frame.name, frame.data, old, 12);
  }
  expect(projectLiveTaskInfo({ id: "A" })).toEqual({ id: "A" });
  expect(membership.values()[0]?.bindingId).toBe("new");
});

it.each(transports)("rejects tied and older %s binding substitutions", (transport) => {
  // Given a current overview identity.
  const membership = new LiveSessionMembership();
  acceptRow(membership, transport, "current", 10);
  // When older or tied rows claim another binding, identity stays unchanged.
  acceptRow(membership, transport, "older", 9);
  acceptRow(membership, transport, "tied", 10);
  expect(liveAcceptedBinding("A")?.bindingId).toBe("current");
});

it("requires each attached event to carry the ready's binding", () => {
  const membership = new LiveSessionMembership();
  acceptRow(membership, "push", "current", 10);
  const ready = provenance("current");
  bindAttachedBadgeSource("A", ready);
  for (const bindingId of [undefined, "buffered-old"]) {
    for (const frame of [wire.task, wire.dag, wire.activity]) {
      ingestExtensionEvent("A", frame.name, frame.data, { ...ready, bindingId }, 11);
    }
  }
  expect(projectLiveTaskInfo({ id: "A" })).toEqual({ id: "A" });
  ingestExtensionEvent("A", wire.task.name, wire.task.data, ready, 11);
  expect(projectLiveTaskInfo({ id: "A" })).toHaveProperty("task");
});

it.each([null, 7, ""])("rejects malformed bindingId %s at the WS boundary", (bindingId) => {
  expect(parseChatServerFrame({ ...wire.task, bindingId })).toBeNull();
  expect(parseChatServerFrame({ ...wire.firstOverview[0], bindingId })).toBeNull();
});
