import { describe, expect, it } from "vitest";
import { parseServerFrame } from "./types_gen";

const addedErrorCodes = [
  "set_model_failed",
  "set_thinking_failed",
  "approval_failed",
] as const;

describe("generated error-code parser", () => {
  it.each(addedErrorCodes)("parses a raw %s error frame", (code) => {
    const raw = `{"type":"error","sessionId":"sess-1","code":"${code}","message":"command failed"}`;

    expect(parseServerFrame(JSON.parse(raw))).toEqual(JSON.parse(raw));
  });
});
