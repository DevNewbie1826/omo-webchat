import { describe, expect, it } from "vitest";
import { parseEntries } from "./chatEntries";

// Persisted summary entries (observed engine behavior/contract): compaction
// summaries persist as session entries of type "compaction", branch summaries
// as type "branch_summary". The compaction result fields are `summary`
// (string) and `tokensBefore` (number); entries carry id/timestamp like every
// other history entry.
describe("parseEntries summary entries", () => {
	it("maps a persisted compaction entry to a custom compaction message keeping summary and tokensBefore", () => {
		const messages = parseEntries([
			{
				type: "compaction",
				id: "c1",
				timestamp: "2026-01-02T03:04:05.000Z",
				summary: "Compacted summary text",
				tokensBefore: 48213,
			},
		]);
		expect(messages).toEqual([
			{
				id: "c1",
				role: "custom",
				customType: "compaction",
				blocks: [{ kind: "text", text: "Compacted summary text" }],
				ts: Date.parse("2026-01-02T03:04:05.000Z"),
				tokensBefore: 48213,
			},
		]);
	});

	it("maps a persisted branch_summary entry to a custom branch_summary message with no token line", () => {
		const messages = parseEntries([
			{ type: "branch_summary", id: "b1", timestamp: 1735689600000, summary: "Branch recap" },
		]);
		expect(messages).toEqual([
			{
				id: "b1",
				role: "custom",
				customType: "branch_summary",
				blocks: [{ kind: "text", text: "Branch recap" }],
				ts: 1735689600000,
			},
		]);
	});

	it("drops a summary entry whose summary is not a string instead of inventing text", () => {
		const messages = parseEntries([
			{ type: "compaction", id: "c2", tokensBefore: 10 },
			{ type: "branch_summary", id: "b2", summary: 42 },
			{ type: "message", id: "m1", message: { role: "user", content: "kept" } },
		]);
		expect(messages.map((message) => message.id)).toEqual(["m1"]);
	});

	it("keeps summary entries in history order alongside messages", () => {
		const messages = parseEntries([
			{ type: "message", id: "m1", message: { role: "user", content: "before" } },
			{ type: "compaction", id: "c1", summary: "middle" },
			{ type: "message", id: "m2", message: { role: "assistant", content: "after" } },
		]);
		expect(messages.map((message) => message.id)).toEqual(["m1", "c1", "m2"]);
	});
});
