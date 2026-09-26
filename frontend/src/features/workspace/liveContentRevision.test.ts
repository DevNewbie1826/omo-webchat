import { beforeEach, expect, it } from "vitest";
import { __resetLiveBadgeStoreForTests } from "./liveBadgeStore";
import { LiveSessionMembership } from "./liveSessionMembership";
import {
  acceptAttachedContentRevision, migrateLiveContentRevision, observeLiveContentRevision,
  resetLiveContentRevisions,
} from "./liveContentRevision";

beforeEach(__resetLiveBadgeStoreForTests);

it("retains the attached high watermark across a same-binding row migration", () => {
  observeLiveContentRevision("durable", "binding", 100);
  expect(acceptAttachedContentRevision("durable", "binding", 300)).toBe(true);
  migrateLiveContentRevision("durable", "chat", "binding");
  observeLiveContentRevision("chat", "binding", 200);
  expect(acceptAttachedContentRevision("chat", "binding", 250)).toBe(false);
  expect(acceptAttachedContentRevision("chat", "binding", 301)).toBe(true);
});

it("keeps revision authority independent for different rows", () => {
  observeLiveContentRevision("A", "binding", 300);
  observeLiveContentRevision("B", "binding", 100);
  expect(acceptAttachedContentRevision("B", "binding", 200)).toBe(true);
});

it("does not transfer content authority into a different binding", () => {
  observeLiveContentRevision("durable", "old", 300);
  migrateLiveContentRevision("durable", "chat", "new");
  observeLiveContentRevision("chat", "new", 100);
  expect(acceptAttachedContentRevision("chat", "new", 200)).toBe(true);
});

it("rejects legacy content after the first versioned attached delivery", () => {
  expect(acceptAttachedContentRevision("A", "binding", undefined)).toBe(true);
  expect(acceptAttachedContentRevision("A", "binding", 10)).toBe(true);
  expect(acceptAttachedContentRevision("A", "binding", undefined)).toBe(false);
});

it("resets revision authority when the server instance changes", () => {
  observeLiveContentRevision("A", "binding", 300);
  resetLiveContentRevisions();
  expect(acceptAttachedContentRevision("A", "binding", 100)).toBe(true);
});

it("retains the content fence when membership temporarily omits the same binding", () => {
  const membership = new LiveSessionMembership();
  const row = {
    type: "sessions.activity" as const, sessionId: "A", durableSessionId: "X",
    bindingId: "binding", overflow: false, last_activity_ms: 100,
  };
  membership.push(row, 1);
  expect(acceptAttachedContentRevision("A", "binding", 300)).toBe(true);
  membership.poll([], 2);
  membership.push({ ...row, last_activity_ms: 200 }, 3);
  expect(acceptAttachedContentRevision("A", "binding", 250)).toBe(false);
});

it("keeps the content watermark in the floor when retired identity history is evicted", () => {
  const membership = new LiveSessionMembership();
  const row = {
    type: "sessions.activity" as const, sessionId: "A", durableSessionId: "X",
    bindingId: "binding", overflow: false, last_activity_ms: 100,
  };
  membership.push(row, 1);
  expect(acceptAttachedContentRevision("A", "binding", 300)).toBe(true);
  membership.poll([], 2);
  for (let index = 0; index < 513; index += 1) {
    membership.push({ ...row, sessionId: `row-${index}`, durableSessionId: `durable-${index}`,
      last_activity_ms: 1000 + index }, index * 2 + 3);
    membership.poll([], index * 2 + 4);
  }
  membership.push({ ...row, last_activity_ms: 250 }, 2000);
  expect(membership.values()).toEqual([]);
});
