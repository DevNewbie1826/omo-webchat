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

const TWO_QUESTIONS: ApprovalRequest = {
	id: "ask-1",
	method: "question",
	title: "Setup choices",
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			multiSelect: true,
			options: [
				{ label: "Go", description: "Backend services" },
				{ label: "TS", description: "Frontend app" },
				{ label: "Python", description: "Tooling scripts" },
			],
		},
		{
			id: "q2",
			header: "Region",
			question: "Which region?",
			multiSelect: false,
			options: [
				{ label: "us-east", description: "N. Virginia" },
				{ label: "eu-west", description: "Ireland" },
			],
		},
	],
};

describe("ApprovalDock structured question panel", () => {
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
	const optionButtons = (): HTMLButtonElement[] =>
		Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		);
	const click = (el: HTMLElement | undefined): void => {
		act(() => el?.click());
	};
	const submit = (): void => {
		const button = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((candidate) => candidate.textContent === "approval.submit");
		click(button);
	};

	it("renders one panel with a tab per question", () => {
		renderDock(TWO_QUESTIONS);

		expect(container.querySelectorAll(".th-approval-dock")).toHaveLength(1);
		expect(tabs().map((tab) => tab.textContent)).toEqual(["Stack", "Region"]);
		expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
		expect(tabs()[1]?.getAttribute("aria-selected")).toBe("false");
	});

	it("shows option descriptions for the active question", () => {
		renderDock(TWO_QUESTIONS);

		const descriptions = Array.from(
			container.querySelectorAll(".th-approval-question-option-description"),
		).map((el) => el.textContent);
		expect(descriptions).toEqual(["Backend services", "Frontend app", "Tooling scripts"]);
	});

	it("keeps several choices selected in a multiSelect question", () => {
		renderDock(TWO_QUESTIONS);

		click(optionButtons()[0]);
		click(optionButtons()[1]);

		const pressed = optionButtons().map((button) => button.getAttribute("aria-pressed"));
		expect(pressed).toEqual(["true", "true", "false"]);

		// Toggling the first off keeps the second selected.
		click(optionButtons()[0]);
		expect(optionButtons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
			"false",
			"true",
			"false",
		]);
	});

	it("replaces the selection in a single-select question", () => {
		renderDock(TWO_QUESTIONS);
		click(tabs()[1]);

		click(optionButtons()[0]);
		click(optionButtons()[1]);

		expect(optionButtons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
			"false",
			"true",
		]);
	});

	it("keeps selections made in other tabs when switching tabs", () => {
		const onRespond = vi.fn();
		renderDock(TWO_QUESTIONS, onRespond);

		click(optionButtons()[0]);
		click(optionButtons()[2]);
		click(tabs()[1]);
		click(optionButtons()[1]);
		click(tabs()[0]);

		expect(optionButtons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
			"true",
			"false",
			"true",
		]);

		// Submit lives on the last question; step there to send.
		click(tabs()[1]);
		submit();
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({
			answers: {
				q1: { selected: ["Go", "Python"] },
				q2: { selected: ["eu-west"] },
			},
		});
	});

	it("sends a free-text answer for a question without options", () => {
		const onRespond = vi.fn();
		renderDock(
			{
				id: "ask-2",
				method: "question",
				questions: [{ id: "q1", header: "Notes", question: "Anything else?" }],
			},
			onRespond,
		);

		const input = container.querySelector<HTMLInputElement>(".th-approval-question-text");
		expect(input).not.toBeNull();
		act(() => {
			if (!input) return;
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "custom note");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		submit();
		expect(onRespond).toHaveBeenCalledWith({
			answers: { q1: { text: "custom note" } },
		});
	});

	it("includes the overall comment when filled", () => {
		const onRespond = vi.fn();
		renderDock(TWO_QUESTIONS, onRespond);

		click(optionButtons()[1]);
		const comment = container.querySelector<HTMLInputElement>(".th-approval-question-comment");
		expect(comment).not.toBeNull();
		act(() => {
			if (!comment) return;
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(comment, "ship it");
			comment.dispatchEvent(new Event("input", { bubbles: true }));
		});

		// Submit lives on the last question; step there to send.
		click(tabs()[1]);
		submit();
		expect(onRespond).toHaveBeenCalledWith({
			answers: { q1: { selected: ["TS"] } },
			comment: "ship it",
		});
	});

	it("omits unanswered questions and an empty comment from the payload", () => {
		const onRespond = vi.fn();
		renderDock(TWO_QUESTIONS, onRespond);

		// Submit lives on the last question; step there to send.
		click(tabs()[1]);
		submit();
		expect(onRespond).toHaveBeenCalledWith({ answers: {} });
	});

	it("cancels the whole request with one cancel action", () => {
		const onRespond = vi.fn();
		renderDock(TWO_QUESTIONS, onRespond);

		const cancel = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((candidate) => candidate.textContent === "approval.cancel");
		click(cancel);

		expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
	});
});
