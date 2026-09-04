import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText } from "./chatEntries";
import {
  mountReconnectHarness,
  session,
  unmountReconnectHarness,
  type ReconnectHarness,
} from "./useChatSession.reconnect.support";

describe("follow-up admission reconciliation", () => {
  let harness: ReconnectHarness;

  beforeEach(() => {
    harness = mountReconnectHarness();
    act(() => {
      harness.deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
      harness.deliver({ type: "run.started", sessionId: session.id });
    });
  });

  afterEach(async () => unmountReconnectHarness(harness));

  function queueFollowUp(text: string): string {
    act(() => harness.current?.submit({ text, image: null }));
    const frame = [...harness.sent].reverse().find((candidate) => candidate.type === "chat.send");
    if (frame?.type !== "chat.send" || !frame.requestId) throw new Error("missing request identity");
    return frame.requestId;
  }

  function reconnectIdle(): void {
    act(() => {
      harness.disconnect();
      harness.reconnect();
      harness.deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
      harness.deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
    });
  }

  it("recovers an unacknowledged follow-up absent from idle authoritative history", () => {
    queueFollowUp("lost follow-up");
    reconnectIdle();
    expect(harness.current?.retryDraft?.text).toBe("lost follow-up");
    expect(harness.current?.failedDrafts.map((draft) => draft.text)).toContain("lost follow-up");
    expect(harness.current?.hasPendingFollowUp).toBe(false);
    expect(harness.current?.messages.map(messageText)).not.toContain("lost follow-up");
  });

  it("keeps an acknowledged but unechoed follow-up owned by the server", () => {
    const requestId = queueFollowUp("admitted follow-up");
    act(() => harness.deliver({ type: "ack", command: "chat.send", requestId }));
    reconnectIdle();
    expect(harness.current?.retryDraft).toBeNull();
    expect(harness.current?.failedDrafts).toEqual([]);
    expect(harness.current?.hasPendingFollowUp).toBe(true);
    expect(harness.current?.messages.map(messageText)).toContain("admitted follow-up");
  });
});
