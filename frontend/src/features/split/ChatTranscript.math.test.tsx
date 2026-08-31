import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatPane } from "./chatPaneTestHarness";

/**
 * LaTeX math support: remark-math parses $...$/$$...$$ and a KaTeX rehype
 * renderer typesets them, in finalized messages and in the streaming buffer
 * (both flow through the one Markdown seam in ChatTranscript). An incomplete
 * or malformed formula mid-stream must degrade to plain text without ever
 * throwing or unmounting the message; dollar signs inside code stay literal.
 */
describe("ChatTranscript math rendering", () => {
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

	function deliverText(text: string, id = "m1"): void {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", id, text }] },
			});
		});
	}

	it("typesets inline math instead of showing the literal source", () => {
		deliverText("질량-에너지 등가: $E = mc^2$ 입니다.");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown).not.toBeNull();
		expect(markdown?.querySelector(".katex")).not.toBeNull();
		// The delimiters and raw source must not leak into the rendered text.
		expect(markdown?.textContent).not.toContain("$E = mc^2$");
	});

	it("typesets display math as a display block", () => {
		deliverText("$$\\int_0^1 x^2 dx = \\frac{1}{3}$$");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex-display")).not.toBeNull();
	});

	it("degrades an unclosed delimiter mid-stream to plain text without throwing", async () => {
		const { deliver } = renderChatPane(root);

		await act(async () => {
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				messageId: "m1",
				delta: { kind: "text_delta", delta: "energy: $E = mc" },
			});
		});

		// The message stays mounted; the half-typed formula renders as-is.
		const stream = container.querySelector(".th-chat-msg--streaming");
		expect(stream).not.toBeNull();
		expect(stream?.querySelector(".katex")).toBeNull();
		expect(stream?.textContent).toContain("$E = mc");
	});

	it("renders malformed delimited math as source inline instead of crashing", () => {
		deliverText("broken: $\\frac{$ tail");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown).not.toBeNull();
		// No crash, no blank transcript: the offending source stays visible.
		expect(markdown?.textContent).toContain("\\frac");
	});

	it("never treats a dollar sign inside a code fence or inline code as math", () => {
		deliverText("```\n$not math$\n```\n\nInline `$also not$` code.");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).toBeNull();
		expect(markdown?.querySelector("pre code")?.textContent).toContain("$not math$");
		expect(markdown?.querySelector("p code")?.textContent).toBe("$also not$");
	});
});
