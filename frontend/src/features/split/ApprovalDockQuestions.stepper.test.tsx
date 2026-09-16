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

const FOUR_QUESTIONS: ApprovalRequest = {
	id: "ask-4",
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
		{
			id: "q3",
			header: "Scale",
			question: "What scale?",
			multiSelect: true,
			options: [{ label: "Small" }, { label: "Large" }],
		},
		{
			id: "q4",
			header: "Owner",
			question: "Who owns it?",
			options: [{ label: "Platform" }, { label: "App" }],
		},
	],
};

describe("ApprovalQuestionPanel question stepper", () => {
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

	function renderDock(request: ApprovalRequest, onRespond = vi.fn()): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ApprovalDock request={request} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});
	}

	const tabs = (): HTMLButtonElement[] =>
		Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
	const actionButtons = (): HTMLButtonElement[] =>
		Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		);
	const action = (label: string): HTMLButtonElement | undefined =>
		actionButtons().find((button) => button.textContent === label);
	const option = (label: string): HTMLButtonElement | undefined =>
		Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find((button) => button.textContent === label);
	const click = (el: HTMLElement | undefined): void => {
		act(() => el?.click());
	};

	it("offers Next instead of Submit until the last question, keeping tabs freely navigable", () => {
		renderDock(FOUR_QUESTIONS);

		// Q1: the only forward action is Next; Submit must not end the request early.
		expect(action("approval.question.next")).toBeDefined();
		expect(action("approval.submit")).toBeUndefined();
		expect(action("approval.cancel")).toBeDefined();

		// Next advances the active tabpanel from Q1 to Q2.
		click(action("approval.question.next"));
		expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual([
			"false",
			"true",
			"false",
			"false",
		]);

		// The last question swaps Next for Submit.
		click(tabs()[3]);
		expect(action("approval.submit")).toBeDefined();
		expect(action("approval.question.next")).toBeUndefined();

		// Tabs keep free navigation: going back to Q1 restores the stepper.
		click(tabs()[0]);
		expect(action("approval.question.next")).toBeDefined();
		click(action("approval.question.next"));
		expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("shows the unanswered count near the actions and lowers it as questions are answered", () => {
		renderDock(FOUR_QUESTIONS);

		const count = (): string | null | undefined =>
			container.querySelector(".th-approval-question-unanswered")?.textContent;
		expect(count()).toBe("approval.question.unanswered count=4");

		// Answering the active question with an option lowers the count.
		click(option("Go"));
		expect(count()).toBe("approval.question.unanswered count=3");

		// Stepping to the next question and answering it lowers it again.
		click(action("approval.question.next"));
		click(option("us-east"));
		expect(count()).toBe("approval.question.unanswered count=2");
	});
});
