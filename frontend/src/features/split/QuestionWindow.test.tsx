import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest, ApprovalResponse } from "./QuestionWindow";
import { QuestionWindow } from "./QuestionWindow";
import { QuestionNoticeBand } from "./QuestionNoticeBand";

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

/** The window portals to document.body; every query runs against the
 *  document, like the ModalDialog tests. */
describe("QuestionWindow separate modal window", () => {
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
		vi.useRealTimers();
	});

	function renderWindow(
		request: ApprovalRequest,
		onRespond = vi.fn(),
		extra: { readonly open?: boolean; readonly onCollapse?: () => void; readonly focusComposer?: () => void } = {},
	): { onRespond: ReturnType<typeof vi.fn>; onCollapse: ReturnType<typeof vi.fn> } {
		const onCollapse = vi.fn(extra.onCollapse);
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={request}
						open={extra.open ?? true}
						onCollapse={onCollapse}
						onRespond={onRespond}
						{...(extra.focusComposer ? { focusComposer: extra.focusComposer } : {})}
					/>
				</I18nContext.Provider>,
			);
		});
		return { onRespond, onCollapse };
	}

	const panel = (): HTMLElement | null => document.querySelector(".th-modal");
	const countdownText = (): string =>
		document.querySelector(".th-question-window-countdown")?.textContent ?? "";

	it("renders as a separate modal window: portal, overlay, dialog role", () => {
		renderWindow({ id: "confirm-1", method: "confirm" });

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.className).toContain("th-modal");
		expect(document.querySelector(".th-modal-overlay")).not.toBeNull();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.body.style.overflow).toBe("hidden");
	});

	it("renders nothing when closed (the notice band carries the request)", () => {
		renderWindow({ id: "confirm-1", method: "confirm" }, vi.fn(), { open: false });

		expect(panel()).toBeNull();
		expect(document.querySelector(".th-modal-overlay")).toBeNull();
		expect(document.body.style.overflow).not.toBe("hidden");
	});

	it("renders one button per select option and answers with the chosen value", () => {
		const { onRespond } = renderWindow({ id: "select-1", method: "select", options: ["Allow", "Block"] });

		const options = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		);
		expect(options.map((button) => button.textContent)).toEqual([
			"Allow",
			"Block",
			"approval.cancel",
		]);

		act(() => options[1]?.click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({ value: "Block" });
	});

	it("answers confirm with confirmed true/false", () => {
		const { onRespond } = renderWindow({ id: "confirm-1", method: "confirm" });

		const buttons = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		);
		expect(buttons.map((button) => button.textContent)).toEqual([
			"approval.confirm",
			"approval.deny",
			"approval.cancel",
		]);

		act(() => buttons[0]?.click());
		expect(onRespond).toHaveBeenLastCalledWith({ confirmed: true });
		act(() => buttons[1]?.click());
		expect(onRespond).toHaveBeenLastCalledWith({ confirmed: false });
	});

	it("offers an explicit cancel on confirm requests, distinct from deny", () => {
		const { onRespond } = renderWindow({ id: "confirm-1", method: "confirm" });

		const cancel = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		).find((button) => button.textContent === "approval.cancel");
		expect(cancel).not.toBeUndefined();
		expect(cancel?.className).toContain("th-btn--ghost");

		act(() => cancel?.click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
	});

	it.each(["input", "editor"] as const)("submits the %s text value", (method) => {
		const { onRespond } = renderWindow({ id: `${method}-1`, method, prefill: "draft" });

		const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
			method === "editor" ? "textarea" : "input",
		);
		expect(field?.value).toBe("draft");
		act(() => {
			field
				?.closest("form")
				?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(onRespond).toHaveBeenCalledWith({ value: "draft" });
	});

	it("fires cancelled only from the explicit cancel button", () => {
		const { onRespond } = renderWindow({ id: "select-1", method: "select", options: ["Allow"] });

		const cancel = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		).find((button) => button.textContent === "approval.cancel");
		act(() => cancel?.click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
	});

	it("collapses on Escape without responding (the window's fold-to-band exit)", () => {
		const { onRespond, onCollapse } = renderWindow(
			{ id: "select-1", method: "select", title: "Run tests?", options: ["Allow"] },
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});

		expect(onRespond).not.toHaveBeenCalled();
		expect(onCollapse).toHaveBeenCalledTimes(1);
	});

	it("collapses on a close (X) click without responding", () => {
		const { onRespond, onCollapse } = renderWindow({ id: "confirm-1", method: "confirm" });

		act(() => {
			document.querySelector<HTMLButtonElement>(".th-modal-close")?.click();
		});

		expect(onRespond).not.toHaveBeenCalled();
		expect(onCollapse).toHaveBeenCalledTimes(1);
	});

	it("moves focus to the primary control on arrival", () => {
		renderWindow({ id: "confirm-1", method: "confirm" });

		const primary = document.querySelector("[data-approval-primary]");
		expect(primary).not.toBeNull();
		expect(document.activeElement).toBe(primary);
		expect(primary?.closest(".th-modal")).not.toBeNull();
	});

	it("wraps Tab inside the dialog (the modal stack owns focus, unlike the retired inline dock)", () => {
		renderWindow({ id: "confirm-1", method: "confirm" });

		const focusables = Array.from(
			document.querySelectorAll<HTMLElement>(".th-modal button"),
		);
		const last = focusables.at(-1);
		expect(last).toBeDefined();
		last?.focus();

		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		act(() => {
			last?.dispatchEvent(event);
		});

		// A modal dialog traps Tab: the default is prevented and focus wraps
		// back to the first control — the window's contract, replacing the
		// inline dock's free-Tab region semantics.
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(focusables[0]);
	});

	it("resets the draft to the new request's prefill when the request id changes", () => {
		renderWindow({ id: "input-1", method: "input", prefill: "first" });

		const field = (): HTMLInputElement | null => document.querySelector("input");
		expect(field()?.value).toBe("first");
		act(() => {
			const input = field();
			if (input) {
				input.value = "typed over";
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		expect(field()?.value).toBe("typed over");

		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={{ id: "input-2", method: "input", prefill: "second" }}
						open
						onCollapse={vi.fn()}
						onRespond={vi.fn()}
					/>
				</I18nContext.Provider>,
			);
		});
		expect(field()?.value).toBe("second");
	});

	it("keeps aria-labelledby resolving to the window title", () => {
		renderWindow({ id: "select-1", method: "select", title: "Run tests?", options: ["Allow"] });

		const dialog = panel();
		const labelledBy = dialog?.getAttribute("aria-labelledby");
		expect(labelledBy).toBeTruthy();
		const title = document.getElementById(labelledBy ?? "");
		expect(title).not.toBeNull();
		expect(title?.className).toBe("th-question-window-title");
	});

	it("renders no countdown without deadline fields and still answers", () => {
		const { onRespond } = renderWindow({ id: "confirm-1", method: "confirm" });

		expect(document.querySelector(".th-question-window-countdown")).toBeNull();
		const allow = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		).find((button) => button.textContent === "approval.confirm");
		act(() => allow?.click());
		expect(onRespond).toHaveBeenCalledWith({ confirmed: true });
	});

	it("ticks a deadlineAtMs countdown down once a second through one parameterized key", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderWindow({
			id: "confirm-1",
			method: "confirm",
			deadlineAtMs: 1_000_000 + 5_000,
		});

		// The whole label comes from approval.remaining with a seconds param —
		// no bare "s" unit literal bypassing i18n.
		expect(countdownText()).toBe("approval.remaining seconds=5");

		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=4");

		act(() => {
			vi.advanceTimersByTime(2_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=2");
	});

	it("counts down from remainingMs when no deadline is given", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderWindow({ id: "confirm-1", method: "confirm", remainingMs: 3_000 });

		expect(countdownText()).toBe("approval.remaining seconds=3");

		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=2");
	});

	it("re-anchors the clock when a long-pending request is replaced by one with an absolute deadline", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		// Request A has no deadline: no interval ever runs, so a mount-time
		// clock would go stale while A stays pending.
		renderWindow({ id: "confirm-a", method: "confirm" });
		expect(document.querySelector(".th-question-window-countdown")).toBeNull();

		act(() => {
			vi.advanceTimersByTime(600_000); // A pending for ten minutes
		});
		rerender({ id: "confirm-b", method: "confirm", deadlineAtMs: 1_000_000 + 600_000 + 15_000 });

		// B's own 15 seconds must show IMMEDIATELY — not A's stale clock
		// (615s) corrected by the first tick.
		expect(countdownText()).toBe("approval.remaining seconds=15");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=14");
	});

	it("re-anchors the clock when a long-pending request is replaced by one with remainingMs", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderWindow({ id: "confirm-a", method: "confirm" });
		act(() => {
			vi.advanceTimersByTime(600_000);
		});
		rerender({ id: "confirm-b", method: "confirm", remainingMs: 15_000 });

		expect(countdownText()).toBe("approval.remaining seconds=15");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=14");
	});

	it("re-anchors a remainingMs refresh of the same request to the moment it arrives", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderWindow({ id: "confirm-1", method: "confirm", remainingMs: 30_000 });

		expect(countdownText()).toBe("approval.remaining seconds=30");
		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=27");

		// A refresh of the SAME request carrying only remainingMs: the value is
		// relative to the moment THIS update arrived, so the panel must read the
		// new value — not the new value minus what the first one already burned.
		rerender({ id: "confirm-1", method: "confirm", remainingMs: 45_000 });
		expect(countdownText()).toBe("approval.remaining seconds=45");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=44");
	});

	it("restarts the countdown when a refresh re-sends the same remainingMs value", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderWindow({ id: "confirm-1", method: "confirm", remainingMs: 30_000 });

		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=27");

		// Same value, delivered again: the grace period restarts from 30s rather
		// than continuing the first delivery's descent.
		rerender({ id: "confirm-1", method: "confirm", remainingMs: 30_000 });
		expect(countdownText()).toBe("approval.remaining seconds=30");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=29");
	});

	it("keeps counting down while the caller rebuilds an equal request wrapper each render", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		// The structured-question window is assembled from the pending frame on
		// every render of the pane, so it sees a NEW wrapper object around the
		// SAME delivered questions whenever anything else in the pane changes
		// (a streamed transcript row, a status frame). Those rebuilds are
		// renders, not deliveries: the countdown must keep descending.
		const questions = [
			{ id: "q1", question: "Which stack?", options: [{ label: "Go" }, { label: "TS" }] },
		];
		renderWindow({ id: "ask-1", method: "question", questions, remainingMs: 30_000 });

		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=27");

		rerender({ id: "ask-1", method: "question", questions, remainingMs: 30_000 });
		expect(countdownText()).toBe("approval.remaining seconds=27");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=26");
	});

	it("restarts a structured question countdown when the request is delivered again", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const question = { id: "q1", question: "Which stack?", options: [{ label: "Go" }] };
		renderWindow({ id: "ask-1", method: "question", questions: [question], remainingMs: 30_000 });

		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=27");

		// A redelivery parses its own questions: a new delivery, so a new anchor.
		rerender({ id: "ask-1", method: "question", questions: [{ ...question }], remainingMs: 30_000 });
		expect(countdownText()).toBe("approval.remaining seconds=30");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=29");
	});

	it("keeps a deadlineAtMs refresh of the same request absolute", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderWindow({ id: "confirm-1", method: "confirm", deadlineAtMs: 1_000_000 + 30_000 });

		act(() => {
			vi.advanceTimersByTime(3_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=27");

		// An absolute deadline is measured against the wall clock, never against
		// the moment the refresh arrived: 60s after 1_000_000, read at 1_003_000.
		rerender({ id: "confirm-1", method: "confirm", deadlineAtMs: 1_000_000 + 60_000 });
		expect(countdownText()).toBe("approval.remaining seconds=57");
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdownText()).toBe("approval.remaining seconds=56");
	});

	it("keeps the input text through a collapse and reopen (the window stays mounted)", () => {
		const request: ApprovalRequest = { id: "input-1", method: "input", prefill: "draft" };
		renderWindow(request);

		const field = (): HTMLInputElement | null => document.querySelector("input");
		act(() => {
			const input = field();
			if (input) {
				// Drive the prototype setter so React's controlled-input tracker
				// sees the change and onChange fires.
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
					input,
					"typed over",
				);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});

		// Fold to the band and reopen from it: the draft must not reset.
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow request={request} open={false} onCollapse={vi.fn()} onRespond={vi.fn()} />
				</I18nContext.Provider>,
			);
		});
		expect(panel()).toBeNull();
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow request={request} open onCollapse={vi.fn()} onRespond={vi.fn()} />
				</I18nContext.Provider>,
			);
		});
		expect(field()?.value).toBe("typed over");
	});

	function rerender(request: ApprovalRequest, onRespond = vi.fn()): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow request={request} open onCollapse={vi.fn()} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});
	}

	describe("structured question panel inside the window", () => {
		const tabs = (): HTMLButtonElement[] =>
			Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
		const optionButtons = (): HTMLButtonElement[] =>
			Array.from(document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"));
		const click = (el: HTMLElement | undefined): void => {
			act(() => el?.click());
		};
		const submit = (): void => {
			const button = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
			).find((candidate) => candidate.textContent === "approval.submit");
			click(button);
		};

		it("renders one panel with a tab per question", () => {
			renderWindow(TWO_QUESTIONS);

			expect(document.querySelectorAll(".th-modal")).toHaveLength(1);
			expect(tabs().map((tab) => tab.textContent)).toEqual(["Stack", "Region"]);
			expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
			expect(tabs()[1]?.getAttribute("aria-selected")).toBe("false");
		});

		it("shows option descriptions for the active question", () => {
			renderWindow(TWO_QUESTIONS);

			const descriptions = Array.from(
				document.querySelectorAll(".th-approval-question-option-description"),
			).map((el) => el.textContent);
			expect(descriptions).toEqual(["Backend services", "Frontend app", "Tooling scripts"]);
		});

		it("keeps several choices selected in a multiSelect question", () => {
			renderWindow(TWO_QUESTIONS);

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
			renderWindow(TWO_QUESTIONS);
			click(tabs()[1]);

			click(optionButtons()[0]);
			click(optionButtons()[1]);

			expect(optionButtons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
				"false",
				"true",
			]);
		});

		it("keeps selections made in other tabs when switching tabs", () => {
			const { onRespond } = renderWindow(TWO_QUESTIONS);

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
			const { onRespond } = renderWindow({
				id: "ask-2",
				method: "question",
				questions: [{ id: "q1", header: "Notes", question: "Anything else?" }],
			});

			const input = document.querySelector<HTMLInputElement>(".th-approval-question-text");
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
			const { onRespond } = renderWindow(TWO_QUESTIONS);

			click(optionButtons()[1]);
			const comment = document.querySelector<HTMLInputElement>(".th-approval-question-comment");
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
			const { onRespond } = renderWindow(TWO_QUESTIONS);

			// Submit lives on the last question; step there to send.
			click(tabs()[1]);
			submit();
			expect(onRespond).toHaveBeenCalledWith({ answers: {} });
		});

		it("cancels the whole request with one cancel action", () => {
			const { onRespond } = renderWindow(TWO_QUESTIONS);

			const cancel = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
			).find((candidate) => candidate.textContent === "approval.cancel");
			click(cancel);

			expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
		});
	});

	describe("unknown-request fallback inside the window", () => {
		it("renders a visible entry naming the request and its text with the unsupported note", () => {
			renderWindow({
				id: "u1",
				method: "fallback",
				title: "Deploy to prod?",
				message: "Approve the rollout",
			});

			const dialog = panel();
			expect(dialog).not.toBeNull();
			expect(dialog?.textContent).toContain("Deploy to prod?");
			expect(dialog?.textContent).toContain("Approve the rollout");
			expect(document.querySelector(".th-approval-fallback-note")?.textContent).toContain(
				"approval.unsupportedNote",
			);
		});

		it("answers with plain confirmation, free text, and always cancel", () => {
			const { onRespond } = renderWindow({ id: "u1", method: "fallback", title: "Deploy?" });

			const form = document.querySelector("form.th-approval-form");
			expect(form).not.toBeNull();
			const labels = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-modal button"),
			)
				.filter((button) => button.closest(".th-approval-form"))
				.map((button) => button.textContent);
			expect(labels).toEqual(["approval.submit", "approval.confirm", "approval.cancel"]);

			act(() => {
				const confirm = Array.from(form!.querySelectorAll<HTMLButtonElement>("button"))
					.find((button) => button.textContent === "approval.confirm");
				confirm?.click();
			});
			expect(onRespond).toHaveBeenLastCalledWith({ confirmed: true });

			act(() => {
				const input = form!.querySelector<HTMLInputElement>("input.th-approval-input");
				if (input) {
					// React's controlled-input tracker ignores direct .value writes;
					// drive the prototype setter so onChange fires.
					Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "ship it");
					input.dispatchEvent(new Event("input", { bubbles: true }));
				}
			});
			act(() => {
				form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			expect(onRespond).toHaveBeenLastCalledWith({ value: "ship it" });

			act(() => {
				const cancel = Array.from(form!.querySelectorAll<HTMLButtonElement>("button"))
					.find((button) => button.textContent === "approval.cancel");
				cancel?.click();
			});
			expect(onRespond).toHaveBeenLastCalledWith({ cancelled: true });
		});

		it("keeps the known select rendering exactly as before", () => {
			renderWindow({ id: "s1", method: "select", title: "Run tests?", options: ["Allow", "Block"] });

			expect(document.querySelector(".th-approval-fallback-note")).toBeNull();
			const options = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
			);
			expect(options.map((button) => button.textContent)).toEqual([
				"Allow",
				"Block",
				"approval.cancel",
			]);
		});
	});

	describe("question id robustness", () => {
		it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
			"submits exact answer keys when the question id is %s",
			(id) => {
				const { onRespond } = renderWindow({
					id: "request",
					method: "question",
					questions: [{ id, multiSelect: true, options: [{ label: "Go" }] }],
				});

				const option = document.querySelector<HTMLButtonElement>(".th-approval-question-option");
				expect(option).not.toBeNull();
				act(() => option?.click());
				expect(option?.getAttribute("aria-pressed")).toBe("true");
				const submit = document.querySelector<HTMLButtonElement>(".th-approval-question-actions button");
				act(() => submit?.click());
				// Then the exact id survives as an own, serializable answer key.
				expect(onRespond).toHaveBeenCalledExactlyOnceWith({
					answers: Object.fromEntries([[id, { selected: ["Go"] }]]),
				});
				expect(JSON.stringify(onRespond.mock.calls[0]?.[0])).toBe(
					JSON.stringify({ answers: Object.fromEntries([[id, { selected: ["Go"] }]]) }),
				);
			},
		);
	});
});

