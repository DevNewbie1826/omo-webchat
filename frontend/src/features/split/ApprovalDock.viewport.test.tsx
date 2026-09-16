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

	it("scrolls the focused answer input AND the actions row into the visible slice when the keyboard shrinks the viewport", () => {
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

		act(() => viewport.shrinkTo(500));

		// Both fit: the body scrolls the 150px that pulls the actions row's
		// bottom to the slice bottom — the input (top 480) still clears the
		// slice top (300) with room to spare.
		expect(body()?.scrollTop).toBe(150);
	});

	it("prioritizes the focused input when the slice cannot fit input and actions together", () => {
		renderDockInColumn(QUESTION);
		const input = answerInput();
		act(() => input?.focus());

		mockRect(body() as Element, 300, 200);
		mockRect(input as Element, 480, 44);
		// The actions row is far below: fitting it would push the input's top
		// above the slice top (cap = 480 - 300 = 180). The input wins.
		mockRect(actionsRow() as Element, 820, 50);

		act(() => viewport.shrinkTo(500));

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

	it("clears the focused input above a pinned (sticky) actions row instead of scrolling past it", () => {
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

		act(() => viewport.shrinkTo(500));

		// inputBottom (444) - pinnedTop (380) = 64: the input rises to sit just
		// above the pinned row; no further scroll chases the actions row.
		expect(body()?.scrollTop).toBe(64);
	});
});
