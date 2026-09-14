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
			{ id: "c2", role: "compactionSummary", blocks: [{ kind: "text", text: "42100 tokens\nKept the plan." }], ts: 7 },
		]);
		expect(messages.every(hasRenderableContent)).toBe(true);
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
