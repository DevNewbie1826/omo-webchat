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
	id: "ask-kb",
	method: "question",
	title: "Keyboard layout",
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			options: [{ label: "Go" }, { label: "TS" }],
		},
	],
};

/** A controllable window.visualViewport stand-in: geometry the test mutates,
 *  resize events the test dispatches (the ModelPicker.desktop.test pattern). */
class ControlledVisualViewport extends EventTarget {
	width = 390;
	height = 844;
	offsetTop = 0;
	offsetLeft = 0;
	scale = 1;
	shrinkTo(height: number): void {
		this.height = height;
		this.dispatchEvent(new Event("resize"));
	}
}

describe("ApprovalDock keyboard-aware layout", () => {
	let container: HTMLDivElement;
	let root: Root;
	let viewport: ControlledVisualViewport;
	const columns: HTMLElement[] = [];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		viewport = new ControlledVisualViewport();
		vi.stubGlobal("visualViewport", viewport);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		for (const column of columns.splice(0)) column.remove();
		container.remove();
		document.documentElement.removeAttribute("data-th-keyboard-open");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
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

	function mockRect(element: Element, top: number, height: number): void {
		vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
			height,
			width: 390,
			top,
			bottom: top + height,
			left: 0,
			right: 390,
			x: 0,
			y: top,
			toJSON: () => ({}),
		} as DOMRect);
	}

	/** jsdom reports every offsetHeight as 0; an own property shadows the
	 *  prototype getter for the one element under measurement. */
	function mockOffsetHeight(element: Element, height: number): void {
		Object.defineProperty(element, "offsetHeight", { configurable: true, value: height });
	}

	// Mounts the dock as a band in a minimal .th-chat-main column (the
	// ChatPane sibling order), with a generous column so the dock stays
	// expanded; rects default to zeros except where overridden per test.
	function renderDockInColumn(request: ApprovalRequest): HTMLElement {
		const column = document.createElement("div");
		column.className = "th-chat-main";
		const content = document.createElement("div");
		content.className = "th-chat-main-content";
		const scrollport = document.createElement("div");
		scrollport.className = "th-chat-scrollport";
		content.appendChild(scrollport);
		const controls = document.createElement("div");
		controls.className = "th-chat-controls";
		const composer = document.createElement("div");
		composer.className = "th-chat-input";
		column.append(content, controls, container, composer);
		document.body.appendChild(column);
		columns.push(column);
		mockRect(column, 0, 800);
		mockRect(controls, 0, 24);
		mockRect(composer, 700, 100);
		mockRect(container, 576, 224);
		renderDock(request);
		return column;
	}

	const body = (): HTMLElement | null =>
		container.querySelector<HTMLElement>(".th-approval-dock-body");
	const answerInput = (): HTMLInputElement | null =>
		container.querySelector<HTMLInputElement>(".th-approval-question-text");
	const actionsRow = (): HTMLElement | null =>
		container.querySelector<HTMLElement>(".th-approval-question-actions");

	it("scrolls the focused answer input AND the actions row into the visible slice when the keyboard shrinks the viewport", async () => {
		renderDockInColumn(QUESTION);
		expect(body()).not.toBeNull();

		const input = answerInput();
		expect(input).not.toBeNull();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// Slice geometry: body occupies [300, 500]; the focused input hangs
		// 24px below the slice; the actions row sits 150px below it.
		mockRect(body() as Element, 300, 200);
		mockRect(input as Element, 480, 44);
		mockRect(actionsRow() as Element, 600, 50);

		// The keyboard opens: the boot script raises the app-global attribute —
		// the dock's only keyboard signal now (a raw visual-viewport shrink no
		// longer reaches the dock's state).
		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		// Both fit: the body scrolls the 150px that pulls the actions row's
		// bottom to the slice bottom — the input (top 480) still clears the
		// slice top (300) with room to spare.
		expect(body()?.scrollTop).toBe(150);
	});

	it("prioritizes the focused input when the slice cannot fit input and actions together", async () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		mockRect(body() as Element, 300, 200);
		mockRect(input as Element, 480, 44);
		// The actions row is far below: fitting it would push the input's top
		// above the slice top (cap = 480 - 300 = 180). The input wins.
		mockRect(actionsRow() as Element, 820, 50);

		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		expect(body()?.scrollTop).toBe(180);
	});

	it("bounds the dock's max-height so its bottom stays inside the visual viewport", () => {
		const column = renderDockInColumn(QUESTION);
		expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();

		// The dock's top sits at 400; the visual viewport shrinks to 500:
		// the remaining space below the dock's top is 100px, so the inline
		// clamp must not exceed it.
		const section = container.querySelector<HTMLElement>(".th-approval-dock");
		expect(section).not.toBeNull();
		mockRect(section as Element, 400, 224);
		mockRect(column, 0, 500);
		mockRect(container, 400, 224);

		act(() => viewport.shrinkTo(500));

		const maxHeight = Number.parseFloat((section as HTMLElement).style.maxHeight);
		expect(maxHeight).toBeLessThanOrEqual(101);
		expect(maxHeight).toBeGreaterThan(0);
	});

	it("gates the input-priority floor and the --keyboard modifier on focus inside the dock", async () => {
		const column = renderDockInColumn(QUESTION);
		const section = container.querySelector<HTMLElement>(".th-approval-dock");
		const header = container.querySelector<HTMLElement>(".th-approval-dock-header");
		const tabs = container.querySelector<HTMLElement>(".th-approval-question-tabs");
		const input = answerInput();
		const actions = actionsRow();
		expect(section).not.toBeNull();
		expect(header).not.toBeNull();
		expect(tabs).not.toBeNull();
		expect(input).not.toBeNull();
		expect(actions).not.toBeNull();

		// The composer owns the keyboard on arrival: the dock's arrival focus
		// lands on its own primary control, so move focus OUTSIDE first — the
		// real-device defect had the composer focused while the dock inflated.
		const composerInput = document.createElement("textarea");
		column.querySelector(".th-chat-input")?.appendChild(composerInput);
		act(() => composerInput.focus());
		expect(document.activeElement).toBe(composerInput);

		// A keyboard-starved 360px column (the real-device geometry): header
		// 32px + the 48px body floor = an 80px dock minimum, and the column
		// budgets an 80px clamp for it. The input-priority floor (header +
		// tabs 28 + answer 44 + actions 40 = 144px) lifts the clamp to 96px:
		// the transcript reserve yields it ONLY while the dock owns the focus
		// the keyboard is typing into.
		mockRect(column, 0, 360);
		mockRect(container, 120, 140);
		mockRect(section as Element, 120, 140);
		mockRect(header as Element, 120, 32);
		mockOffsetHeight(tabs as Element, 28);
		mockOffsetHeight(input as Element, 44);
		mockOffsetHeight(actions as Element, 40);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect((section as HTMLElement).style.maxHeight).toBe("80px");

		// The keyboard opens (the boot script's shrink judgment raises the
		// app-global attribute; the raw shrink itself no longer reaches the
		// dock) while focus sits OUTSIDE the dock — the composer's keyboard.
		// The dock must not claim it: no modifier, no floor, the transcript
		// keeps its reserve.
		act(() => viewport.shrinkTo(500));
		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});
		expect(document.activeElement).toBe(composerInput);
		expect(section?.classList.contains("th-approval-dock--keyboard")).toBe(false);
		expect(section?.classList.contains("th-approval-dock--input-priority")).toBe(false);
		expect(section?.style.maxHeight).toBe("80px");

		// Focus moves INTO the dock's answer input: the dock owns the slice
		// the keyboard is typing into, so the floor and the modifier apply.
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);
		expect(section?.classList.contains("th-approval-dock--keyboard")).toBe(true);
		expect(section?.style.maxHeight).toBe("96px");

		// Focus leaves again: the composer owns the keyboard now, and the dock
		// yields the transcript reserve it claimed.
		act(() => composerInput.focus());
		expect(section?.classList.contains("th-approval-dock--keyboard")).toBe(false);
		expect(section?.style.maxHeight).toBe("80px");
	});

	it("caps the pinned-footer scroll at the slice top when the input cannot fully fit above the pinned row", async () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		// Body slice [300, 400]; the actions row pins to the bottom as [352,
		// 392]: the visible slice for content ends at 352. The focused input
		// [330, 390] is 60px tall — taller than the 52px slice above the pinned
		// row — so it cannot fully fit: the scroll pulls its bottom up to the
		// pinned row's top but AT MOST until its top reaches the slice top
		// (300). Scrolling the full 38px would strand the input's top above
		// the slice it must be visible in (the R1 defect).
		const actions = actionsRow();
		expect(actions).not.toBeNull();
		mockRect(body() as Element, 300, 100);
		mockRect(input as Element, 330, 60);
		mockRect(actions as Element, 352, 40);
		const realGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation(
			(element) =>
				(element === actions
					? ({ ...realGetComputedStyle(element), position: "sticky" } as CSSStyleDeclaration)
					: realGetComputedStyle(element)) as CSSStyleDeclaration,
		);

		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		expect(body()?.scrollTop).toBe(30);
	});

	it("pulls an input that scrolled above the slice back down below the pinned TAB band, not merely inside the body", async () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		// The tab strip pins to the slice top [300, 330] and the actions row
		// pins to the slice bottom [380, 420]: content is only visible in
		// [330, 380]. The focused input sits entirely above that (the R1
		// geometry at a 400px window): the scroll must pull it down until its
		// top clears the pinned TAB band (330) — stopping at the body top
		// (300) leaves it hidden under the pinned strip.
		const tabs = container.querySelector<HTMLElement>(".th-approval-question-tabs");
		const actions = actionsRow();
		expect(tabs).not.toBeNull();
		mockRect(body() as Element, 300, 120);
		mockRect(tabs as Element, 300, 30);
		mockRect(input as Element, 290, 44);
		mockRect(actions as Element, 380, 40);
		const realGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation(
			(element) =>
				(element === tabs || element === actions)
					? ({ ...realGetComputedStyle(element), position: "sticky" } as CSSStyleDeclaration)
					: realGetComputedStyle(element) as CSSStyleDeclaration,
		);

		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		expect(body()?.scrollTop).toBe(-40);
	});

	it("reserves the pinned tab band when pulling the actions row into the slice", async () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		// Tabs pinned [300, 330]; the actions row is NOT pinned and sits far
		// below: pulling its bottom (510) to the slice bottom (420) wants
		// 90px, but the input's top (405) may not cross the pinned tab band's
		// bottom (330): the pull-in caps at 75, not at the body top's 105.
		const tabs = container.querySelector<HTMLElement>(".th-approval-question-tabs");
		const actions = actionsRow();
		expect(tabs).not.toBeNull();
		mockRect(body() as Element, 300, 120);
		mockRect(tabs as Element, 300, 30);
		mockRect(input as Element, 405, 44);
		mockRect(actions as Element, 460, 50);
		const realGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation(
			(element) =>
				(element === tabs
					? ({ ...realGetComputedStyle(element), position: "sticky" } as CSSStyleDeclaration)
					: realGetComputedStyle(element)) as CSSStyleDeclaration,
		);

		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		expect(body()?.scrollTop).toBe(75);
	});

	it("yields the pinned tab band when tabs + input + actions cannot all fit the slice", async () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		// Starved slice (the R1 geometry at a 400px window): the pinned tab
		// band [300, 330] and the pinned actions band [360, 400] leave only 30px
		// between them — less than the 44px input — while the input DOES fit
		// once the tab band yields ([300, 360] = 60px). The tab band must yield
		// (the dock carries the input-priority modifier) so the focused input
		// can own the slice above the pinned actions row.
		const section = container.querySelector<HTMLElement>(".th-approval-dock");
		const tabs = container.querySelector<HTMLElement>(".th-approval-question-tabs");
		const actions = actionsRow();
		expect(tabs).not.toBeNull();
		mockRect(body() as Element, 300, 100);
		mockRect(tabs as Element, 300, 30);
		mockRect(input as Element, 280, 44);
		mockRect(actions as Element, 360, 40);
		const realGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation(
			(element) =>
				(element === tabs || element === actions)
					? ({ ...realGetComputedStyle(element), position: "sticky" } as CSSStyleDeclaration)
					: realGetComputedStyle(element) as CSSStyleDeclaration,
		);

		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		expect(section?.classList.contains("th-approval-dock--input-priority")).toBe(true);

		// Room returns: tabs + input + actions fit the slice again, so the tab
		// band re-pins (modifier off) — recovery must not stick in the
		// fallback. The attribute flips stand in for the boot script's keyboard
		// transitions: they are the only signal that re-runs the dock's scroll
		// discipline now.
		mockRect(body() as Element, 300, 200);
		mockRect(tabs as Element, 300, 30);
		mockRect(input as Element, 360, 44);
		mockRect(actions as Element, 460, 40);
		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", false);
		});
		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		expect(section?.classList.contains("th-approval-dock--input-priority")).toBe(false);
	});

	it("clears the focused input above a pinned (sticky) actions row instead of scrolling past it", async () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		// The keyboard density pins the actions row: it reads as sitting at the
		// slice bottom [380, 420] regardless of scroll. The focused input at
		// [400, 444] must scroll up to clear the pinned row's top (380), not
		// the body bottom — and the actions row itself must not be scrolled.
		const actions = actionsRow();
		expect(actions).not.toBeNull();
		mockRect(body() as Element, 300, 120);
		mockRect(input as Element, 400, 44);
		mockRect(actions as Element, 380, 40);
		const realGetComputedStyle = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation(
			(element) =>
				(element === actions
					? ({ ...realGetComputedStyle(element), position: "sticky" } as CSSStyleDeclaration)
					: realGetComputedStyle(element)) as CSSStyleDeclaration,
		);

		await act(async () => {
			document.documentElement.toggleAttribute("data-th-keyboard-open", true);
		});

		// inputBottom (444) - pinnedTop (380) = 64: the input rises to sit just
		// above the pinned row; no further scroll chases the actions row.
		expect(body()?.scrollTop).toBe(64);
	});
});
