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
				summaryKind: "compaction",
				blocks: [{ kind: "text", text: "Compacted summary text" }],
				ts: Date.parse("2026-01-02T03:04:05.000Z"),
				tokensBefore: 48213,
			},
		]);
	});

	it("maps a persisted branch_summary entry to a custom branch_summary message with no token line", () => {
		// Observed persisted branch_summary envelope (r-contract-notes.md):
		// top-level summary (string), fromId (string), ISO-string timestamp,
		// details/usage objects, fromHook boolean; no tokensBefore.
		const messages = parseEntries([
			{
				type: "branch_summary",
				id: "b1",
				parentId: "b0",
				timestamp: "2026-01-02T03:05:12.000Z",
				fromId: "a9",
				summary: "Branch recap",
				details: { readFiles: [], modifiedFiles: [] },
				usage: { input: 418, output: 382, totalTokens: 800 },
				fromHook: false,
			},
		]);
		expect(messages).toEqual([
			{
				id: "b1",
				role: "custom",
				customType: "branch_summary",
				summaryKind: "branch_summary",
				blocks: [{ kind: "text", text: "Branch recap" }],
				ts: Date.parse("2026-01-02T03:05:12.000Z"),
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

	it("tags persisted summary entries with summaryKind so routing never keys on customType names", () => {
		const messages = parseEntries([
			{ type: "compaction", id: "c1", summary: "compacted" },
			{ type: "branch_summary", id: "b1", summary: "branch" },
		]);
		expect(messages[0]?.summaryKind).toBe("compaction");
		expect(messages[1]?.summaryKind).toBe("branch_summary");
	});

	it("never tags ordinary custom messages with summaryKind, even named compaction or branch_summary", () => {
		const messages = parseEntries([
			{ type: "custom_message", id: "x1", customType: "compaction", display: true, content: "hook one" },
			{ type: "custom_message", id: "x2", customType: "branch_summary", display: true, content: "hook two" },
			{ type: "custom_message", id: "x3", customType: "weather", display: true, content: "hook three" },
		]);
		expect(messages).toHaveLength(3);
		for (const message of messages) {
			expect(message.role).toBe("custom");
			expect(message.summaryKind).toBeUndefined();
		}
	});

	it("preserves a valid epoch-zero timestamp on a summary entry", () => {
		const messages = parseEntries([{ type: "compaction", id: "zero", timestamp: 0, summary: "zero" }]);
		expect(messages[0]?.ts).toBe(0);
	});

	it("falls back to the frozen hydration receipt time for finite numeric timestamps outside the Date range", () => {
		const before = Date.now();
		const messages = parseEntries([
			{ type: "compaction", id: "over", timestamp: 8640000000000001, summary: "positive overflow" },
			{ type: "branch_summary", id: "under", timestamp: -8640000000000001, summary: "negative overflow" },
		]);
		const after = Date.now();
		expect(messages).toHaveLength(2);
		for (const message of messages) {
			expect(message.ts).toBeGreaterThanOrEqual(before);
			expect(message.ts).toBeLessThanOrEqual(after);
			expect(Number.isNaN(new Date(message.ts ?? Number.NaN).getTime())).toBe(false);
		}
	});

	it("keeps both exact Date-range endpoints and valid negative timestamps", () => {
		const messages = parseEntries([
			{ type: "compaction", id: "max", timestamp: 8640000000000000, summary: "max endpoint" },
			{ type: "compaction", id: "min", timestamp: -8640000000000000, summary: "min endpoint" },
			{ type: "compaction", id: "neg", timestamp: -1, summary: "valid negative" },
			{ type: "compaction", id: "zero", timestamp: 0, summary: "epoch zero" },
		]);
		expect(messages.map((message) => message.ts)).toEqual([8640000000000000, -8640000000000000, -1, 0]);
	});

	it("freezes a hydration receipt time when the entry timestamp is absent or invalid", () => {
		const before = Date.now();
		const messages = parseEntries([
			{ type: "compaction", id: "missing", summary: "no timestamp" },
			{ type: "branch_summary", id: "invalid", timestamp: "not-a-date", summary: "bad timestamp" },
		]);
		const after = Date.now();
		for (const message of messages) {
			expect(Number.isFinite(message.ts)).toBe(true);
			expect(message.ts).toBeGreaterThanOrEqual(before);
			expect(message.ts).toBeLessThanOrEqual(after);
		}
	});
});
