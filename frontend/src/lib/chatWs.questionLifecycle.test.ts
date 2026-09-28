import { expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";
import { parseApprovalFrame } from "./chatWsParseApproval";
import { parseClientFrame } from "./contract/types_gen";

it("keeps the stable identity and submitted text on a failed question", () => {
  const frame = parseChatServerFrame({
    type: "approval", sessionId: "s", id: "new-id", requestId: "tool-1",
    method: "question", nonBlocking: true, delivery: "failed", deliveryError: "unconfirmed",
    submittedAnswer: { answers: { q1: { selected: [], text: "free text" } }, comment: "from composer" },
    questions: [{ id: "q1", options: [{ label: "A" }] }],
  });
  expect(frame).toMatchObject({
    requestId: "tool-1", delivery: "failed", deliveryError: "unconfirmed",
    submittedAnswer: { answers: { q1: { selected: [], text: "free text" } }, comment: "from composer" },
  });
  expect(parseApprovalFrame({
    type: "approval", sessionId: "s", id: "bad", method: "question",
    questions: [{ id: "q1" }], submittedAnswer: { answers: { q1: { selected: [42] } } },
  }, "s")).toBeNull();
});

it("parses an authoritative pending-key snapshot and the progress client frame", () => {
  expect(parseChatServerFrame({ type: "questions.snapshot", sessionId: "s", ids: ["tool-1", "old-id"] }))
    .toEqual({ type: "questions.snapshot", sessionId: "s", ids: ["tool-1", "old-id"] });
  expect(parseChatServerFrame({ type: "questions.snapshot", sessionId: "s", ids: [1] })).toBeNull();
  expect(parseClientFrame({ type: "approval.progress", sessionId: "s", id: "new-id",
    answers: { q1: { selected: [], text: "draft" } }, comment: "draft" }))
    .toMatchObject({ type: "approval.progress", id: "new-id",
      answers: { q1: { selected: [], text: "draft" } } });
});