describe("QuestionWindow explicit-exit focus handoff (C3 semantics)", () => {
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
	// a sibling band after the band/window pair inside .th-chat-pane.
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

	const focusComposer = (): void => {
		pane?.querySelector<HTMLElement>(".th-chat-input textarea")?.focus();
	};

	function renderWindow(
		request: ApprovalRequest,
		onRespond: (response: ApprovalResponse) => void = vi.fn(),
		key = "a",
	): { onRespond: (response: ApprovalResponse) => void } {
		act(() => {
			root.render(
				<I18nContext.Provider key={key} value={i18n}>
					<QuestionWindow
						request={request}
						open
						onCollapse={vi.fn()}
						onRespond={onRespond}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});
		return { onRespond };
	}

	const answerInput = (): HTMLInputElement | null =>
		document.querySelector<HTMLInputElement>(".th-approval-question-text");

	// Submit only renders on the last question (the stepper contract), so a
	// submit-driven exit must first step to the final tab.
	function lastQuestionSubmit(): HTMLButtonElement | undefined {
		const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
		act(() => tabs.at(-1)?.click());
		return Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.submit");
	}

	it("does not hand focus to the composer when the same request merely remounts", async () => {
		mountPaneWithComposer();
		const { onRespond } = renderWindow(TWO_QUESTIONS, vi.fn(), "first");

		// Same request id, focused answer input — the user is mid-answer.
		const input = answerInput();
		expect(input).not.toBeNull();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// A remount without an exit: the same request id is re-presented in
		// one commit (a re-keyed wrapper re-renders the pane). This is NOT an
		// exit — answered/cancelled/collapsed never happened — so the window
		// must never hand focus to the composer. The modal stack re-anchors
		// focus inside the reopened dialog (its focusInitial), which is the
		// window's honest focus target; the composer must stay untouched.
		await act(async () => {
			root.render(
				<I18nContext.Provider key="second" value={i18n}>
					<QuestionWindow
						request={TWO_QUESTIONS}
						open
						onCollapse={vi.fn()}
						onRespond={onRespond}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});

		expect(composerFocuses).toEqual([]);
		expect(document.activeElement?.closest(".th-modal")).not.toBeNull();
	});

	it("hands focus to the composer synchronously when the request is answered", async () => {
		mountPaneWithComposer();
		const { onRespond } = renderWindow(TWO_QUESTIONS);

		const submit = lastQuestionSubmit();
		expect(submit).toBeDefined();

		// Answering ends the request: the app clears it and the window
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
		renderWindow(TWO_QUESTIONS);

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

	it("hands focus to the composer when the window collapses (X)", () => {
		mountPaneWithComposer();
		const onCollapse = vi.fn(() => {
			act(() => {
				root.render(
					<I18nContext.Provider value={i18n}>
						<QuestionWindow
							request={{ id: "confirm-1", method: "confirm" }}
							open={false}
							onCollapse={vi.fn()}
							onRespond={vi.fn()}
							focusComposer={focusComposer}
						/>
					</I18nContext.Provider>,
				);
			});
		});
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow
						request={{ id: "confirm-1", method: "confirm" }}
						open
						onCollapse={onCollapse}
						onRespond={vi.fn()}
						focusComposer={focusComposer}
					/>
				</I18nContext.Provider>,
			);
		});

		act(() => {
			document.querySelector<HTMLButtonElement>(".th-modal-close")?.click();
		});
		expect(document.activeElement).toBe(composer);
	});

	it("does not steal focus on unmount when focus is outside the window", async () => {
		mountPaneWithComposer();
		const outside = document.createElement("button");
		outside.type = "button";
		document.body.appendChild(outside);

		renderWindow({ id: "confirm-1", method: "confirm" });
		act(() => outside.focus());
		expect(document.activeElement).toBe(outside);

		await act(async () => {
			root.unmount();
		});
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});

describe("QuestionNoticeBand one-line notice band", () => {
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
		vi.useRealTimers();
	});

	function renderBand(request: ApprovalRequest, onOpen = vi.fn()): ReturnType<typeof vi.fn> {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionNoticeBand request={request} onOpen={onOpen} />
				</I18nContext.Provider>,
			);
		});
		return onOpen;
	}

	const band = (): HTMLElement | null => container.querySelector(".th-question-band");

	it("shows the title, the question count, the deadline, and an Open button", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderBand({
			...TWO_QUESTIONS,
			deadlineAtMs: 1_000_000 + 45_000,
		});

		expect(band()).not.toBeNull();
		expect(band()?.textContent).toContain("Setup choices");
		expect(band()?.querySelector(".th-question-band-count")?.textContent).toBe(
			"approval.band.questions count=2",
		);
		expect(band()?.querySelector(".th-question-window-countdown")?.textContent).toBe(
			"approval.remaining seconds=45",
		);
		const open = band()?.querySelector<HTMLButtonElement>(".th-question-band-open");
		expect(open?.textContent).toBe("approval.band.open");
	});

	it("defaults the title to the approval label and omits the count for non-question requests", () => {
		renderBand({ id: "confirm-1", method: "confirm" });

		expect(band()?.querySelector(".th-question-band-title")?.textContent).toBe("approval.title");
		expect(band()?.querySelector(".th-question-band-count")).toBeNull();
	});

	it("opens the window from the band's Open button", () => {
		const onOpen = renderBand({ id: "confirm-1", method: "confirm" });

		const open = band()?.querySelector<HTMLButtonElement>(".th-question-band-open");
		act(() => open?.click());
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("renders no deadline segment without deadline fields", () => {
		renderBand(TWO_QUESTIONS);

		expect(band()?.querySelector(".th-question-window-countdown")).toBeNull();
	});
});
