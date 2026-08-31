import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatPane } from "./chatPaneTestHarness";

describe("ChatTranscript markdown rendering", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	it("renders assistant markdown as formatted HTML (code block and emphasis)", () => {
		const { deliver } = renderChatPane(root);

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [
						{ kind: "text", id: "a1", text: "Here is **bold** text." },
					],
				},
			});
		});

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown).not.toBeNull();
		expect(markdown?.querySelector("strong")?.textContent).toBe("bold");

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [
						{ kind: "text", id: "a2", text: "Run this:\n\n```\necho hi\n```" },
					],
				},
			});
		});
		const codeBlocks = container.querySelectorAll(".th-chat-markdown pre code");
		expect(codeBlocks[codeBlocks.length - 1]?.textContent).toContain("echo hi");
	});

	it("renders streaming deltas as markdown", async () => {
		const { deliver } = renderChatPane(root);

		await act(async () => {
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				messageId: "m1",
				delta: { kind: "text_delta", delta: "## heading" },
			});
		});

		expect(container.querySelector(".th-chat-msg--streaming h2")).not.toBeNull();
	});

	it("renders GFM tables", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [
						{ kind: "text", id: "t1", text: "| a | b |\n| --- | --- |\n| 1 | 2 |" },
					],
				},
			});
		});
		const table = container.querySelector(".th-chat-markdown table");
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll("td").length).toBe(2);
	});
});
