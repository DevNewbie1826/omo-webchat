import { describe, expect, it } from "vitest";
import type { ModelOption } from "./ModelPicker";
import { fuzzyScore, matchModels } from "./modelSearch";

const models: readonly ModelOption[] = [
  { provider: "anthropic", modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { provider: "anthropic", modelId: "claude-opus-4", name: "Claude Opus 4" },
  { provider: "openai", modelId: "gpt-5", name: "GPT-5" },
  { provider: "openai", modelId: "gpt-5-mini" },
  { provider: "google", modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
];

const ids = (list: readonly ModelOption[]): string[] => list.map((model) => model.modelId);

describe("fuzzyScore", () => {
  it("matches characters in order even when they are not adjacent", () => {
    expect(fuzzyScore("claude sonnet 4", "cls4")).not.toBeNull();
    expect(fuzzyScore("claude sonnet 4", "cs4l")).toBeNull();
    expect(fuzzyScore("claude sonnet 4", "z")).toBeNull();
  });

  it("scores every contiguous substring 0 and ranks tighter subsequences ahead of wider ones", () => {
    expect(fuzzyScore("gpt-5-mini", "mini")).toBe(0);
    expect(fuzzyScore("gpt-5-mini openai", "openai")).toBe(0);
    const tight = fuzzyScore("gemini-2.5-pro", "25p");
    const wide = fuzzyScore("gemini-2.5-pro", "g25");
    if (tight === null || wide === null) throw new Error("expected matches");
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBeLessThan(wide);
  });

  it("scores the smallest window, not the first greedy subsequence", () => {
    // "ab" spans a…b over seven characters from the first 'a' but skips just
    // one character inside the tightest window "a4b".
    expect(fuzzyScore("a123a4b", "ab")).toBe(2);
    expect(fuzzyScore("a12b", "ab")).toBe(3);
  });

  it("matches whole Unicode characters, never surrogates stitched across two characters", () => {
    // "\u{1F516}" (D83D DD16) must not assemble itself out of the D83D of
    // "\u{1F600}" and the DD16 of "\u{1F916}": neither character occurs.
    expect(fuzzyScore("\u{1F600}\u{1F916}", "\u{1F516}")).toBeNull();
    // A token whose characters really occur in the haystack still matches.
    expect(fuzzyScore("\u{1F600}\u{1F916}", "\u{1F916}")).toBe(0);
  });
});

describe("matchModels", () => {
  it("keeps the input order for an empty or blank query", () => {
    expect(ids(matchModels(models, ""))).toEqual(ids(models));
    expect(ids(matchModels(models, "   "))).toEqual(ids(models));
  });

  it("finds models whose label only matches as a subsequence", () => {
    expect(ids(matchModels(models, "snt4"))).toEqual(["claude-sonnet-4"]);
    expect(ids(matchModels(models, "gm25"))).toEqual(["gemini-2.5-pro"]);
  });

  it("is case-insensitive and matches the model id and provider as well as the name", () => {
    expect(ids(matchModels(models, "GPT"))).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(ids(matchModels(models, "openai"))).toEqual(["gpt-5", "gpt-5-mini"]);
    expect(ids(matchModels(models, "sonnet-4"))).toEqual(["claude-sonnet-4"]);
  });

  it("requires every whitespace-separated token to match", () => {
    expect(ids(matchModels(models, "claude opus"))).toEqual(["claude-opus-4"]);
    expect(ids(matchModels(models, "claude nope"))).toEqual([]);
  });

  it("puts contiguous matches before scattered ones without reordering ties", () => {
    // "pro" sits inside "gemini-2.5-pro"; it only spans p…r…o across "opus … anthropic".
    expect(ids(matchModels(models, "pro"))).toEqual(["gemini-2.5-pro", "claude-opus-4"]);
    expect(ids(matchModels(models, "claude"))).toEqual(["claude-sonnet-4", "claude-opus-4"]);
  });

  it("ranks the tighter window ahead of the wider one", () => {
    // "ab" matches "a123a4b" as "a4b" (score 2) and "a12b" as "a12b" (score 3).
    expect(
      ids(matchModels([{ provider: "x", modelId: "a123a4b" }, { provider: "x", modelId: "a12b" }], "ab")),
    ).toEqual(["a123a4b", "a12b"]);
  });

  it("matches whole Unicode characters in the haystack, not lone surrogates", () => {
    const emoji: readonly ModelOption[] = [
      { provider: "x", modelId: "custom", name: "\u{1F600}\u{1F916}" },
    ];
    expect(ids(matchModels(emoji, "\u{1F516}"))).toEqual([]);
    expect(ids(matchModels(emoji, "\u{1F916}"))).toEqual(["custom"]);
  });
});
