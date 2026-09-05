import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChatServerFrame, type ChatServerFrame } from "../../lib/chatWs";
import disk from "../../../../internal/session/testdata/receiver-disk.json";
import tail from "../../../../internal/session/testdata/receiver-tail.json";
import exhausted from "../../../../internal/session/testdata/receiver-exhausted.json";
import { messageText } from "./chatEntries";
import { mountReconnectHarness, session, unmountReconnectHarness, type ReconnectHarness } from "./useChatSession.reconnect.support";

const ready: ChatServerFrame = { type: "ready", sessionId: session.id, piSessionId: "durable-chat-1", resumed: true };
const saved = [
  { type: "message", id: "saved-1", message: { role: "user", content: "saved prompt" } },
  { type: "message", id: "saved-2", message: { role: "assistant", content: "saved reply" } },
];
const terminal: ChatServerFrame = { type: "entries", sessionId: session.id, entries: saved, final: true };
const expectedIds = Array.from({ length: 201 }, (_, i) => `entry-${String(i).padStart(4, "0")}`);

// These are immutable Go receiver recordings, not a synthetic successful-only
// replay. Only stable routing IDs were normalized by the Go assertion.
function frames(recording: readonly unknown[]): ChatServerFrame[] {
  return recording.map((value) => {
    const frame = parseChatServerFrame(value);
    if (frame === null) throw new Error("Recorded receiver frame violates the wire contract");
    return frame;
  });
}

describe("receiver hydration attempt boundary", () => {
  let harness: ReconnectHarness;
  beforeEach(() => { harness = mountReconnectHarness(); });
  afterEach(async () => { await unmountReconnectHarness(harness); });
  const deliver = (frame: ChatServerFrame) => act(() => harness.deliver(frame));
  const ids = () => harness.current?.messages.map((message) => message.id);
  const settle = () => { deliver(ready); deliver(terminal); };

  it.each([["disk", disk, 100], ["pre-tail", tail, 201]] as const)(
    "discards delivered %s pages on replacement, not completed or intervening live messages",
    (_boundary, recording, failedCount) => {
      settle();
      act(() => { expect(harness.current?.resync()).toBe(true); });
      const stream = frames(recording);
      const replacement = stream.findIndex((frame, i) => i > 0 && frame.type === "ready");
      const failed = stream.slice(0, replacement);
      expect(failed.flatMap((frame) => frame.type === "entries" ? frame.entries : [])).toHaveLength(failedCount);
      expect(failed.some((frame) => frame.type === "entries" && frame.final !== false)).toBe(false);
      failed.forEach(deliver);
      expect(ids()).toEqual(["saved-1", "saved-2"]);
      expect(harness.current?.historyStatus).toBe("loading");
      deliver({ type: "message", sessionId: session.id, message: { role: "assistant", blocks: [{ kind: "text", text: "intervening live" }] } });
      stream.slice(replacement).forEach(deliver);
      expect(ids()?.slice(0, 201)).toEqual(expectedIds);
      expect(harness.current?.messages.map(messageText)).toEqual([...Array<string>(201).fill("x"), "intervening live"]);
      expect(harness.current?.historyStatus).toBe("loaded");
      expect(harness.current?.historyLoaded).toBe(true);
      deliver({ type: "message", sessionId: session.id, message: { role: "assistant", blocks: [{ kind: "text", text: "subsequent live" }] } });
      expect(harness.current?.messages.map(messageText).at(-1)).toBe("subsequent live");
      expect(ids()?.slice(0, 201)).toEqual(expectedIds);
    },
  );

  it("does not reset first-ready pages, including a delayed initial acknowledgement", () => {
    const stream = frames(disk);
    const page = stream.find((frame) => frame.type === "entries");
    expect(page).toBeDefined();
    deliver(page!);
    deliver(ready);
    deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
    expect(ids()).toEqual(expectedIds.slice(0, 100));
  });

  it("keeps a delayed completed-attach ready separate from the current resync attempt", () => {
    deliver(terminal);
    act(() => { expect(harness.current?.resync()).toBe(true); });
    deliver(ready); // Acknowledges the older, already completed attach.
    expect(harness.current?.resyncBusy).toBe(true);
    frames(disk).forEach(deliver);
    expect(ids()).toEqual(expectedIds);
    expect(harness.current?.resyncBusy).toBe(false);
  });

  it("retires interrupted pages and their ready claim on connection cancellation", () => {
    settle();
    act(() => { expect(harness.current?.resync()).toBe(true); });
    frames(exhausted).forEach(deliver);
    act(() => harness.disconnect());
    expect(harness.current?.resyncBusy).toBe(false);
    expect(harness.current?.historyStatus).toBe("failed");
    expect(ids()).toEqual(["saved-1", "saved-2"]);
    act(() => harness.reconnect());
    frames(tail).forEach(deliver);
    expect(ids()).toEqual(expectedIds);
    expect(harness.current?.historyStatus).toBe("loaded");
  });

  it("tracks replacement attempts on an unsolicited same-socket query replay too", () => {
    settle();
    frames(disk).forEach(deliver);
    expect(ids()).toEqual(expectedIds);
  });

  it("retains completed history on bounded exhaustion without accepting a false final", () => {
    settle();
    act(() => { expect(harness.current?.resync()).toBe(true); });
    const stream = frames(exhausted);
    expect(stream.filter((frame) => frame.type === "ready")).toHaveLength(2);
    expect(stream.some((frame) => frame.type === "entries" && frame.final !== false)).toBe(false);
    stream.forEach(deliver);
    deliver({ type: "error", sessionId: session.id, code: "resume_failed", command: "get_entries", message: "Automatic recovery failed" });
    expect(ids()).toEqual(["saved-1", "saved-2"]);
    expect(harness.current?.historyStatus).toBe("failed");
    expect(harness.current?.historyLoaded).toBe(false);
    expect(harness.current?.error).not.toBe("");
    // A later explicitly requested replay must not revive exhausted pages.
    act(() => { expect(harness.current?.resync()).toBe(true); });
    deliver(ready);
    deliver(terminal);
    expect(ids()).toEqual(["saved-1", "saved-2"]);
  });
});
