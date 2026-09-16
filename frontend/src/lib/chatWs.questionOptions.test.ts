import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWsParse";

describe("question option identity", () => {
  it.each([true, false])("rejects only colliding labels when nonBlocking=%s", (nonBlocking) => {
    // Given descriptions cannot disambiguate equal labels, while distinct labels
    // remain valid even when descriptions match or labels recur in other questions.
    const raw = { type: "approval", sessionId: "s", id: "duplicate-options", method: "question", nonBlocking,
      questions: [{ id: "deploy", multiSelect: true, options: [
        { label: "Deploy", description: "staging only" }, { label: "Deploy", description: "production only" },
      ] }] };
    const distinct = { ...raw, id: "distinct-options", questions: [
      { id: "first", options: [{ label: "Staging", description: "target" }, { label: "Production", description: "target" }] },
      { id: "second", options: [{ label: "Staging", description: "another staging" }] },
    ] };
    // When both option sets cross the shared boundary.
    const frames = [raw, distinct].map(parseChatServerFrame);
    // Then only the ambiguous request takes the cancellable fallback.
    expect(frames).toEqual([
      { type: raw.type, sessionId: raw.sessionId, id: raw.id, method: raw.method, fallback: true },
      distinct,
    ]);
  });

  it("falls back for the entire atomic request when one question has ambiguous options", () => {
    // Given one valid question and one ambiguous question in a single response envelope.
    const raw = { type: "approval", sessionId: "s", id: "mixed-options", method: "question", questions: [
      { id: "valid", options: [{ label: "Keep", description: "existing" }] },
      { id: "ambiguous", options: [{ label: "Deploy", description: "staging" }, { label: "Deploy", description: "production" }] },
    ] };
    // When parsed.
    const frame = parseChatServerFrame(raw);
    // Then the request remains cancellable without silently discarding its ambiguous question.
    expect(frame).toEqual({ type: raw.type, sessionId: raw.sessionId, id: raw.id, method: raw.method, fallback: true });
  });
});
