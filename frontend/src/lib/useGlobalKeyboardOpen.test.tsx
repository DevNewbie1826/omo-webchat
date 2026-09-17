import { act } from "react";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalKeyboardOpen } from "./useGlobalKeyboardOpen";

const KEYBOARD_OPEN = "data-th-keyboard-open";

/** EventTarget-based visualViewport stand-in (the useVisualViewport.test
 *  pattern): geometry events the test dispatches, no layout behind them. */
class FakeVisualViewport extends EventTarget {
	width = 390;
	height = 844;
	offsetTop = 0;
	offsetLeft = 0;
	scale = 1;
}

describe("useGlobalKeyboardOpen", () => {
	let container: HTMLDivElement;
	let root: Root | null;
	let states: boolean[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		document.documentElement.removeAttribute(KEYBOARD_OPEN);
		container = document.createElement("div");
		document.body.appendChild(container);
		states = [];
		root = null;
	});

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
			});
		}
		container.remove();
		document.documentElement.removeAttribute(KEYBOARD_OPEN);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function renderProbe(): Promise<void> {
		const Probe = (): null => {
			states.push(useGlobalKeyboardOpen());
			return null;
		};
		root = createRoot(container);
		await act(async () => {
			root?.render(<Probe /> as ReactElement);
		});
	}

	it("starts closed when the boot script has not raised the attribute", async () => {
		await renderProbe();
		expect(states.at(-1)).toBe(false);
	});

	it("starts open when the boot script already raised the attribute", async () => {
		document.documentElement.toggleAttribute(KEYBOARD_OPEN, true);
		await renderProbe();
		expect(states.at(-1)).toBe(true);
	});

	it("follows attribute flips through the html MutationObserver", async () => {
		await renderProbe();
		expect(states.at(-1)).toBe(false);

		await act(async () => {
			document.documentElement.toggleAttribute(KEYBOARD_OPEN, true);
		});
		expect(states.at(-1)).toBe(true);

		await act(async () => {
			document.documentElement.toggleAttribute(KEYBOARD_OPEN, false);
		});
		expect(states.at(-1)).toBe(false);
	});

	it("re-reads the attribute on window resize and visualViewport resize/scroll", async () => {
		const viewport = new FakeVisualViewport();
		vi.stubGlobal("visualViewport", viewport);
		await renderProbe();

		// The geometry events never judge the keyboard themselves — they only
		// re-poll the boot script's attribute (the single source of truth).
		document.documentElement.toggleAttribute(KEYBOARD_OPEN, true);
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(states.at(-1)).toBe(true);

		document.documentElement.toggleAttribute(KEYBOARD_OPEN, false);
		act(() => {
			viewport.dispatchEvent(new Event("scroll"));
		});
		expect(states.at(-1)).toBe(false);

		document.documentElement.toggleAttribute(KEYBOARD_OPEN, true);
		act(() => {
			viewport.dispatchEvent(new Event("resize"));
		});
		expect(states.at(-1)).toBe(true);
	});

	it("never re-renders when a re-read finds the attribute unchanged", async () => {
		await renderProbe();
		const settled = states.length;

		// Geometry noise (a URL-bar wobble) with an unchanged attribute must be
		// a no-op: no new state, no re-render commit.
		act(() => {
			window.dispatchEvent(new Event("resize"));
		});
		expect(states.at(-1)).toBe(false);
		expect(states.length).toBe(settled);
	});
});
