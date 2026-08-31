import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCard, type ToolCardProps } from "./ToolCard";

/**
 * DESIGN.md "Tool-execution block anatomy": the block is one disclosure with a
 * two-line header (chevron, status glyph, operation title, localized status
 * word; mono invocation summary with the first non-empty output line), an
 * inset Command/Input + Output body, and status signalling that never relies
 * on colour alone.
 */

function baseProps(overrides: Partial<ToolCardProps> = {}): ToolCardProps {
	return {
		toolCallId: "call-1",
		toolName: "bash",
		phase: "end",
		text: "",
		isError: false,
		...overrides,
	};
}

describe("ToolCard block anatomy", () => {
	let container: HTMLDivElement;
	let root: Root;

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

	function renderCard(props: ToolCardProps): HTMLElement {
		act(() => {
			root.render(<ToolCard {...props} />);
		});
		const card = container.querySelector<HTMLElement>(".th-tool");
		if (!card) throw new Error("tool card missing");
		return card;
	}

	function rerender(props: ToolCardProps): void {
		act(() => {
			root.render(<ToolCard {...props} />);
		});
	}

	function headOf(card: HTMLElement): HTMLButtonElement {
		const head = card.querySelector<HTMLButtonElement>(".th-tool-head");
		if (!head) throw new Error("tool head missing");
		return head;
	}

	function click(head: HTMLButtonElement): void {
		act(() => {
			head.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	/**
	 * jsdom does not implement native activation behavior: a real browser turns
	 * Enter keydown (Space keyup) on a focused <button> into a click. Dispatch
	 * the key event first to prove nothing on the control intercepts it, then
	 * the click the browser would produce.
	 */
	function keyActivate(head: HTMLButtonElement, key: "Enter" | " "): void {
		act(() => {
			head.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
			if (key === " ") {
				head.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
			}
			head.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	function captions(card: HTMLElement): string[] {
		return Array.from(card.querySelectorAll(".th-tool-caption"), (el) => el.textContent ?? "");
	}

	it("exposes each status as a distinct glyph plus a visible word inside the disclosure button", () => {
		let card = renderCard(baseProps({ phase: "start" }));
		expect(card.classList.contains("th-tool--running")).toBe(true);
		const ring = card.querySelector(".th-tool-glyph--running");
		expect(ring).not.toBeNull();
		expect(ring?.getAttribute("aria-hidden")).toBe("true");
		expect(card.querySelector(".th-tool-status--running")?.textContent).toBe("tool.running");
		expect(headOf(card).textContent).toContain("tool.running");

		card = renderCard(baseProps({ phase: "end", text: "ok-output" }));
		const check = card.querySelector(".th-tool-glyph--ok");
		expect(check).not.toBeNull();
		expect(check?.getAttribute("aria-hidden")).toBe("true");
		expect(check?.querySelector("svg")).not.toBeNull();
		expect(card.querySelector(".th-tool-status--ok")?.textContent).toBe("tool.done");

		card = renderCard(baseProps({ phase: "end", isError: true, text: "boom" }));
		const bang = card.querySelector(".th-tool-glyph--error");
		expect(bang).not.toBeNull();
		expect(bang?.getAttribute("aria-hidden")).toBe("true");
		expect(bang?.textContent).toBe("!");
		expect(card.querySelector(".th-tool-status--error")?.textContent).toBe("tool.error");

		// The visible status survives disclosure toggling in either state.
		const head = headOf(card);
		click(head);
		expect(card.querySelector(".th-tool-status--error")?.textContent).toBe("tool.error");
		click(head);
		expect(card.querySelector(".th-tool-status--error")?.textContent).toBe("tool.error");
	});

	it("expands and collapses by pointer", () => {
		const card = renderCard(baseProps({ args: { command: "ls" }, text: "out" }));
		const head = headOf(card);
		expect(head.getAttribute("aria-expanded")).toBe("false");

		click(head);
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(card.querySelector(".th-tool-body")).not.toBeNull();

		click(head);
		expect(head.getAttribute("aria-expanded")).toBe("false");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("expands and collapses by keyboard as a native button", () => {
		const card = renderCard(baseProps({ text: "out" }));
		const head = headOf(card);
		// Native button semantics are what make Enter/Space activation work in a
		// real browser; pin them so the disclosure can never regress to a div.
		expect(head.tagName).toBe("BUTTON");
		expect(head.type).toBe("button");

		head.focus();
		expect(document.activeElement).toBe(head);

		keyActivate(head, "Enter");
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(card.querySelector(".th-tool-body")).not.toBeNull();

		keyActivate(head, " ");
		expect(head.getAttribute("aria-expanded")).toBe("false");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("starts a newly running block expanded and never overrides the user's toggle on completion", () => {
		const card = renderCard(baseProps({ phase: "start", args: { command: "ls" } }));
		const head = headOf(card);
		expect(head.getAttribute("aria-expanded")).toBe("true");

		// Completion alone does not collapse the block the user is watching.
		rerender(baseProps({ phase: "end", args: { command: "ls" }, text: "done-output" }));
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(card.querySelector(".th-tool-body")?.textContent).toContain("done-output");

		// Once the user collapses it, later phase updates must not reopen it.
		click(head);
		expect(head.getAttribute("aria-expanded")).toBe("false");
		rerender(baseProps({ phase: "update", args: { command: "ls" }, text: "more" }));
		expect(head.getAttribute("aria-expanded")).toBe("false");
	});

	it("starts a restored completed block collapsed", () => {
		const card = renderCard(baseProps({ phase: "end", text: "out" }));
		expect(headOf(card).getAttribute("aria-expanded")).toBe("false");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("carries the invocation and the first non-empty output line in the collapsed header", () => {
		const card = renderCard(baseProps({ args: { command: "ls -la /tmp" }, text: "\nfile1\nfile2\n" }));
		expect(card.querySelector(".th-tool-cmd")?.textContent).toBe("ls -la /tmp");
		expect(card.querySelector(".th-tool-sep")?.textContent).toBe(" · ");
		expect(card.querySelector(".th-tool-preview")?.textContent).toBe("file1");
	});

	it("falls back to the output preview alone when no arguments are available", () => {
		const card = renderCard(baseProps({ text: "\n\nfirst line\nsecond\n" }));
		expect(card.querySelector(".th-tool-cmd")).toBeNull();
		expect(card.querySelector(".th-tool-sep")).toBeNull();
		expect(card.querySelector(".th-tool-preview")?.textContent).toBe("first line");
	});

	it("keeps the identical header in either disclosure state", () => {
		const card = renderCard(baseProps({ phase: "end", args: { command: "ls" }, text: "out" }));
		const head = headOf(card);
		const before = head.textContent;
		click(head);
		expect(head.textContent).toBe(before);
		expect(head.querySelector(".th-tool-summary")).not.toBeNull();
		expect(head.querySelector(".th-tool-name")?.textContent).toBe("bash");
	});

	it("shows a verbatim Command section when arguments carry a command", () => {
		const card = renderCard(baseProps({ args: { command: "git status --short" }, text: " M a.ts" }));
		click(headOf(card));
		expect(captions(card)).toEqual(["tool.command", "tool.output"]);
		expect(card.querySelector(".th-tool-io")?.textContent).toBe("git status --short");
	});

	it("shows arguments as two-space indented JSON in an Input section otherwise", () => {
		const args = { path: "/tmp/a", recursive: true };
		const card = renderCard(baseProps({ args }));
		click(headOf(card));
		expect(captions(card)).toEqual(["tool.input"]);
		expect(card.querySelector(".th-tool-io")?.textContent).toBe(JSON.stringify(args, null, 2));
	});

	it("keeps failure output available in an Output section instead of a generic error label", () => {
		const card = renderCard(baseProps({ phase: "end", isError: true, text: "boom\nstack trace" }));
		click(headOf(card));
		expect(captions(card)).toEqual(["tool.output"]);
		expect(card.querySelector(".th-tool-output")?.textContent).toBe("boom\nstack trace");
	});

	it("renders no empty body when there is nothing to show", () => {
		const card = renderCard(baseProps({ phase: "start" }));
		expect(headOf(card).getAttribute("aria-expanded")).toBe("true");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});
});
