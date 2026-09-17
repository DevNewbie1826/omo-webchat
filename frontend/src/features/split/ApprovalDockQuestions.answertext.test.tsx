import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest } from "./QuestionWindow";
import { QuestionWindow } from "./QuestionWindow";
import { renderChatPane, requireElement } from "./chatPaneTestHarness";

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

const TWO_OPTIONS_QUESTIONS: ApprovalRequest = {
	id: "ask-options",
	method: "question",
	title: "Setup choices",
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			multiSelect: true,
			options: [{ label: "Go" }, { label: "TS" }],
		},
		{
			id: "q2",
			header: "Region",
			question: "Which region?",
			options: [{ label: "us-east" }, { label: "eu-west" }],
		},
	],
};

describe("per-question free text under an options question", () => {
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

	function renderWindow(request: ApprovalRequest, onRespond = vi.fn()): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow request={request} open onCollapse={vi.fn()} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});
	}

	const tabs = (): HTMLButtonElement[] =>
		Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
	const option = (label: string): HTMLButtonElement | undefined =>
		Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find((button) => button.textContent === label);
	const click = (el: HTMLElement | undefined): void => {
		act(() => el?.click());
	};
	const type = (input: HTMLInputElement, value: string): void => {
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};

	it("sends text typed under an options question as that question's answer, never as the comment", () => {
		const onRespond = vi.fn();
		renderWindow(TWO_OPTIONS_QUESTIONS, onRespond);

		// The request-level comment keeps its own visible label so it can no
		// longer masquerade as the answer box for the questions above it.
		const commentLabel = document.querySelector(".th-approval-question-comment-label");
		expect(commentLabel?.textContent).toContain("approval.question.commentLabel");

		// Q2 (an options question) owns a dedicated text input directly under
		// its options, and typing there answers Q2 — not the overall comment.
		click(tabs()[1]);
		const own = document.querySelector<HTMLInputElement>(".th-approval-question-text");
		expect(own).not.toBeNull();
		expect(own?.placeholder).toBe("approval.question.answerOptionPlaceholder");
		if (!own) return;
		type(own, "ap-southeast");
		click(option("eu-west"));

		const submit = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.submit");
		click(submit);

		expect(onRespond).toHaveBeenCalledWith({
			answers: { q2: { selected: ["eu-west"], text: "ap-southeast" } },
		});
	});

	it("keeps an options question's typed text through a refresh of the same request", async () => {
		// Given a typed answer on an options question.
		const question = { id: "target", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] };
		const request = {
			type: "approval",
			sessionId: "chat-1",
			id: "refresh-text",
			method: "question",
			nonBlocking: false,
		} as const;
		const { deliver, sent } = renderChatPane(root);
		await act(async () => deliver({ ...request, questions: [question] }));
		act(() => {
			const input = requireElement(
				document.querySelector<HTMLInputElement>(".th-approval-question-text"),
				"per-question text input",
			);
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
				input,
				"mixed",
			);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		// When the same request replays across a presentation hop and back.
		await act(async () => deliver({ ...request, nonBlocking: true, questions: [question] }));
		await act(async () => deliver({ ...request, nonBlocking: false, questions: [question] }));
		// Then the typed text survived the refresh.
		expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe(
			"mixed",
		);
		act(() =>
			requireElement(
				[...document.querySelectorAll("button")].find((b) => b.textContent === "Blue"),
				"Blue",
			).click(),
		);
		act(() =>
			requireElement(
				[...document.querySelectorAll("button")].find((b) => b.textContent === "approval.submit"),
				"approval.submit",
			).click(),
		);
		// And both the selection and the text submit under the question's key.
		expect(sent.filter((frame) => frame.type === "approval.respond").at(-1)?.answers).toEqual({
			target: { selected: ["Blue"], text: "mixed" },
		});
	});
});
