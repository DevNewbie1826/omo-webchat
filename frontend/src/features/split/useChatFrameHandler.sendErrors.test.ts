import { describe, expect, it } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { retirePendingSteers, sendCommandFailureOf, settleCompletedSendPending } from "./useChatFrameHandler";
import type { PendingOptimistic } from "./chatSessionState";

type ErrorFrame = Extract<ChatServerFrame, { readonly type: "error" }>;

function failure(command?: string, code?: ErrorFrame["code"]): ErrorFrame {
  return {
    type: "error",
    message: "rejected",
    ...(command !== undefined ? { command } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

describe("sendCommandFailureOf", () => {
  it.each([
    "chat.send", "chat.compact", "chat.abort",
    "prompt", "steer", "follow_up", "compact", "abort",
  ])("classifies provider_error for the %s command namespace", (command) => {
    expect(sendCommandFailureOf(failure(command, "provider_error"))).toEqual({ message: "rejected" });
  });

  it.each([
    "prompt_in_flight", "compaction_in_flight", "bad_send", "send_failed",
    "compact_failed", "send_backpressure",
  ] as const)("classifies the %s send-path code independently of settlement", (code) => {
    expect(sendCommandFailureOf(failure(undefined, code))).toEqual({ message: "rejected" });
  });

  it("does not classify unrelated provider failures", () => {
    expect(sendCommandFailureOf(failure("get_entries", "provider_error"))).toBeNull();
  });
});

describe("completed chat.send settlement", () => {
  const pending = (kind: PendingOptimistic["kind"], id: number, requestId: string): PendingOptimistic => ({
    id,
    requestId,
    kind,
    text: "work",
    image: null,
    priorMatchingCount: 0,
    baselineKnown: true,
    accepted: true,
    admitted: true,
  });

  it("clears the steer tombstone when completion follows run.done", () => {
    const steer = pending("steer", 7, "steer-7");
    const retiredSteerIds = new Set<number>();
    retirePendingSteers([steer], retiredSteerIds);
    expect(retiredSteerIds).toEqual(new Set([steer.id]));

    expect(settleCompletedSendPending([steer], steer.requestId, retiredSteerIds)).toEqual([]);
    expect(retiredSteerIds.size).toBe(0);
  });

  it("retains a completed follow-up until its canonical echo reconciles", () => {
    const followUp = pending("followUp", 8, "follow-up-8");
    const operations = [followUp];

    expect(settleCompletedSendPending(operations, followUp.requestId, new Set())).toBe(operations);
  });
});
