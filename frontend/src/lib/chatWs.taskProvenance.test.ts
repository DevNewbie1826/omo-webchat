import { describe, expect, it } from "vitest";
import corrected from "../../../contract/fixtures/server-sessions.activity-task-correction.json";
import activity from "../../../contract/fixtures/server-sessions.activity.json";
import extension from "../../../contract/fixtures/server-extensionEvent-task-correction.json";
import { parseChatServerFrame } from "./chatWs";

 describe("lean activity wire boundary", () => {
  it.each([corrected, activity])("roundtrips lean activity when the server emits a valid fixture", frame => {
    // Given a real lean server fixture; when it crosses the actual parser.
    const parsed = parseChatServerFrame(JSON.parse(JSON.stringify(frame)));
    // Then the emitted counts and identity survive unchanged.
    expect(parsed).toEqual(frame);
  });
  it("preserves task provenance when it arrives through the attached extension surface", () => {
    // Given the real attached correction fixture; when it is parsed.
    const parsed = parseChatServerFrame(extension);
    // Then original status and clock remain available to task reconciliation.
    expect(parsed).toEqual(extension);
  });
  it.each([null, 42, true, [], {}, { tasks: [{ task_id: 42, raw_status: null }] }])(
    "ignores removed payload fields when unknown keys contain %j", value => {
      // Given removed fields that are no longer part of the wire contract.
      const input = { ...corrected, snapshots: value, taskDigest: value, dagDigest: value };
      const original = JSON.stringify(input);
      // When the lean activity crosses the parser.
      const parsed = parseChatServerFrame(input);
      // Then only the lean frame is returned and the input stays untouched.
      expect(parsed).toEqual(corrected);
      expect(JSON.stringify(input)).toBe(original);
    },
  );
  it.each([-1, 1.5, "7", null])("rejects malformed lean membership counts when agents=%j", agents => {
    // Given a malformed machine-consumed scalar; when it crosses the parser.
    const parsed = parseChatServerFrame({ ...corrected, running: { agents } });
    // Then malformed live count data cannot enter the store.
    expect(parsed).toBeNull();
  });
  it("does not invent counts when the optional scalar fields are absent", () => {
    // Given a membership-only envelope.
    const frame = { type: "sessions.activity", sessionId: "s", durableSessionId: "s", overflow: false };
    // When the frame is parsed.
    const parsed = parseChatServerFrame(frame);
    // Then absence remains absence, not a fabricated aggregate.
    expect(parsed).toEqual(frame);
  });
});
