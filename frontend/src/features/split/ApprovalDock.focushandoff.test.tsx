import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest } from "./ApprovalDock";
import { ApprovalDock } from "./ApprovalDock";

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key, vars) =>
		vars === undefined
			? key
			: `${key} ${Object.entries(vars)
					.map(([name, value]) => `${name}=${String(value)}`)
					.join(" ")}`,
};

const QUESTION: ApprovalRequest = {
	id: "ask-handoff",
	method: "question",
	title: "Handoff",
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			options: [{ label: "Go" }, { label: "TS" }],
		},
		{
			id: "q2",
			header: "Region",
			question: "Which region?",
			options: [{ label: "us-east" }],
		},
	],
};

describe("ApprovalDock focus handoff exits", () => {
	let container: HTMLDivElement;
	let root: Root;
	let pane: HTMLElement | null;
	let composer: HTMLTextAreaElement | null;
	let composerFocuses: string[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		composerFocuses = [];
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		pane?.remove();
		pane = null;
		composer = null;
		container.remove();
		vi.unstubAllGlobals();
	});

	// Production layout: the composer textarea lives inside .th-chat-input,
	// a sibling band after the dock inside .th-chat-pane (the pattern from
	// ApprovalDock.test.tsx's mountPaneWithComposer).
	function mountPaneWithComposer(): HTMLTextAreaElement {
		pane = document.createElement("div");
		pane.className = "th-chat-pane";
		pane.appendChild(container);
		const composerWrap = document.createElement("div");
		composerWrap.className = "th-chat-input";
		composer = document.createElement("textarea");
		composerWrap.appendChild(composer);
		pane.appendChild(composerWrap);
		document.body.appendChild(pane);
		composer.addEventListener("focus", () => composerFocuses.push("focus"));
		return composer;
	}

	function renderDock(request: ApprovalRequest, onRespond = vi.fn(), key = "a"): void {
		act(() => {
			root.render(
				<I18nContext.Provider key={key} value={i18n}>
					<ApprovalDock request={request} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});
	}

	const answerInput = (): HTMLInputElement | null =>
		container.querySelector<HTMLInputElement>(".th-approval-question-text");

	// Submit only renders on the last question (the stepper contract), so a
	// submit-driven exit must first step to the final tab.
	function lastQuestionSubmit(): HTMLButtonElement | undefined {
		const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
		act(() => tabs.at(-1)?.click());
		return Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.submit");
	}

	it("does not hand focus to the composer when the same request merely remounts", async () => {
		mountPaneWithComposer();
		const onRespond = vi.fn();

		// Same request id, focused answer input — the user is mid-answer.
		renderDock(QUESTION, onRespond, "first");
		const input = answerInput();
		expect(input).not.toBeNull();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// A remount without an exit: the same request id is re-presented in
		// one commit (a re-keyed wrapper re-renders the pane). This is NOT an
		// exit — answered/cancelled/collapsed never happened — so the dock
		// must never hand focus to the composer; focus stays inside the dock.
		await act(async () => {
			root.render(
				<I18nContext.Provider key="second" value={i18n}>
					<ApprovalDock request={QUESTION} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});

		expect(composerFocuses).toEqual([]);
		expect(document.activeElement?.closest(".th-approval-dock")).not.toBeNull();
	});

	it("still hands focus to the composer synchronously when the request is answered", async () => {
		mountPaneWithComposer();
		const onRespond = vi.fn();
		renderDock(QUESTION, onRespond);

		const submit = await lastQuestionSubmit();
		expect(submit).toBeDefined();

		// Answering ends the request: the app clears it and the dock
		// unmounts. The composer handoff must be immediate (synchronous with
		// the unmount) so the keyboard never falls to document.body.
		act(() => submit?.click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		await act(async () => {
			root.unmount();
		});
		expect(composerFocuses).toEqual(["focus"]);
		expect(document.activeElement).toBe(composer);
	});

	it("hands focus to the composer after an external resolution (no local respond)", async () => {
		mountPaneWithComposer();
		renderDock(QUESTION);

		const input = answerInput();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// Another client answered: the request disappears without any local
		// respond. Focus still must not die on document.body — the pane's
		// composer takes it.
		await act(async () => {
			root.unmount();
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.activeElement).toBe(composer);
	});
});
