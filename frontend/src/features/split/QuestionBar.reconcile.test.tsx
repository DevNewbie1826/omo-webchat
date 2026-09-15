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
	[...container.querySelectorAll<HTMLButtonElement>(".th-question-bar button")].find(button => button.textContent === label), label,
).click());
const first = { id: "old-first", options: [{ label: "A" }] };
const last = { id: "last", options: [{ label: "Z" }] };
const request = { type: "approval", sessionId: "chat-1", id: "refresh", method: "question", nonBlocking: true } as const;

it("makes an earlier replacement reachable when the same inline request refreshes", async () => {
	// Given the first question was answered and the last question is active.
	const { deliver, sent } = renderChatPane(root);
	await act(async () => deliver({ ...request, questions: [first, last] }));
	click("A");
	// When an earlier question is replaced on the same request.
	act(() => deliver({ ...request, questions: [{ id: "new-first", options: [{ label: "B" }] }, last] }));
	// Then the replacement is reachable before any response can leave.
	expect([...container.querySelectorAll(".th-question-bar button")].map(button => button.textContent)).toEqual(["B"]);
	expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
	click("B");
	expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
	click("Z");
	expect(sent.filter(frame => frame.type === "approval.respond").map(frame => frame.answers)).toEqual([
		{ "new-first": { selected: ["B"] }, last: { selected: ["Z"] } },
	]);
});

it.each([false, true])("settles only after both questions when unchanged refresh is %s", async refresh => {
	// Given an ordinary two-question inline request.
	const { deliver, sent } = renderChatPane(root);
	await act(async () => deliver({ ...request, questions: [first, last] }));
	// When the first answer is selected, with or without a same-content refresh.
	click("A");
	if (refresh) act(() => deliver({ ...request, questions: [{ ...first }, { ...last }] }));
	// Then progress remains at the last question and no partial response leaves.
	expect([...container.querySelectorAll(".th-question-bar button")].map(button => button.textContent)).toEqual(["Z"]);
	expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
	click("Z");
	expect(sent.filter(frame => frame.type === "approval.respond").map(frame => frame.answers)).toEqual([
		{ "old-first": { selected: ["A"] }, last: { selected: ["Z"] } },
	]);
});
