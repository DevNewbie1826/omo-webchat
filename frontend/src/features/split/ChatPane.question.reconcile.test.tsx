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
const clickTab = (label: string) => act(() => requireElement(
	[...document.querySelectorAll<HTMLButtonElement>('.th-modal .th-approval-question-tabs [role="tab"]')]
		.find(button => button.textContent === label), `tab ${label}`,
).click());
// A non-blocking arrival leaves the window to the band's Open button.
const ensureWindowOpen = () => {
	if (document.querySelector(".th-modal .th-approval-question") !== null) return;
	click("approval.band.open");
};
const first = { id: "old-first", options: [{ label: "A" }] };
const last = { id: "last", header: "Last", options: [{ label: "Z" }] };
const request = { type: "approval", sessionId: "chat-1", id: "refresh", method: "question", nonBlocking: true } as const;

it("makes an earlier replacement reachable when the same request refreshes", async () => {
	// Given the first question was answered and the last question is active.
	const { deliver, sent } = renderChatPane(root);
	await act(async () => deliver({ ...request, questions: [first, last] }));
	ensureWindowOpen();
	click("A");
	// When an earlier question is replaced on the same request.
	act(() => deliver({ ...request, questions: [{ id: "new-first", options: [{ label: "B" }] }, last] }));
	// Then the replacement is reachable before any response can leave: its tab
	// shows the new options while the answered last draft is preserved.
	expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
	clickTab("approval.question.tab");
	expect([...document.querySelectorAll(".th-approval-question-option")].map(button => button.textContent)).toEqual(["B"]);
	click("B");
	clickTab("approval.question.tab");
	clickTab("Last");
	click("Z");
	click("approval.submit");
	expect(sent.filter(frame => frame.type === "approval.respond").map(frame => frame.answers)).toEqual([
		{ "new-first": { selected: ["B"] }, last: { selected: ["Z"] } },
	]);
});

it.each([false, true])("settles once with both answers when unchanged refresh is %s", async refresh => {
	// Given an ordinary two-question request answered in the window.
	const { deliver, sent } = renderChatPane(root);
	await act(async () => deliver({ ...request, questions: [first, last] }));
	ensureWindowOpen();
	// When the first answer is selected, with or without a same-content refresh.
	click("A");
	if (refresh) act(() => deliver({ ...request, questions: [{ ...first }, { ...last }] }));
	// Then no partial response leaves before the window's Submit, and the
	// selected draft survives the refresh.
	expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
	clickTab("Last");
	click("Z");
	click("approval.submit");
	expect(sent.filter(frame => frame.type === "approval.respond").map(frame => frame.answers)).toEqual([
		{ "old-first": { selected: ["A"] }, last: { selected: ["Z"] } },
	]);
});
