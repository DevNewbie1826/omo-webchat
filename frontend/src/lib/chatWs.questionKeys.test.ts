import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWsParse";

describe("effective question keys", () => {
  it.each([true, false])("uses the cancellable fallback for colliding keys when nonBlocking=%s", (nonBlocking) => {
    // Given an omitted first id whose synthesized key conflicts with the next id.
    const raw = { type: "approval", sessionId: "s", id: "collision", method: "question", nonBlocking,
      questions: [{ question: "First" }, { id: "q1", question: "Second" }] };
    // When the request crosses the frame boundary.
    const frame = parseChatServerFrame(raw);
    // Then no lossy question surface can receive it.
    expect(frame).toMatchObject({ id: "collision", fallback: true });
  });

  it("uses the fallback when explicit ids are duplicated", () => {
    // Given duplicate explicit ids.
    const raw = { type: "approval", sessionId: "s", id: "duplicate", method: "question",
      questions: [{ id: "same" }, { id: "same" }] };
    // When parsed.
    const frame = parseChatServerFrame(raw);
    // Then the request remains cancellable rather than answerable with loss.
    expect(frame).toMatchObject({ id: "duplicate", fallback: true });
  });

  it.each([
    [{ id: "first" }, { id: "second" }],
    [{ question: "First" }, { question: "Second" }],
    [{ question: "First" }, { id: "q0" }],
  ])("accepts unambiguous question ids %j", (...questions) => {
    // Given valid explicit, omitted, or mixed ids.
    const raw = { type: "approval", sessionId: "s", id: "valid", method: "question", questions };
    // When parsed.
    const frame = parseChatServerFrame(raw);
    // Then the structured request survives unchanged.
    expect(frame).toEqual(raw);
  });
});
