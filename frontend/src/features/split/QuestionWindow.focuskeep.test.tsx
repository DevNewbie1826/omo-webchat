import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest } from "./QuestionWindow";
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

interface TouchPoint {
	readonly identifier: number;
	readonly clientX: number;
	readonly clientY: number;
}

/** Builds a bubbling, cancelable touch event carrying the given touch lists.
 *  jsdom has no Touch constructor, so plain Events carry the coordinates the
 *  handlers read (touches/changedTouches). */
function touchGestureEvent(
	type: "touchstart" | "touchmove" | "touchend",
	touches: readonly TouchPoint[],
	changedTouches: readonly TouchPoint[] = touches,
): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", { value: touches });
	Object.defineProperty(event, "changedTouches", { value: changedTouches });
	return event;
}

/** The option buttons' touch contract (tap gate, focus-keep, manual
 *  drag-scroll, stray-click swallow), ported from the retired inline dock
 *  (PR #177) to the question window: the focus scope is the dialog and the
 *  drag-scroll target is the window body. */
describe("QuestionWindow option-button touch contract", () => {
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

	const option = (label: string): HTMLButtonElement | undefined =>
		Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find(
			(button) =>
				button.querySelector(".th-approval-question-option-label")?.textContent === label,
		);
	const tab = (label: string): HTMLButtonElement | undefined =>
		Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
			(button) => button.textContent === label,
		);
	const answerInput = (): HTMLInputElement | null =>
		document.querySelector<HTMLInputElement>(".th-approval-question-text");

	it("keeps the answer input focused through a touch tap (iOS steals focus at touchstart)", () => {
		renderWindow(QUESTIONS);

		const input = answerInput();
		expect(input).not.toBeNull();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// iOS Safari moves focus at the TOUCH level: an unprevented touchstart
		// blurs the open input and drops the software keyboard (pointerdown and
		// mousedown fire too late to stop it). React registers its root
		// touchstart listener as passive, so the cancel must actually land on a
		// non-passive listener on the button itself.
		const go = option("Go") as HTMLButtonElement;
		const touchstart = new Event("touchstart", { bubbles: true, cancelable: true });
		act(() => {
			go.dispatchEvent(touchstart);
		});
		expect(touchstart.defaultPrevented).toBe(true);
		if (!touchstart.defaultPrevented) {
			(document.activeElement as HTMLElement | null)?.blur();
		}

		const touchend = new Event("touchend", { bubbles: true, cancelable: true });
		act(() => {
			go.dispatchEvent(touchend);
		});
		expect(touchend.defaultPrevented).toBe(true);

		expect(document.activeElement).toBe(input);
		expect(go.getAttribute("aria-pressed")).toBe("true");
	});

	it("activates the selection on touchend itself, without any synthesized click", () => {
		renderWindow(QUESTIONS);

		const input = answerInput();
		act(() => input?.focus());

		// Canceling touchstart/touchend suppresses the browser's click
		// synthesis, so touchend must apply the toggle on its own.
		const go = option("Go") as HTMLButtonElement;
		const touchend = new Event("touchend", { bubbles: true, cancelable: true });
		act(() => {
			go.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
			go.dispatchEvent(touchend);
		});
		expect(touchend.defaultPrevented).toBe(true);
		expect(go.getAttribute("aria-pressed")).toBe("true");
	});

	it("treats a drag over 10px as a scroll, not a tap: no toggle, the window body scrolls, the stray click is swallowed", () => {
		renderWindow(QUESTIONS);

		const input = answerInput();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		const body = document.querySelector<HTMLElement>(".th-question-window-body");
		expect(body).not.toBeNull();
		(body as HTMLElement).scrollTop = 0;

		// The reviewed regression: a swipe across the options must neither
		// submit the option it started on nor leave the list unscrollable.
		// Canceling touchstart kills native scrolling for the gesture, so the
		// window body is dragged manually by the touch delta.
		const go = option("Go") as HTMLButtonElement;
		const touchend = touchGestureEvent("touchend", [], [{ identifier: 0, clientX: 40, clientY: 160 }]);
		act(() => {
			go.dispatchEvent(touchGestureEvent("touchstart", [{ identifier: 0, clientX: 40, clientY: 200 }]));
			go.dispatchEvent(touchGestureEvent("touchmove", [{ identifier: 0, clientX: 40, clientY: 160 }]));
			go.dispatchEvent(touchend);
		});

		expect(touchend.defaultPrevented).toBe(true);
		expect(go.getAttribute("aria-pressed")).toBe("false");
		expect((body as HTMLElement).scrollTop).toBeGreaterThan(0);
		expect(document.activeElement).toBe(input);

		// The drag still records the dedup timestamp, so any residual
		// synthesized click must not toggle the option on afterwards.
		act(() => go.click());
		expect(go.getAttribute("aria-pressed")).toBe("false");
	});

	it("leaves touches native when focus is outside the window", () => {
		const outside = document.createElement("input");
		document.body.appendChild(outside);
		try {
			renderWindow(QUESTIONS);
			act(() => outside.focus());
			expect(document.activeElement).toBe(outside);

			// No typing context to protect: the browser keeps its native
			// behavior — scrolling, then a synthesized click that activates.
			const go = option("Go") as HTMLButtonElement;
			const touchstart = touchGestureEvent("touchstart", [
				{ identifier: 0, clientX: 40, clientY: 200 },
			]);
			act(() => {
				go.dispatchEvent(touchstart);
			});
			expect(touchstart.defaultPrevented).toBe(false);

			const touchend = touchGestureEvent("touchend", [], [{ identifier: 0, clientX: 40, clientY: 200 }]);
			act(() => {
				go.dispatchEvent(touchend);
			});
			expect(touchend.defaultPrevented).toBe(false);
			expect(go.getAttribute("aria-pressed")).toBe("false");

			act(() => go.click());
			expect(go.getAttribute("aria-pressed")).toBe("true");
		} finally {
			outside.remove();
		}
	});

	it("ignores a click within 500ms of a touch activation but not a later one", () => {
		renderWindow(QUESTIONS);

		const input = answerInput();
		act(() => input?.focus());

		const go = option("Go") as HTMLButtonElement;
		act(() => {
			go.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
			go.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));
		});
		expect(go.getAttribute("aria-pressed")).toBe("true");

		// A webview that still delivers the synthesized click right after the
		// touchend activation must not toggle the multiSelect option back off.
		act(() => go.click());
		expect(go.getAttribute("aria-pressed")).toBe("true");

		// The guard is a dedup window, not a latch: later real clicks toggle.
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
		try {
			act(() => go.click());
		} finally {
			clock.mockRestore();
		}
		expect(go.getAttribute("aria-pressed")).toBe("false");
	});

	it("still toggles on a bare click with no prior touch (mouse/keyboard path)", () => {
		renderWindow(QUESTIONS);

		const go = option("Go") as HTMLButtonElement;
		act(() => go.click());
		expect(go.getAttribute("aria-pressed")).toBe("true");
	});

	it("keeps the answer input focused while selecting an option from it", () => {
		renderWindow(QUESTIONS);

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
		renderWindow(QUESTIONS);

		const input = answerInput();
		act(() => input?.focus());
		const go = option("Go") as HTMLButtonElement;
		act(() => tap(go));
		act(() => tap(go));

		expect(document.activeElement).toBe(input);
		expect(go.getAttribute("aria-pressed")).toBe("false");
	});

	it("cancels the pointerdown default so the browser never blurs the input", () => {
		renderWindow(QUESTIONS);

		const pointerdown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		(option("TS") as HTMLButtonElement).dispatchEvent(pointerdown);
		expect(pointerdown.defaultPrevented).toBe(true);
	});

	it("keeps focus-follows-tap for tab switches and the action row (context changes)", () => {
		renderWindow(QUESTIONS);

		// Tabs switch the tabpanel (the input being typed in unmounts), and
		// the action row ends or advances the request: both are explicit
		// context changes, so they keep the browser's default focus
		// behavior — only option toggles must not steal the keyboard.
		const tabPointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		(tab("Region") as HTMLButtonElement).dispatchEvent(tabPointer);
		expect(tabPointer.defaultPrevented).toBe(false);

		const next = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.question.next");
		expect(next).toBeDefined();
		const nextPointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		(next as HTMLButtonElement).dispatchEvent(nextPointer);
		expect(nextPointer.defaultPrevented).toBe(false);
	});
});
