import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewport } from "./useVisualViewport";
import type { VisualViewportBox } from "./useVisualViewport";
/** EventTarget-based visualViewport stand-in with mutable geometry. */
class FakeVisualViewport extends EventTarget {
	width = 390;
	height = 844;
	offsetTop = 0;
	offsetLeft = 0;
	scale = 1;
	resize(height: number, offsetTop = 0): void {
		this.height = height;
		this.offsetTop = offsetTop;
		this.dispatchEvent(new Event("resize"));
	}
}

describe("useVisualViewport", () => {
	let container: HTMLDivElement;
	let boxes: (VisualViewportBox | null)[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		boxes = [];
	});

	afterEach(() => {
		container.remove();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function renderProbe(): void {
		const Probe = (): null => {
			boxes.push(useVisualViewport());
			return null;
		};
		act(() => {
			createRoot(container).render(<Probe /> as ReactElement);
		});
	}

	it("reports null before the first measurement, then the visual viewport geometry", () => {
		const viewport = new FakeVisualViewport();
		vi.stubGlobal("visualViewport", viewport);
		renderProbe();

		// The first effect run measures synchronously.
		expect(boxes[0]).toBeNull();
		expect(boxes.at(-1)).toEqual({
			width: 390,
			height: 844,
			offsetTop: 0,
			offsetLeft: 0,
		});
	});

	it("follows keyboard-like shrinks and pans through resize and scroll events", () => {
		const viewport = new FakeVisualViewport();
		vi.stubGlobal("visualViewport", viewport);
		renderProbe();

		// The keyboard opens: the visible height shrinks and iOS pans the
		// visual viewport to the focused input.
		act(() => viewport.resize(500, 72));
		expect(boxes.at(-1)).toEqual({
			width: 390,
			height: 500,
			offsetTop: 72,
			offsetLeft: 0,
		});

		// A pan without a resize (scroll event) is still geometry the layout
		// must follow.
		viewport.offsetTop = 96;
		act(() => {
			viewport.dispatchEvent(new Event("scroll"));
		});
		expect(boxes.at(-1)?.offsetTop).toBe(96);
	});

	it("emits a new box only when a value actually changed", () => {
		const viewport = new FakeVisualViewport();
		vi.stubGlobal("visualViewport", viewport);
		renderProbe();
		const settled = boxes.at(-1);
		expect(settled).not.toBeNull();

		// An event with unchanged geometry must not produce a new box: the
		// hook returns the previous object identity, so no re-render commits.
		act(() => viewport.resize(844));
		expect(boxes.at(-1)).toBe(settled);
	});

	it("falls back to window inner geometry when VisualViewport is absent", () => {
		vi.stubGlobal("visualViewport", undefined);
		vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
		vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
		renderProbe();

		expect(boxes.at(-1)).toEqual({
			width: 390,
			height: 768,
			offsetTop: 0,
			offsetLeft: 0,
		});

		// A window resize updates the fallback box.
		vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(boxes.at(-1)?.height).toBe(500);
	});
});
