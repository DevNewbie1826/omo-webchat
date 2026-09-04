import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText } from "./chatEntries";
import {
  mountReconnectHarness,
  type ReconnectHarness,
  session,
  unmountReconnectHarness,
} from "./useChatSession.reconnect.support";

const canonicalEntries = [
  {
    type: "message",
    id: "ordinary",
    message: { role: "user", content: "마무리", timestamp: 10 },
  },
  {
    type: "message",
    id: "reply",
    message: { role: "assistant", content: "진행 중", timestamp: 20 },
  },
  {
    type: "message",
    id: "steer",
    message: { role: "user", content: "마무리", timestamp: 30 },
  },
] as const;

function identicalUserRows(harness: ReconnectHarness) {
  return (harness.current?.messages ?? []).filter(
    (message) => message.role === "user" && messageText(message) === "마무리",
  );
}

function expectOnlyLaterOccurrenceMarked(harness: ReconnectHarness): void {
  const rows = identicalUserRows(harness);
  expect(rows).toHaveLength(2);
  expect(rows.map((message) => message.ts)).toEqual([10, 30]);
  expect(rows.map((message) => message.customType)).toEqual([undefined, "steer"]);
}

describe("useChatSession steer occurrence identity", () => {
  const mounted: ReconnectHarness[] = [];

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(async () => {
    for (const harness of mounted.splice(0).reverse()) {
      await unmountReconnectHarness(harness);
    }
    window.sessionStorage.clear();
  });

  it("keeps only a later identical steer marked through settle, resync, and remount", async () => {
    const harness = mountReconnectHarness();
    mounted.push(harness);

    act(() => {
      harness.deliver({
        type: "entries",
        sessionId: session.id,
        entries: canonicalEntries.slice(0, 2),
        final: true,
      });
      harness.deliver({ type: "run.started", sessionId: session.id });
      harness.current?.steer("마무리");
      harness.deliver({
        type: "message",
        sessionId: session.id,
        message: { role: "user", blocks: [{ kind: "text", text: "마무리" }], ts: 30 },
      });
      harness.deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
    });

    expectOnlyLaterOccurrenceMarked(harness);

    act(() => {
      harness.disconnect();
      harness.reconnect();
      harness.deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
      harness.deliver({ type: "entries", sessionId: session.id, entries: canonicalEntries, final: true });
    });

    expectOnlyLaterOccurrenceMarked(harness);

    await unmountReconnectHarness(harness);
    mounted.splice(mounted.indexOf(harness), 1);

    const remounted = mountReconnectHarness();
    mounted.push(remounted);
    act(() => {
      remounted.deliver({ type: "entries", sessionId: session.id, entries: canonicalEntries, final: true });
    });

    expectOnlyLaterOccurrenceMarked(remounted);
  });
});
