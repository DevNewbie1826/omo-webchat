import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderChatPane, requireElement } from "./chatPaneTestHarness";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
const click = (label: string) => act(() => requireElement(
	[...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label), label,
).click());
const input = (selector: string, value: string) => act(() => {
	const element = requireElement(container.querySelector<HTMLInputElement>(selector), selector);
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
});

it.each([true, false].flatMap(inline => ["selection", "text"].map(kind => ({ inline, kind }))))(
	"requires explicit completion of a $kind draft from inline=$inline after replacement", async ({ inline, kind }) => {
		// Given a first answer and an unsubmitted last draft from either presentation.
		const { deliver, sent } = renderChatPane(root);
		const selection = kind === "selection";
		const text = "unsent text";
		const empty = { id: "empty", question: "Empty draft" };
		const last = { id: "last", header: "Last", ...(selection ? { multiSelect: true, options: [{ label: "B" }] } : {}) };
		const request = { type: "approval", sessionId: "chat-1", id: "completion", method: "question" } as const;
		await act(async () => deliver({ ...request, nonBlocking: inline, questions: [{ id: "first", options: [{ label: "A" }] }, last, empty] }));
		click("A");
		if (!inline) click("Last");
		if (selection) {
			click("B");
		} else {
			if (inline) click("question.answer");
			input(inline ? ".th-question-bar-input" : ".th-approval-question-text", text);
		}
		act(() => deliver({ ...request, nonBlocking: true, questions: [{ id: "replacement", options: [{ label: "NEW" }] }, last, empty] }));
		// When the user answers only the replacement.
		click("NEW");
		// Then nothing leaves, the draft remains reachable, and only its own Send completes it.
		expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
		if (selection) {
			const option = requireElement(container.querySelector('.th-question-bar [aria-pressed]'), "last draft");
			expect(option.getAttribute("aria-pressed")).toBe("true");
		} else {
			click("question.answer");
			expect(container.querySelector<HTMLInputElement>(".th-question-bar-input")?.value).toBe(text);
		}
		click("question.submit");
		expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
		expect(container.querySelector(".th-question-bar-text")?.textContent).toBe(empty.question);
		click("question.answer");
		click("question.submit");
		expect(sent.filter(frame => frame.type === "approval.respond").map(frame => frame.answers)).toEqual([
			{ replacement: { selected: ["NEW"] }, last: selection ? { selected: ["B"] } : { text }, empty: { text: "" } },
		]);
	},
);
