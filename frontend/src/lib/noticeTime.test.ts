import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame } from "./chatWs";

const RECEIVED_AT = Date.parse("2030-06-15T12:34:56Z");

function noticeTime(at: string): number | undefined {
  const frame = parseChatServerFrame({ type: "notice", sessionId: "chat-1", kind: "test", at });
  return frame?.type === "notice" ? frame.at ?? Date.now() : undefined;
}

afterEach(() => vi.useRealTimers());

describe("notice time", () => {
  it.each([
    "2026-01-02T24:00:00Z",
    "2026-01-02T12:60:00Z",
    "2026-01-02T12:00:60Z",
    "2026-13-02T12:00:00Z",
    "2026-02-30T12:00:00Z",
  ])("uses receipt time for invalid timestamp %s", (at) => {
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT);

    expect(noticeTime(at)).toBe(RECEIVED_AT);
  });

  it("parses the latest valid time of day", () => {
    const at = "2026-01-02T23:59:59Z";
    expect(noticeTime(at)).toBe(Date.parse(at));
  });
});
