import { describe, expect, it } from "vitest";
import type { UiMessage } from "./chatEntries";
import { finalizeRunMessages, reconcileHistory } from "./chatSessionState";

function steerRow(text: string): UiMessage {
  return { role: "user", customType: "steer", blocks: [{ kind: "text", text }] };
}

function plainUserRow(text: string, ts = 0): UiMessage {
  return { role: "user", blocks: [{ kind: "text", text }], ts };
}

describe("finalizeRunMessages keeps the steer mark across run settle", () => {
  it("keeps a steer-marked entry in the finalized transcript", () => {
    const messages = [steerRow("hold on"), plainUserRow("original task", 5)];
    const finalized = finalizeRunMessages(messages, {});
    // No tools: finalization must leave the transcript alone (null = keep
    // messages as-is) rather than return a steer-stripped copy.
    if (finalized !== null) {
      expect(finalized.some((message) => message.customType === "steer" && message.blocks?.[0]?.text === "hold on")).toBe(true);
      expect(finalized).toHaveLength(messages.length);
    }
  });

  it("keeps the steer-marked entry while materializing final tools", () => {
    const messages = [steerRow("also check lint"), { role: "assistant", blocks: [] }];
    const finalized = finalizeRunMessages(messages, { call_1: { toolName: "bash", phase: "end", text: "ok", isError: false } });
    expect(finalized?.some((message) => message.customType === "steer")).toBe(true);
    expect(finalized?.some((message) => (message.blocks ?? []).some((block) => block.id === "call_1"))).toBe(true);
  });
});

describe("reconcileHistory re-marks the canonical steer flush", () => {
  it("tags a plain canonical user entry whose text is a recorded steer", () => {
    const result = reconcileHistory({
      entries: [{ type: "message", id: "e1", message: { role: "user", content: "hold on", timestamp: 10 } }],
      current: [],
      pending: [],
      active: null,
      uncertain: null,
      preserveCurrent: false,
      steerMarks: [{ requestId: "r1", text: "hold on", ordinal: 1 }],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.customType).toBe("steer");
    expect(result.messages[0]?.id).toBe("e1");
  });

  it("marks the recorded canonical occurrence when identical text appears earlier", () => {
    const result = reconcileHistory({
      entries: [
        { type: "message", id: "e1", message: { role: "user", content: "same", timestamp: 10 } },
        { type: "message", id: "e2", message: { role: "user", content: "same", timestamp: 20 } },
      ],
      current: [],
      pending: [],
      active: null,
      uncertain: null,
      preserveCurrent: false,
      steerMarks: [{ requestId: "r1", text: "same", ordinal: 2 }],
    });
    expect(result.messages.map((message) => message.customType)).toEqual([undefined, "steer"]);
  });

  it("leaves canonical rows unmarked without recorded steer occurrences", () => {
    const result = reconcileHistory({
      entries: [{ type: "message", id: "e1", message: { role: "user", content: "hold on", timestamp: 10 } }],
      current: [],
      pending: [],
      active: null,
      uncertain: null,
      preserveCurrent: false,
    });
    expect(result.messages[0]?.customType).toBeUndefined();
  });

  it("collapses the local un-marked-id steer echo into the tagged canonical row", () => {
    const result = reconcileHistory({
      entries: [{ type: "message", id: "e1", message: { role: "user", content: "hold on", timestamp: 10 } }],
      current: [steerRow("hold on")],
      pending: [],
      active: null,
      uncertain: null,
      preserveCurrent: true,
      steerMarks: [{ requestId: "r1", text: "hold on", ordinal: 1 }],
    });
    const rows = result.messages.filter((message) => message.blocks?.[0]?.text === "hold on");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customType).toBe("steer");
    expect(rows[0]?.id).toBe("e1");
  });
});
