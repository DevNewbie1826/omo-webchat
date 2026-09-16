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

const QUESTIONS: ApprovalRequest = {
	id: "ask-focus",
	method: "question",
	title: "Keyboard keep",
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			multiSelect: true,
			options: [{ label: "Go", description: "compiles ahead" }, { label: "TS" }],
		},
		{
			id: "q2",
			header: "Region",
			question: "Which region?",
			options: [{ label: "us-east" }, { label: "eu-west" }],
		},
	],
};

/** Emulates the browser's pointer default actions on a button tap: an
 *  unprevented pointerdown moves focus to the button (and the compatible
 *  mousedown would focus it again), while a prevented pointerdown suppresses
 *  those defaults — but the click activation itself always fires. Mirrors
 *  iOS Safari and Chrome: tapping a non-input blurs the open input and drops
 *  the software keyboard unless the pointerdown default is canceled. */
function tap(button: HTMLElement): void {
	const pointerdown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
	button.dispatchEvent(pointerdown);
	if (!pointerdown.defaultPrevented) {
		button.focus();
		const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		button.dispatchEvent(mousedown);
		if (!mousedown.defaultPrevented) button.focus();
	}
	button.click();
}

describe("ApprovalQuestionPanel focus-keeping option taps", () => {
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

	const option = (label: string): HTMLButtonElement | undefined =>
		Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find(
			(button) =>
				button.querySelector(".th-approval-question-option-label")?.textContent === label,
		);
	const tab = (label: string): HTMLButtonElement | undefined =>
		Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
			(button) => button.textContent === label,
		);
	const answerInput = (): HTMLInputElement | null =>
		container.querySelector<HTMLInputElement>(".th-approval-question-text");

	it("keeps the answer input focused while selecting an option from it", () => {
		renderDock(QUESTIONS);

		const input = answerInput();
		expect(input).not.toBeNull();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// The user's exact report: typing an answer, then tapping an option.
		// The tap must not move focus off the input (which would drop the
		// software keyboard), yet the option must still toggle on.
		const go = option("Go");
		expect(go).toBeDefined();
		act(() => tap(go as HTMLButtonElement));

		expect(document.activeElement).toBe(input);
		expect(go?.getAttribute("aria-pressed")).toBe("true");
	});

	it("toggles a multi-select option back off without moving focus either", () => {
		renderDock(QUESTIONS);

		const input = answerInput();
		act(() => input?.focus());
		const go = option("Go") as HTMLButtonElement;
		act(() => tap(go));
		act(() => tap(go));

		expect(document.activeElement).toBe(input);
		expect(go.getAttribute("aria-pressed")).toBe("false");
	});

	it("cancels the pointerdown default so the browser never blurs the input", () => {
		renderDock(QUESTIONS);

		const pointerdown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		(option("TS") as HTMLButtonElement).dispatchEvent(pointerdown);
		expect(pointerdown.defaultPrevented).toBe(true);
	});

	it("keeps focus-follows-tap for tab switches and the action row (context changes)", () => {
		renderDock(QUESTIONS);

		// Tabs switch the tabpanel (the input being typed in unmounts), and
		// the action row ends or advances the request: both are explicit
		// context changes, so they keep the browser's default focus
		// behavior — only option toggles must not steal the keyboard.
		const tabPointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		(tab("Region") as HTMLButtonElement).dispatchEvent(tabPointer);
		expect(tabPointer.defaultPrevented).toBe(false);

		const next = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.question.next");
		expect(next).toBeDefined();
		const nextPointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		(next as HTMLButtonElement).dispatchEvent(nextPointer);
		expect(nextPointer.defaultPrevented).toBe(false);
	});
});
