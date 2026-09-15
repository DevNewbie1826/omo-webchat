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

	it("keeps a failed assistant turn renderable even with zero blocks", () => {
		expect(hasRenderableContent({ role: "assistant", blocks: [], errorMessage: "provider overloaded" })).toBe(true);
		expect(hasRenderableContent({ role: "assistant", blocks: [], errorMessage: "" })).toBe(true);
		expect(hasRenderableContent({ role: "assistant", blocks: [], stopReason: "error" })).toBe(true);
		// A bare abort with no failure text is a user stop (observed engine
		// contract: the user-stop path stamps stopReason "aborted" with
		// ordinary text), not a failure — no error row, and a blank cancelled
		// turn stays hidden like any zero-block row.
		expect(hasRenderableContent({ role: "assistant", blocks: [], stopReason: "aborted" })).toBe(false);
		expect(hasRenderableContent({ role: "assistant", blocks: [{ kind: "text", text: "partial" }], stopReason: "aborted" })).toBe(true);
		// A successful stop reason alone does not make a blank row renderable.
		expect(hasRenderableContent({ role: "assistant", blocks: [], stopReason: "stop" })).toBe(false);
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

	it("keeps tool-result folding renderable", () => {
		const messages = parseEntries([
			{ type: "message", id: "call", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lookup" }] } },
			{ type: "message", id: "result", message: { role: "toolResult", toolCallId: "t1", toolName: "lookup", content: "done" } },
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([{ kind: "tool", id: "t1", name: "lookup", text: "done" }]);
	});

	it("preserves image and image_ref blocks in restored message content", () => {
		const messages = parseEntries([
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
		]);
		expect(messages[0]?.blocks).toEqual([
			{ kind: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			{ kind: "image_ref", mimeType: "image/jpeg", byteLength: 2048, ref: { toolCallId: "t9", contentIndex: 0 } },
		]);
	});

	it("folds restored inline toolResult image fields onto the merged tool block", () => {
		const messages = parseEntries([
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
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.blocks).toEqual([
			{ kind: "tool", id: "t1", name: "read", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
	});

	it("folds a restored toolResult message's image content onto the merged tool block", () => {
		const messages = parseEntries([
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
		]);
		expect(messages).toHaveLength(1);
		// The first image lands on the merged block (the ContentBlock shape has
		// one image slot); additional image blocks survive as standalone blocks.
		expect(messages[0]?.blocks).toEqual([
			{ kind: "tool", id: "t2", name: "screenshot", text: "shot", data: "iVBORw0KGgo=", mimeType: "image/png" },
			{ kind: "image_ref", mimeType: "image/jpeg", byteLength: 2048, ref: { toolCallId: "t2", contentIndex: 1 } },
		]);
	});

	it("carries errorMessage and stopReason through restored history", () => {
		const messages = parseEntries([
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
		]);
		expect(messages[0]).toEqual({
			id: "e1",
			role: "assistant",
			blocks: [{ kind: "text", text: "partial" }],
			ts: 42,
			errorMessage: "provider overloaded",
			stopReason: "error",
		});
		// Entries without the fields restore exactly as before.
		expect(messages[1]).toEqual({
			id: "e2",
			role: "assistant",
			blocks: [{ kind: "text", text: "fine" }],
			ts: 0,
		});
	});

	it("keeps an empty restored errorMessage so the renderer can fall back to a generic label", () => {
		const messages = parseEntries([
			{ type: "message", id: "e1", message: { role: "assistant", content: [], errorMessage: "", stopReason: "error" } },
		]);
		expect(messages[0]?.errorMessage).toBe("");
		expect(messages[0]?.stopReason).toBe("error");
		expect(messages.filter(hasRenderableContent).map((message) => message.id)).toEqual(["e1"]);
	});
});
