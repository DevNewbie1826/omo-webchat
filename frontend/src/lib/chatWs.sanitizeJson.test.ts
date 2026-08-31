import { describe, expect, it } from "vitest";
import { sanitizeJson } from "./chatWs";

describe("sanitizeJson", () => {
  it("deep-clones plain JSON and neutralizes dangerous keys and values", () => {
    const input = JSON.parse('{"a":[1,"x",true,null,{"__proto__":{"p":1},"constructor":{"c":1},"prototype":{"t":1},"ok":2}]}');
    expect(sanitizeJson(input)).toEqual({ a: [1, "x", true, null, { ok: 2 }] });
  });

  it("maps non-JSON scalars to null", () => {
    expect(sanitizeJson(undefined)).toBeNull();
    expect(sanitizeJson(() => 1)).toBeNull();
    expect(sanitizeJson(Symbol("s"))).toBeNull();
    expect(sanitizeJson("keep")).toBe("keep");
  });
});
