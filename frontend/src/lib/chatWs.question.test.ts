import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWsParse";
import { parseClientFrame } from "./contract/types_gen";

describe("question protocol", () => {
  it("preserves structured questions when receiving a question request", () => {
    // Given
    const raw = { type: "approval", sessionId: "s", id: "ask", method: "question", questions: [
      { id: "q1", header: "Stack", question: "Which stack?", multiSelect: true, options: [{ label: "Go", description: "Backend" }, { label: "TS" }] },
      { id: "q2", question: "Notes?" },
    ] };
    // When
    const parsed = parseChatServerFrame(raw);
    // Then
    expect(parsed).toEqual(raw);
  });

  it("preserves legacy approvals when question fields are absent", () => {
    // Given
    const raw = { type: "approval", sessionId: "s", id: "a", method: "select", options: ["yes", "no"] };
    // When
    const parsed = parseChatServerFrame(raw);
    // Then
    expect(parsed).toEqual(raw);
  });

  it("rejects malformed answers when selected contains a non-string", () => {
    // Given
    const raw = { type: "approval.respond", sessionId: "s", id: "ask", answers: { q1: { selected: [42] } } };
    // When
    const parsed = parseClientFrame(raw);
    // Then
    expect(parsed).toBeNull();
  });
});
