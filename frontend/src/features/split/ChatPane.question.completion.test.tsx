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
// The answering surface is the modal window, which portals to document.body.
const click = (label: string) => act(() => requireElement(
	[...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label), label,
).click());
const input = (selector: string, value: string) => act(() => {
	const element = requireElement(document.querySelector<HTMLInputElement>(selector), selector);
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
});
const clickTab = (label: string) => act(() => requireElement(
	[...document.querySelectorAll<HTMLButtonElement>('.th-modal .th-approval-question-tabs [role="tab"]')]
		.find(button => button.textContent === label), `tab ${label}`,
).click());
// A blocking arrival auto-opens the window; a non-blocking one leaves it to
// the band's Open button. Same-id presentation hops keep the open state.
const ensureWindowOpen = () => {
	if (document.querySelector(".th-modal .th-approval-question") !== null) return;
	click("approval.band.open");
};

it.each([true, false].flatMap(inline => ["selection", "text"].map(kind => ({ inline, kind }))))(
	"keeps an unsubmitted $kind draft after replacement from inline=$inline until the window submits", async ({ inline, kind }) => {
		// Given a first answer and an unsubmitted last draft from either presentation.
		const { deliver, sent } = renderChatPane(root);
		const selection = kind === "selection";
		const text = "unsent text";
		const empty = { id: "empty", question: "Empty draft" };
		const last = { id: "last", header: "Last", ...(selection ? { multiSelect: true, options: [{ label: "B" }] } : {}) };
		const request = { type: "approval", sessionId: "chat-1", id: "completion", method: "question" } as const;
		await act(async () => deliver({ ...request, nonBlocking: inline, questions: [{ id: "first", options: [{ label: "A" }] }, last, empty] }));
		ensureWindowOpen();
		click("A");
		clickTab("Last");
		if (selection) {
			click("B");
		} else {
			input(".th-approval-question-text", text);
		}
		act(() => deliver({ ...request, nonBlocking: true, questions: [{ id: "replacement", options: [{ label: "NEW" }] }, last, empty] }));
		// When the user answers only the replacement.
		clickTab("approval.question.tab");
		click("NEW");
		// Then nothing leaves: the surviving draft is still reachable on its tab.
		expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
		clickTab("Last");
		if (selection) {
			const option = requireElement(document.querySelector('.th-approval-question-option[aria-pressed="true"]'), "last draft");
			expect(option.textContent).toBe("B");
		} else {
			expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe(text);
		}
		// The never-touched last question stays blank — the retired bar's
		// explicit-blank Send is gone, so the panel omits it from the payload.
		clickTab("Empty draft");
		click("approval.submit");
		expect(sent.filter(frame => frame.type === "approval.respond").map(frame => frame.answers)).toEqual([
			{ replacement: { selected: ["NEW"] }, last: selection ? { selected: ["B"] } : { text } },
		]);
	},
);
