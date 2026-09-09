import { describe, expect, it } from "vitest";
import { concatEntries, parseEntries } from "./chatEntries";

describe("concatEntries", () => {
	it("flattens page arrays in order and ignores non-arrays", () => {
		expect(concatEntries([[{ a: 1 }], [{ b: 2 }, { c: 3 }], "nope"])).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});

describe("parseEntries", () => {
	it("omits assistant messages with no renderable blocks", () => {
		expect(parseEntries([
			{ type: "message", id: "e1", message: { role: "assistant", content: [] } },
			{ type: "message", id: "e2", message: { role: "assistant", content: "reply" } },
			{ type: "message", id: "e3", message: { role: "user", content: [] } },
		])).toEqual([
			{ id: "e2", role: "assistant", blocks: [{ kind: "text", text: "reply" }], ts: 0 },
			{ id: "e3", role: "user", blocks: [], ts: 0 },
		]);
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
