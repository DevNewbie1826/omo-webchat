import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWsParse";

const envelope = { type: "approval", sessionId: "s", id: "request" } as const;

describe("approval answer classification", () => {
  it.each(["setStatus", "setWidget", "confirm", "question", "futureAnnouncement"])(
    "drops %s when the server marks it as an announcement",
    (method) => {
      // Given: no requestId is needed to classify an announcement.
      const raw = { ...envelope, method, awaitsAnswer: false };
      // When
      const frame = parseChatServerFrame(raw);
      // Then
      expect(frame).toBeNull();
    },
  );

  it.each([{}, { awaitsAnswer: true }])(
    "keeps an unknown request cancellable when classification is %j",
    (classification) => {
      // Given
      const raw = { ...envelope, method: "futureRequest", ...classification };
      // When
      const frame = parseChatServerFrame(raw);
      // Then
      expect(frame).toEqual({ ...envelope, method: "futureRequest", fallback: true });
    },
  );

  it.each(["setStatus", "setWidget"])(
    "preserves legacy fallback for %s when classification is absent",
    (method) => {
      // Given
      const raw = { ...envelope, method };
      // When
      const frame = parseChatServerFrame(raw);
      // Then
      expect(frame).toEqual({ ...envelope, method, fallback: true });
    },
  );

  it.each(["select", "confirm", "input", "editor", "question"])(
    "preserves strict %s parsing when awaiting an answer without requestId",
    (method) => {
      // Given
      const raw = { ...envelope, method, options: ["Yes"], questions: [{ question: "Choose" }] };
      // When
      const frame = parseChatServerFrame({ ...raw, awaitsAnswer: true });
      // Then
      expect(frame).toEqual(raw);
    },
  );

  it.each([{}, { awaitsAnswer: true }])(
    "preserves fallback for a rejected interactive shape when classification is %j",
    (classification) => {
      // Given: duplicate question keys pass the wire schema but fail strict UI parsing.
      const raw = { ...envelope, method: "question", questions: [{ id: "q" }, { id: "q" }], ...classification };
      // When
      const frame = parseChatServerFrame(raw);
      // Then
      expect(frame).toEqual({ ...envelope, method: "question", fallback: true });
    },
  );
});
