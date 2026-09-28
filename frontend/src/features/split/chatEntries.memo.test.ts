import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEntries } from "./chatEntries";

function user(id: string, text: string) {
	return { type: "message", id, message: { role: "user", content: text } };
}

function assistantText(id: string, text: string) {
	return { type: "message", id, message: { role: "assistant", content: text, timestamp: 5 } };
}

/** A fresh object graph misses the WeakMap, so this is the unmemoized parse. */
function parseFresh(entries: readonly unknown[]) {
	return parseEntries(structuredClone(entries));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("parseEntries memoization", () => {
	it("keeps UiMessage identity for unchanged messages after a prepend", () => {
		const tail = [
			user("u1", "one"),
			{
				type: "message",
				id: "call",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lookup" }], timestamp: 2 },
			},
			{ type: "message", id: "result", message: { role: "toolResult", toolCallId: "t1", toolName: "lookup", content: "done" } },
			assistantText("a1", "after"),
			{ type: "compaction", id: "c1", timestamp: "2026-01-02T03:04:05.000Z", summary: "kept", tokensBefore: 3 },
		];
		const before = parseEntries(tail);
		const older = [user("o1", "old-1"), user("o2", "old-2"), user("o3", "old-3")];
		const after = parseEntries([...older, ...tail]);

		expect(after).toHaveLength(before.length + older.length);
		expect(after.slice(0, older.length).map((message) => message.id)).toEqual(["o1", "o2", "o3"]);
		for (let index = 0; index < before.length; index += 1) {
			expect(after[older.length + index]).toBe(before[index]);
		}
		for (const created of after.slice(0, older.length)) {
			expect(before).not.toContain(created);
		}

		const replay = parseEntries([...older, ...tail]);
		for (let index = 0; index < after.length; index += 1) {
			expect(replay[index]).toBe(after[index]);
		}
	});

	it("re-parses exactly the invocation a tool result arrives for at the seam", () => {
		const older = user("older", "older");
		const other = {
			type: "message",
			id: "other",
			message: { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "other" }] },
		};
		const invocation = {
			type: "message",
			id: "call",
			message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lookup" }] },
		};
		const later = assistantText("later", "tail");
		const result = {
			type: "message",
			id: "result",
			message: { role: "toolResult", toolCallId: "t1", toolName: "lookup", content: "done" },
		};

		const before = parseEntries([older, other, invocation, later]);
		const arrived = parseEntries([older, other, invocation, result, later]);

		expect(arrived.map((message) => message.id)).toEqual(["older", "other", "call", "later"]);
		expect(arrived[0]).toBe(before[0]);
		expect(arrived[1]).toBe(before[1]);
		expect(arrived[2]).not.toBe(before[2]);
		expect(arrived[3]).toBe(before[3]);
		expect(arrived[2]?.blocks).toEqual([{ kind: "tool", id: "t1", name: "lookup", text: "done" }]);
		expect(arrived).toEqual(parseFresh([older, other, invocation, result, later]));

		// The same seam when the result was already committed and the invocation
		// arrives on the older page: only that invocation is new, and every
		// message after the result keeps the identity it had as a tail row.
		const tail = parseEntries([result, later]);
		const prepended = parseEntries([older, invocation, result, later]);
		expect(prepended.map((message) => message.id)).toEqual(["older", "call", "later"]);
		expect(prepended[1]).not.toBe(tail[0]);
		expect(prepended[1]?.blocks).toEqual([{ kind: "tool", id: "t1", name: "lookup", text: "done" }]);
		expect(prepended[2]).toBe(tail[1]);
		expect(prepended).toEqual(parseFresh([older, invocation, result, later]));
	});

	it("deep-equals the unmemoized parse on the existing fixtures", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_800_000_000_000);
		const fixtures: readonly unknown[][] = [
			[
				{ type: "message", id: "e1", message: { role: "assistant", content: [] } },
				{ type: "message", id: "e2", message: { role: "assistant", content: "reply" } },
				{ type: "message", id: "e3", message: { role: "user", content: [] } },
			],
			[
				{ type: "custom_message", id: "hidden", customType: "hook", content: "secret", display: false },
				{ type: "custom_message", id: "unset", customType: "hook", content: "implicit" },
				{ type: "custom_message", id: "shown", customType: "hook", content: "visible", display: true },
			],
			[
				{ type: "custom_message", id: "m-hidden", customType: "hook", content: "secret", message: { display: false } },
				{ type: "custom_message", id: "m-shown", customType: "hook", content: "visible", message: { display: true } },
			],
			[
				{ type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lookup" }] } },
				{ type: "message", id: "result", message: { role: "toolResult", toolCallId: "t1", toolName: "lookup", content: "done" } },
			],
			[
				{
					type: "message",
					id: "e1",
					message: {
						role: "assistant",
						timestamp: 42,
						content: [
							{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
							{ type: "image_ref", mimeType: "image/jpeg", byteLength: 2048, ref: { toolCallId: "t9", contentIndex: 0 } },
						],
					},
				},
			],
			[
				{
					type: "message",
					id: "e1",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "t1", name: "read" },
							{ type: "toolResult", id: "t1", data: "iVBORw0KGgo=", mimeType: "image/png" },
						],
					},
				},
			],
			[
				{ type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "screenshot" }] } },
				{
					type: "message",
					id: "result",
					message: {
						role: "toolResult",
						toolCallId: "t2",
						toolName: "screenshot",
						content: [
							{ type: "text", text: "shot" },
							{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
							{ type: "image_ref", mimeType: "image/jpeg", byteLength: 2048, ref: { toolCallId: "t2", contentIndex: 1 } },
						],
					},
				},
			],
			[
				{
					type: "message",
					id: "e1",
					message: {
						role: "assistant",
						timestamp: 42,
						content: "partial",
						errorMessage: "provider overloaded",
						stopReason: "error",
					},
				},
				{ type: "message", id: "e2", message: { role: "assistant", content: "fine" } },
			],
			[
				{ type: "message", id: "e1", message: { role: "assistant", content: [], errorMessage: "", stopReason: "error" } },
			],
			[
				{
					type: "compaction",
					id: "c1",
					timestamp: "2026-01-02T03:04:05.000Z",
					summary: "Compacted summary text",
					tokensBefore: 48213,
				},
			],
			[
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
			],
			[
				{ type: "compaction", id: "c2", tokensBefore: 10 },
				{ type: "branch_summary", id: "b2", summary: 42 },
				{ type: "message", id: "m1", message: { role: "user", content: "kept" } },
			],
			[
				{ type: "message", id: "m1", message: { role: "user", content: "before" } },
				{ type: "compaction", id: "c1", summary: "middle" },
				{ type: "message", id: "m2", message: { role: "assistant", content: "after" } },
			],
			[
				{ type: "compaction", id: "c1", summary: "compacted" },
				{ type: "branch_summary", id: "b1", summary: "branch" },
			],
			[
				{ type: "custom_message", id: "x1", customType: "compaction", display: true, content: "hook one" },
				{ type: "custom_message", id: "x2", customType: "branch_summary", display: true, content: "hook two" },
				{ type: "custom_message", id: "x3", customType: "weather", display: true, content: "hook three" },
			],
			[{ type: "compaction", id: "zero", timestamp: 0, summary: "zero" }],
			[
				{ type: "compaction", id: "over", timestamp: 8640000000000001, summary: "positive overflow" },
				{ type: "branch_summary", id: "under", timestamp: -8640000000000001, summary: "negative overflow" },
			],
			[
				{ type: "compaction", id: "max", timestamp: 8640000000000000, summary: "max endpoint" },
				{ type: "compaction", id: "min", timestamp: -8640000000000000, summary: "min endpoint" },
				{ type: "compaction", id: "neg", timestamp: -1, summary: "valid negative" },
				{ type: "compaction", id: "zero", timestamp: 0, summary: "epoch zero" },
			],
			[
				{ type: "compaction", id: "missing", summary: "no timestamp" },
				{ type: "branch_summary", id: "invalid", timestamp: "not-a-date", summary: "bad timestamp" },
			],
		];

		for (const entries of fixtures) {
			const memoized = parseEntries(entries);
			const unmemoized = parseFresh(entries);
			expect(memoized).toEqual(unmemoized);
			const again = parseEntries(entries);
			expect(again).toEqual(unmemoized);
			for (let index = 0; index < memoized.length; index += 1) {
				expect(again[index]).toBe(memoized[index]);
			}
		}
	});
});
