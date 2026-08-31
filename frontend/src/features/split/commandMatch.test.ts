import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../../lib/chatWs";
import { commandPrefix, detectCommandTrigger, matchCommands } from "./commandMatch";

const cmds = (names: readonly string[]): readonly CommandEntry[] =>
  names.map((name) => ({ name }));

describe("matchCommands", () => {
  it("returns every command in input order for an empty query", () => {
    expect(matchCommands(cmds(["clear", "compact", "help"]), "").map((c) => c.name))
      .toEqual(["clear", "compact", "help"]);
  });

  it("ranks prefix matches before substring matches", () => {
    const result = matchCommands(cmds(["clear", "compact", "learning"]), "lea");
    expect(result.map((c) => c.name)).toEqual(["learning", "clear"]);
  });

  it("preserves input order among prefix matches and among substring matches", () => {
    expect(matchCommands(cmds(["clear", "compact", "cc"]), "c").map((c) => c.name))
      .toEqual(["clear", "compact", "cc"]);
  });

  it("matches case-insensitively", () => {
    expect(matchCommands(cmds(["Clear", "Compact"]), "LEA").map((c) => c.name))
      .toEqual(["Clear"]);
  });

  it("returns nothing when no name contains the query", () => {
    expect(matchCommands(cmds(["clear", "compact"]), "xyz")).toEqual([]);
  });
});

describe("commandPrefix", () => {
  it("maps dollar syntax to $ and defaults every other command to slash", () => {
    expect(commandPrefix({ name: "skill:demo", syntax: "dollar" })).toBe("$");
    expect(commandPrefix({ name: "fix-tests", syntax: "slash" })).toBe("/");
    expect(commandPrefix({ name: "legacy" })).toBe("/");
  });
});

describe("detectCommandTrigger", () => {
  it("detects / at the start with a query at the caret", () => {
    expect(detectCommandTrigger("/cle", 4)).toEqual({ start: 0, query: "cle", prefix: "/" });
  });

  it("detects / after a space mid-message", () => {
    expect(detectCommandTrigger("hello /cle", 10)).toEqual({ start: 6, query: "cle", prefix: "/" });
  });

  it("detects / after a newline", () => {
    expect(detectCommandTrigger("hello\n/cle", 10)).toEqual({ start: 6, query: "cle", prefix: "/" });
  });

  it("detects $ skill commands at token boundaries", () => {
    expect(detectCommandTrigger("$skill:de", 9)).toEqual({ start: 0, query: "skill:de", prefix: "$" });
    expect(detectCommandTrigger("use $demo", 9)).toEqual({ start: 4, query: "demo", prefix: "$" });
  });

  it("does not treat $ inside a word as a command trigger", () => {
    expect(detectCommandTrigger("cost$demo", 9)).toBeNull();
  });

  it("returns null when / is not at a word boundary", () => {
    expect(detectCommandTrigger("a/b", 3)).toBeNull();
  });

  it("returns null when the char before the caret is a space", () => {
    expect(detectCommandTrigger("hello / ", 8)).toBeNull();
  });

  it("returns null with no / before the caret", () => {
    expect(detectCommandTrigger("hello", 5)).toBeNull();
  });

  it("handles an empty query right after /", () => {
    expect(detectCommandTrigger("hello /", 7)).toEqual({ start: 6, query: "", prefix: "/" });
  });

  it("returns null at caret 0", () => {
    expect(detectCommandTrigger("/x", 0)).toBeNull();
  });
});
