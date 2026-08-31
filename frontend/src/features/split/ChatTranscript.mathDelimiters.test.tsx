import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatPane } from "./chatPaneTestHarness";

describe("ChatTranscript backslash-delimiter math", () => {
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

	it("typesets a compact backslash-bracket pair as display math", () => {
		deliverText(String.raw`\[x\]`);
		expect(container.querySelector(".katex-display")).not.toBeNull();
	});

	it("typesets a compact backslash-paren pair as inline math", () => {
		deliverText(String.raw`\(x\)`);
		expect(container.querySelector(".katex")).not.toBeNull();
		expect(container.querySelector(".katex-display")).toBeNull();
	});

	it("keeps backslash delimiters literal inside an angle-bracket URL autolink", () => {
		const source = String.raw`https://example.com/\(x\)`;
		deliverText(`<${source}>`);
		const link = container.querySelector("a");
		expect(link).not.toBeNull();
		expect(link?.querySelector(".katex")).toBeNull();
		expect(link?.textContent).toBe(source);
	});

	it("keeps backslash delimiters literal inside a mailto URI autolink", () => {
		const source = String.raw`mailto:a\(b\)@example.com`;
		deliverText(`<${source}>`);
		const link = container.querySelector("a");
		expect(link).not.toBeNull();
		expect(link?.querySelector(".katex")).toBeNull();
		expect(link?.textContent).toBe(source);
	});

	it("still typesets backslash delimiters inside an explicit link label", () => {
		deliverText(String.raw`[\(x\)](https://example.com)`);
		const link = container.querySelector("a");
		expect(link).not.toBeNull();
		expect(link?.querySelector(".katex")).not.toBeNull();
		expect(link?.getAttribute("href")).toBe("https://example.com");
	});

	it("still typesets backslash delimiters in an explicit www link label", () => {
		deliverText(String.raw`[www.example.com/\(x\)](https://example.com)`);
		const link = container.querySelector("a");
		expect(link).not.toBeNull();
		expect(link?.querySelector(".katex")).not.toBeNull();
	});

	it("keeps backslash delimiters literal inside a bare GFM URL autolink", () => {
		const source = String.raw`https://example.com/\(x\)`;
		deliverText(source);
		const link = container.querySelector("a");
		expect(link).not.toBeNull();
		expect(link?.querySelector(".katex")).toBeNull();
		expect(link?.textContent).toBe(source);
	});

	it("keeps backslash delimiters literal inside a bare GFM www URL autolink", () => {
		const source = String.raw`www.example.com/\(x\)`;
		deliverText(source);
		const link = container.querySelector("a");
		expect(link).not.toBeNull();
		expect(link?.querySelector(".katex")).toBeNull();
		expect(link?.textContent).toBe(source);
	});

	it("preserves TeX inside backslash-bracket display delimiters", () => {
		deliverText(String.raw`\[ CCI=\frac{a}{b} \]`);
		expect(container.querySelector(".katex-display")).not.toBeNull();
		expect(container.querySelector(".katex annotation")?.textContent).toBe(String.raw` CCI=\frac{a}{b} `);
	});

	it.each([
		["punctuation escapes", String.raw`\(\{x\} + \# + \_ + \% + \&\)`, String.raw`\{x\} + \# + \_ + \% + \&`],
		["a TeX spacing escape in a blockquote", "> \\[a \\> b\n> c\\]", "a \\> b\nc"],
		["a TeX escape at the start of a blockquote continuation", "> \\[a\n> \\>b\\]", "a\n\\>b"],
		["a TeX escape at the start of a list continuation", "- \\[a\n  \\>b\\]", "a\n\\>b"],
		["ordinary TeX commands", String.raw`\[ \frac{a}{b}\cdot c \]`, String.raw` \frac{a}{b}\cdot c `],
	])("preserves the original source spelling of %s", (_label, source, value) => {
		deliverText(source);
		expect(container.querySelector(".katex annotation")?.textContent).toBe(value);
	});

	it("typesets backslash-bracket display math from CRLF input", () => {
		deliverText("\\[x\\]\r\n");
		expect(container.querySelector(".katex-display")).not.toBeNull();
	});

	it.each([
		["a blockquote", "> \\[a\n> b\\]", "a\nb"],
		["a blockquote nested in a list", "- > \\[a\n  > b\\]", "a\nb"],
		["a list item", "- \\[a\n  b\\]", "a\nb"],
		["a list item whose formula starts with its marker character", "- \\[-b\\]", "-b"],
		["a plain multiline paragraph", "\\[a\nb\\]", "a\nb"],
		["a plain single-line paragraph", "\\[a\\]", "a"],
	])("uses container-free aligned TeX for %s", (_label, source, value) => {
		deliverText(source);
		expect(container.querySelector(".katex annotation")?.textContent).toBe(value);
	});

	it.each([
		["backtick fence", "```\n\\[x\\]\n```"],
		["tilde fence", "~~~\n\\[x\\]\n~~~"],
		["backtick fence in a blockquote", "> ```\n> \\[x\\]\n> ```"],
		["tilde fence in a blockquote", "> ~~~\n> \\[x\\]\n> ~~~"],
		["backtick fence in a list item", "- ```\n  \\[x\\]\n  ```"],
		["tilde fence in a list item", "- ~~~\n  \\[x\\]\n  ~~~"],
		["four-space indented code", "    \\[x\\]"],
		["tab-indented code", "\t\\[x\\]"],
		["mixed space-and-tab indented code", "  \t\\[x\\]"],
	])("keeps delimiters literal inside %s", (_label, source) => {
		deliverText(source);
		expect(container.querySelector(".katex")).toBeNull();
		expect(container.querySelector("pre code")?.textContent).toContain(String.raw`\[x\]`);
	});

	it.each([
		["two", String.raw`\\[x\\]`],
		["three", String.raw`\\\[x\\\]`],
		["four", String.raw`\\\\[x\\\\]`],
	])("does not treat a run of %s backslashes as math", (_label, source) => {
		deliverText(source);
		expect(container.querySelector(".katex")).toBeNull();
	});

	it("does not pair an opener with a closer in an indented code node", () => {
		deliverText("\\[\n\n    literal \\]");
		expect(container.querySelector(".katex")).toBeNull();
		expect(container.querySelector("pre code")?.textContent).toContain(String.raw`literal \]`);
	});

	it("leaves an unclosed display opener literal without stray dollars", () => {
		deliverText(String.raw`\[ x`);
		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).toBeNull();
		expect(markdown?.textContent).not.toContain("$");
		expect(markdown?.textContent).toContain("[ x");
	});

	it("typesets display math in backslash-bracket delimiters through KaTeX", () => {
		deliverText(String.raw`The Commodity Channel Index:

\[
\mathrm{CCI} = \frac{TP - SMA(TP)}{0.015 \cdot MD}
\]`);

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown).not.toBeNull();
		expect(markdown?.querySelector(".katex")).not.toBeNull();
		expect(markdown?.querySelector(".katex-display")).not.toBeNull();
	});

	it("typesets inline math in backslash-paren delimiters through KaTeX inline", () => {
		deliverText(String.raw`The mean is \(\frac{a + b}{2}\) here.`);

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).not.toBeNull();
		expect(markdown?.querySelector(".katex-display")).toBeNull();
		expect(markdown?.textContent).not.toContain(String.raw`\(`);
	});

	it("keeps backslash delimiters inside a fenced code block literal", () => {
		deliverText("Before\n\n```\n\\[x\\] and \\(y\\)\n```");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).toBeNull();
		expect(markdown?.querySelector("pre code")?.textContent).toContain("\\[x\\]");
		expect(markdown?.querySelector("pre code")?.textContent).toContain("\\(y\\)");
	});

	it("keeps backslash delimiters inside inline code literal", () => {
		deliverText("Literal `\\[x\\]` stays code.");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).toBeNull();
		expect(markdown?.querySelector("p code")?.textContent).toBe("\\[x\\]");
	});

	it("renders a half-typed opening delimiter mid-stream as plain text, no KaTeX, no stray dollars", async () => {
		const { deliver } = renderChatPane(root);

		await act(async () => {
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				messageId: "m1",
				delta: { kind: "text_delta", delta: String.raw`formula: \[\frac{1}{2` },
			});
		});

		const stream = container.querySelector(".th-chat-msg--streaming");
		expect(stream).not.toBeNull();
		expect(stream?.querySelector(".katex")).toBeNull();
		expect(stream?.textContent).not.toContain("$");
		expect(stream?.textContent).toContain(String.raw`\frac{1}{2`);
	});

	it("treats a doubled backslash before a bracket as an escaped literal bracket, not math", () => {
		deliverText(String.raw`literal: \\[x\\]`);

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).toBeNull();
		expect(markdown?.textContent).toContain(String.raw`\[x\]`);
	});

	it("still typesets existing dollar-delimiter math, inline and display, exactly as before", () => {
		deliverText("inline $E = mc^2$ and\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$");

		const markdown = container.querySelector(".th-chat-markdown");
		expect(markdown?.querySelector(".katex")).not.toBeNull();
		expect(markdown?.querySelector(".katex-display")).not.toBeNull();
	});
});
