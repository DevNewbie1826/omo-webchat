import { describe, expect, it } from "vitest";
import { concatEntries, hasRenderableContent, parseEntries } from "./chatEntries";

describe("concatEntries", () => {
	it("flattens page arrays in order and ignores non-arrays", () => {
		expect(concatEntries([[{ a: 1 }], [{ b: 2 }, { c: 3 }], "nope"])).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});

describe("hasRenderableContent", () => {
	it("treats only zero-block assistant messages as non-renderable", () => {
		expect(hasRenderableContent({ role: "assistant", blocks: [] })).toBe(false);
		expect(hasRenderableContent({ role: "user", blocks: [] })).toBe(true);
		// A message whose blocks became non-empty via tool folding anchors
		// tool output and must still render.
		expect(hasRenderableContent({
			role: "assistant",
			blocks: [{ kind: "tool", id: "t1", name: "lookup", text: "out" }],
		})).toBe(true);
		expect(hasRenderableContent({
			role: "custom",
			blocks: [{ kind: "text", text: "hook" }],
		})).toBe(true);
	});
});

describe("parseEntries", () => {
	it("keeps empty assistant completions in state; the presentation predicate hides them", () => {
		const messages = parseEntries([
			{ type: "message", id: "e1", message: { role: "assistant", content: [] } },
			{ type: "message", id: "e2", message: { role: "assistant", content: "reply" } },
			{ type: "message", id: "e3", message: { role: "user", content: [] } },
		]);
		// Restored history keeps the empty completion in transcript state — it
		// anchors current-turn tool results exactly like the live path; only the
		// presentation seam hides its blank row.
		expect(messages).toEqual([
			{ id: "e1", role: "assistant", blocks: [], ts: 0 },
			{ id: "e2", role: "assistant", blocks: [{ kind: "text", text: "reply" }], ts: 0 },
			{ id: "e3", role: "user", blocks: [], ts: 0 },
		]);
		expect(messages.filter(hasRenderableContent).map((message) => message.id)).toEqual(["e2", "e3"]);
	});

	it("drops custom_message entries unless display is explicitly true", () => {
		const messages = parseEntries([
			{ type: "custom_message", id: "hidden", customType: "hook", content: "secret", display: false },
			{ type: "custom_message", id: "unset", customType: "hook", content: "implicit" },
			{ type: "custom_message", id: "shown", customType: "hook", content: "visible", display: true },
		]);
		expect(messages.map((message) => message.id)).toEqual(["shown"]);
		expect(messages[0]).toEqual({
			id: "shown",
			role: "custom",
			customType: "hook",
			blocks: [{ kind: "text", text: "visible" }],
			ts: 0,
		});
	});

	it("honors a message-level display flag on custom_message entries", () => {
		const messages = parseEntries([
			{ type: "custom_message", id: "m-hidden", customType: "hook", content: "secret", message: { display: false } },
			{ type: "custom_message", id: "m-shown", customType: "hook", content: "visible", message: { display: true } },
		]);
		expect(messages.map((message) => message.id)).toEqual(["m-shown"]);
	});

	it("maps branch summary entries to renderable rows instead of skipping them", () => {
		const messages = parseEntries([
			// Observed engine behavior: branch summaries persist as session
			// entries and resurface during hydration.
			{ type: "message", id: "b1", message: { role: "branchSummary", content: { summary: "Branched context" }, timestamp: 5 } },
			{ type: "custom_message", id: "b2", customType: "branchSummary", content: "Branched from earlier session" },
		]);
		expect(messages).toEqual([
			{ id: "b1", role: "branchSummary", blocks: [{ kind: "text", text: "Branched context" }], ts: 5 },
			{ id: "b2", role: "branchSummary", blocks: [{ kind: "text", text: "Branched from earlier session" }], ts: 0 },
		]);
		expect(messages.every(hasRenderableContent)).toBe(true);
	});

	it("maps compaction summary entries to renderable rows with tokens and summary text", () => {
		const messages = parseEntries([
			{ type: "custom_message", id: "c1", customType: "compaction_summary", content: "Compacted the earlier turns." },
			{ type: "message", id: "c2", message: { role: "compactionSummary", content: { tokens: 42100, summary: "Kept the plan." }, timestamp: 7 } },
		]);
		expect(messages).toEqual([
			{ id: "c1", role: "compactionSummary", blocks: [{ kind: "text", text: "Compacted the earlier turns." }], ts: 0 },
			{ id: "c2", role: "compactionSummary", blocks: [{ kind: "text", text: "Kept the plan." }], ts: 7, summaryTokens: 42100 },
		]);
		expect(messages.every(hasRenderableContent)).toBe(true);
	});

	it("treats inherited property names as ordinary custom types, keeping the display gate", () => {
		// The summary-role lookup must be own-key-only: "constructor",
		// "toString" and "__proto__" are inherited Object properties, not
		// summary roles, so they fall through to the standard display gate.
		const messages = parseEntries([
			{ type: "custom_message", id: "h1", customType: "constructor", content: "secret", display: false },
			{ type: "custom_message", id: "h2", customType: "toString", content: "secret", display: false },
			{ type: "custom_message", id: "h3", customType: "__proto__", content: "secret", display: false },
			{ type: "custom_message", id: "h4", customType: "constructor", content: "visible", display: true },
			{ type: "custom_message", id: "h5", customType: "toString", content: "shown", display: true },
		]);
		expect(messages.map((message) => message.id)).toEqual(["h4", "h5"]);
		// Displayed entries keep the existing custom-role HookCard behavior.
		expect(messages[0]).toEqual({
			id: "h4",
			role: "custom",
			customType: "constructor",
			blocks: [{ kind: "text", text: "visible" }],
			ts: 0,
		});
		expect(messages[1]?.role).toBe("custom");
		expect(messages[1]?.customType).toBe("toString");
	});

	it("does not divert inherited property message roles into summary rows", () => {
		const messages = parseEntries([
			{ type: "message", id: "r1", message: { role: "constructor", content: "plain" } },
			{ type: "message", id: "r2", message: { role: "toString", content: "plain" } },
		]);
		expect(messages.map((message) => message.role)).toEqual(["constructor", "toString"]);
	});

	it("keeps summary-named custom entries with explicit display:false hidden", () => {
		// The summary bypass never overrides an explicit display:false — the
		// display gate hides those entries exactly like any other custom type.
		const messages = parseEntries([
			{ type: "custom_message", id: "s1", customType: "branchSummary", content: "hidden branch", display: false },
			{ type: "custom_message", id: "s2", customType: "compaction_summary", content: "hidden compaction", display: false },
			{ type: "custom_message", id: "s3", customType: "branchSummary", content: "shown branch", display: true },
		]);
		expect(messages.map((message) => message.id)).toEqual(["s3"]);
		expect(messages[0]?.role).toBe("branchSummary");
	});

	it("hydrates persisted compaction entries as summary rows with tokens kept separate", () => {
		// Observed engine behavior/contract: compaction summaries persist as
		// session entries of type "compaction" carrying the summary text and
		// the compacted token count, and resurface during history hydration.
		const messages = parseEntries([
			{ type: "compaction", id: "comp-1", parentId: null, timestamp: "2026-09-14T12:00:01.000Z", tokensBefore: 42100, summary: "Kept the plan.\nSecond line of the compaction summary" },
			{ type: "message", id: "control", message: { role: "user", content: "still here", timestamp: 1789387202000 } },
		]);
		expect(messages).toEqual([
			{
				id: "comp-1",
				role: "compactionSummary",
				blocks: [{ kind: "text", text: "Kept the plan.\nSecond line of the compaction summary" }],
				ts: Date.parse("2026-09-14T12:00:01.000Z"),
				summaryTokens: 42100,
			},
			{ id: "control", role: "user", blocks: [{ kind: "text", text: "still here" }], ts: 1789387202000 },
		]);
		expect(messages.every(hasRenderableContent)).toBe(true);
	});

	it("hydrates persisted branch_summary entries as summary rows", () => {
		// Observed engine behavior/contract: branch summaries persist as
		// session entries of type "branch_summary".
		const messages = parseEntries([
			{ type: "branch_summary", id: "branch-1", parentId: null, timestamp: "2026-09-14T12:00:00.000Z", summary: "Branched context\nBranch detail line" },
		]);
		expect(messages).toEqual([
			{
				id: "branch-1",
				role: "branchSummary",
				blocks: [{ kind: "text", text: "Branched context\nBranch detail line" }],
				ts: Date.parse("2026-09-14T12:00:00.000Z"),
			},
		]);
	});

	it("keeps a zero token count visible on persisted compaction entries", () => {
		const messages = parseEntries([
			{ type: "compaction", id: "comp-0", timestamp: 1789387201000, tokensBefore: 0, summary: "Nothing was dropped." },
		]);
		expect(messages[0]).toEqual({
			id: "comp-0",
			role: "compactionSummary",
			blocks: [{ kind: "text", text: "Nothing was dropped." }],
			ts: 1789387201000,
			summaryTokens: 0,
		});
	});

	it("skips persisted summary entries whose summary text is not a string", () => {
		const messages = parseEntries([
			{ type: "compaction", id: "bad-1", tokensBefore: 10 },
			{ type: "branch_summary", id: "bad-2", summary: 42 },
		]);
		expect(messages).toEqual([]);
	});

	it("keeps tool-result folding renderable", () => {
		const messages = parseEntries([
			{ type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lookup" }] } },
			{ type: "message", id: "result", message: { role: "toolResult", toolCallId: "t1", toolName: "lookup", content: "done" } },
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([{ kind: "tool", id: "t1", name: "lookup", text: "done" }]);
	});
});
