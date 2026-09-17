import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest, ApprovalResponse } from "./QuestionWindow";
import { QuestionWindow } from "./QuestionWindow";

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

const LOWER_INPUT: ApprovalRequest = {
	id: "lower",
	method: "input",
	title: "Lower input approval",
	prefill: "lower draft",
};

const UPPER_QUESTION: ApprovalRequest = {
	id: "upper",
	method: "question",
	title: "Upper question",
	questions: [
		{
			id: "uq1",
			question: "Proceed?",
			options: [{ label: "Yes" }, { label: "No" }],
		},
	],
};

/** R2: closing the TOP request must not aim subsequent typing at the
 *  background chat. When a dialog remains open, the surviving top dialog owns
 *  focus (the modal stack restores it); the composer handoff happens only on
 *  a true exit with no dialog remaining. */
describe("QuestionWindow stacked-dialog focus ownership (R2)", () => {
	let container: HTMLDivElement;
	let root: Root;
	let pane: HTMLElement | null;
	let composer: HTMLTextAreaElement | null;
	let composerFocuses: string[];
	let focusComposer: ReturnType<typeof vi.fn<() => void>>;

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
	// the handoff target ChatPane wires as focusComposer.
	function mountPaneWithComposer(): void {
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
	}

	const wireFocusComposer = (): void => {
		const focus = (): void => {
			pane?.querySelector<HTMLElement>(".th-chat-input textarea")?.focus();
		};
		focusComposer = vi.fn<() => void>(focus);
	};

	function renderStack(extra: {
		readonly onUpperCollapse?: () => void;
		readonly onUpperRespond?: (response: ApprovalResponse) => void;
	} = {}): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={LOWER_INPUT}
						open
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
					<QuestionWindow
						request={UPPER_QUESTION}
						open
						onCollapse={extra.onUpperCollapse ?? vi.fn()}
						onRespond={extra.onUpperRespond ?? vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});
	}

	const renderWithUpperClosed = (): void => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={LOWER_INPUT}
						open
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
					<QuestionWindow
						request={UPPER_QUESTION}
						open={false}
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});
	};

	const renderLowerOnly = (): void => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={LOWER_INPUT}
						open
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});
	};

	const remainingModal = (): HTMLElement => {
		const modals = document.querySelectorAll<HTMLElement>(".th-modal");
		expect(modals).toHaveLength(1);
		return modals[0] as HTMLElement;
	};

	it("collapsing the top request keeps focus inside the surviving dialog (no composer handoff)", () => {
		mountPaneWithComposer();
		wireFocusComposer();
		// ChatPane folds the top window back to its notice band on Escape; the
		// window stays mounted, the lower dialog remains open.
		renderStack({ onUpperCollapse: renderWithUpperClosed });

		expect(document.querySelectorAll(".th-modal")).toHaveLength(2);
		const topPanel = document.querySelector<HTMLElement>(".th-modal-overlay:not([inert]) .th-modal");
		expect(topPanel?.contains(document.activeElement)).toBe(true);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});

		// The exact reviewer repro: one dialog remains, yet typing must NOT
		// reach the background composer. The surviving dialog owns focus — the
		// stack restored it to the lower window's primary (its input) — and no
		// handoff to the composer happened at any point.
		expect(focusComposer).not.toHaveBeenCalled();
		expect(composerFocuses).toEqual([]);
		const survivor = remainingModal();
		expect(survivor.contains(document.activeElement)).toBe(true);
		const lowerInput = survivor.querySelector<HTMLInputElement>("[data-approval-primary]");
		expect(document.activeElement).toBe(lowerInput);
		expect(lowerInput?.value).toBe("lower draft");
	});

	it("answering the top request with another dialog open does not hand focus to the composer", () => {
		mountPaneWithComposer();
		wireFocusComposer();
		// The answered request exits: ChatPane unmounts its surface entirely
		// while the lower dialog remains.
		renderStack({ onUpperRespond: renderLowerOnly });

		const submit = document.querySelector<HTMLButtonElement>(".th-approval-question-actions button");
		expect(submit?.textContent).toBe("approval.submit");
		act(() => submit?.click());

		// An explicit exit, but a dialog REMAINS: the surviving lower window
		// owns focus; the composer handoff is only for the no-dialog-left exit.
		expect(focusComposer).not.toHaveBeenCalled();
		expect(composerFocuses).toEqual([]);
		const survivor = remainingModal();
		expect(survivor.contains(document.activeElement)).toBe(true);
	});

	it("a same-id reclassification (input -> question) is not an exit and hands focus nowhere", async () => {
		mountPaneWithComposer();
		wireFocusComposer();
		const reclassified: ApprovalRequest = {
			id: "reclass",
			method: "input",
			title: "Reclass input",
			prefill: "typed value",
		};
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						key="approval-surface"
						request={reclassified}
						open
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});
		const input = document.querySelector<HTMLInputElement>(".th-approval-input");
		expect(input).not.toBeNull();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// The pendingApproval -> pendingQuestion reclassification of the same
		// request id: the approval surface unmounts and the question surface
		// mounts in one commit (separate instances, like ChatPane's two
		// surfaces). This is NOT an exit: no handoff to the composer may
		// happen, and focus ends inside the re-presented dialog.
		await act(async () => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						key="question-surface"
						request={{ ...reclassified, method: "question", questions: UPPER_QUESTION.questions ?? [] }}
						open
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});

		expect(focusComposer).not.toHaveBeenCalled();
		expect(composerFocuses).toEqual([]);
		const dialog = document.querySelector<HTMLElement>(".th-modal");
		expect(dialog).not.toBeNull();
		expect(dialog?.contains(document.activeElement)).toBe(true);
	});

	it("collapsing the LAST remaining dialog still hands focus to the composer (C3 exit)", () => {
		mountPaneWithComposer();
		wireFocusComposer();
		renderStack();
		// ChatPane folds the top window first: a dialog remains, no handoff.
		renderWithUpperClosed();
		expect(focusComposer).not.toHaveBeenCalled();

		// Then the last window folds too (both surfaces stay mounted, as in
		// production): no dialog remains, so the exit hands focus to the pane's
		// composer — the C3 handoff contract, unchanged by the surviving-dialog
		// rule.
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={LOWER_INPUT}
						open={false}
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
					<QuestionWindow
						request={UPPER_QUESTION}
						open={false}
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});
		expect(focusComposer).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(composer);
	});
});
