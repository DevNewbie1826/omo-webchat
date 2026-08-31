import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame dangling resume candidates", () => {
  it("maps a valid error-frame branchCandidates array through", () => {
    expect(
      parseChatServerFrame({
        type: "error",
        sessionId: "c1",
        code: "resume_failed",
        dangling: true,
        message: "boom /path.jsonl",
        branchCandidates: [{ id: "c1", name: "부모세션", hostPath: "/x.jsonl" }],
      }),
    ).toEqual({
      type: "error",
      sessionId: "c1",
      code: "resume_failed",
      dangling: true,
      message: "boom /path.jsonl",
      candidates: [{ id: "c1", name: "부모세션", hostPath: "/x.jsonl" }],
    });
  });

  it("rejects the whole error frame when a candidate is missing name", () => {
    expect(
      parseChatServerFrame({
        type: "error",
        sessionId: "c1",
        code: "resume_failed",
        message: "boom /path.jsonl",
        branchCandidates: [{ id: "c1", hostPath: "/x.jsonl" }],
      }),
    ).toBeNull();
  });

  it("rejects the whole error frame when a candidate id is not a string", () => {
    expect(
      parseChatServerFrame({
        type: "error",
        sessionId: "c1",
        code: "resume_failed",
        message: "boom /path.jsonl",
        branchCandidates: [{ id: 1, name: "부모세션" }],
      }),
    ).toBeNull();
  });

  it("still accepts an error frame that omits candidates", () => {
    expect(parseChatServerFrame({ type: "error", message: "boom" })).toEqual({
      type: "error",
      message: "boom",
    });
  });
});
