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

describe("ApprovalDock inline panel", () => {
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

	function renderDock(request: ApprovalRequest, onRespond = vi.fn()): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ApprovalDock request={request} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});
	}

	const dock = (): HTMLElement | null => container.querySelector(".th-approval-dock");

	it("renders inline without a portal, overlay, or dialog role", () => {
		renderDock({ id: "confirm-1", method: "confirm" });

		expect(dock()).not.toBeNull();
		expect(dock()?.tagName.toLowerCase()).toBe("section");
		expect(container.querySelector(".th-modal-overlay")).toBeNull();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.body.style.overflow).not.toBe("hidden");
	});

	it("renders one button per select option and answers with the chosen value", () => {
		const onRespond = vi.fn();
		renderDock({ id: "select-1", method: "select", options: ["Allow", "Block"] }, onRespond);

		const options = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
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
		const onRespond = vi.fn();
		renderDock({ id: "confirm-1", method: "confirm" }, onRespond);

		const buttons = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
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
		const onRespond = vi.fn();
		renderDock({ id: "confirm-1", method: "confirm" }, onRespond);

		const cancel = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		).find((button) => button.textContent === "approval.cancel");
		expect(cancel).not.toBeUndefined();
		expect(cancel?.className).toContain("th-btn--ghost");

		act(() => cancel?.click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
	});

	it.each(["input", "editor"] as const)("submits the %s text value", (method) => {
		const onRespond = vi.fn();
		renderDock({ id: `${method}-1`, method, prefill: "draft" }, onRespond);

		const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
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
		const onRespond = vi.fn();
		renderDock({ id: "select-1", method: "select", options: ["Allow"] }, onRespond);

		const cancel = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		).find((button) => button.textContent === "approval.cancel");
		act(() => cancel?.click());
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
	});

	it("collapses on Escape without responding and expands back without responding", () => {
		const onRespond = vi.fn();
		renderDock(
			{ id: "select-1", method: "select", title: "Run tests?", options: ["Allow"] },
			onRespond,
		);

		act(() => {
			dock()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});

		expect(onRespond).not.toHaveBeenCalled();
		expect(container.querySelector(".th-approval-options")).toBeNull();
		const summary = container.querySelector(".th-approval-dock-summary");
		expect(summary?.textContent).toContain("Run tests?");
		expect(summary?.textContent).toContain("approval.pending");

		const expand = summary?.querySelector<HTMLButtonElement>(
			'button[aria-label="approval.expand"]',
		);
		expect(expand).not.toBeNull();
		act(() => expand?.click());

		expect(onRespond).not.toHaveBeenCalled();
		expect(container.querySelector(".th-approval-options")).not.toBeNull();
	});

	it("moves focus to the primary control on arrival", () => {
		renderDock({ id: "confirm-1", method: "confirm" });

		const primary = container.querySelector("[data-approval-primary]");
		expect(document.activeElement).toBe(primary);
		expect(primary?.closest(".th-approval-dock")).not.toBeNull();
	});

	it("does not trap Tab on the last focusable control", () => {
		renderDock({ id: "confirm-1", method: "confirm" });

		const focusables = Array.from(
			container.querySelectorAll<HTMLElement>(".th-approval-dock button"),
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

		// The dock must not preventDefault the Tab (which would trap focus)
		// and must not force focus back to the first control (no wrap).
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(last);
	});

	// Production layout: the dock band comes first in the pane, the composer
	// after it, and the composer textarea lives inside the .th-chat-input
	// wrapper. A fixture that places a bare textarea before the dock hides
	// focus restoration bugs by making "the first textarea in the pane" the
	// right answer for the wrong reason.
	function mountPaneWithComposer(): { pane: HTMLElement; composer: HTMLTextAreaElement } {
		const pane = document.createElement("div");
		pane.className = "th-chat-pane";
		pane.appendChild(container);
		const composerWrap = document.createElement("div");
		composerWrap.className = "th-chat-input";
		const composer = document.createElement("textarea");
		composerWrap.appendChild(composer);
		pane.appendChild(composerWrap);
		document.body.appendChild(pane);
		return { pane, composer };
	}

	it("restores focus to the composer inside .th-chat-input when unmounted while focused", async () => {
		const { pane, composer } = mountPaneWithComposer();

		renderDock({ id: "confirm-1", method: "confirm" });
		expect(document.activeElement?.closest(".th-approval-dock")).not.toBeNull();

		await act(async () => {
			root.unmount();
		});
		expect(document.activeElement).toBe(composer);
		pane.remove();

		// Re-create for afterEach's unmount.
		root = createRoot(container);
	});

	it("restores focus to the composer, not the dock's own editor, when an editor request unmounts", async () => {
		const { pane, composer } = mountPaneWithComposer();

		renderDock({ id: "editor-1", method: "editor", prefill: "draft" });
		const editor = container.querySelector("textarea");
		expect(editor).not.toBeNull();
		expect(document.activeElement).toBe(editor);

		await act(async () => {
			root.unmount();
		});
		expect(document.activeElement).toBe(composer);
		pane.remove();

		root = createRoot(container);
	});

	it("does not steal focus on unmount when focus is outside the dock", async () => {
		const outside = document.createElement("button");
		outside.type = "button";
		document.body.appendChild(outside);

		renderDock({ id: "confirm-1", method: "confirm" });
		outside.focus();
		expect(document.activeElement).toBe(outside);

		await act(async () => {
			root.unmount();
		});
		expect(document.activeElement).toBe(outside);
		outside.remove();

		root = createRoot(container);
	});

	it("returns focus to the composer inside .th-chat-input when collapsing", () => {
		const { pane, composer } = mountPaneWithComposer();

		renderDock({ id: "confirm-1", method: "confirm" });
		expect(document.activeElement).not.toBe(composer);

		act(() => {
			dock()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(document.activeElement).toBe(composer);
		pane.remove();
	});

	it("ticks a deadlineAtMs countdown down once a second through one parameterized key", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderDock({
			id: "confirm-1",
			method: "confirm",
			deadlineAtMs: 1_000_000 + 5_000,
		});

		const countdown = (): string =>
			container.querySelector(".th-approval-dock-countdown")?.textContent ?? "";
		// The whole label comes from approval.remaining with a seconds param —
		// no bare "s" unit literal bypassing i18n.
		expect(countdown()).toBe("approval.remaining seconds=5");

		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdown()).toBe("approval.remaining seconds=4");

		act(() => {
			vi.advanceTimersByTime(2_000);
		});
		expect(countdown()).toBe("approval.remaining seconds=2");
	});

	it("counts down from remainingMs when no deadline is given", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderDock({ id: "confirm-1", method: "confirm", remainingMs: 3_000 });

		const countdown = (): string =>
			container.querySelector(".th-approval-dock-countdown")?.textContent ?? "";
		expect(countdown()).toBe("approval.remaining seconds=3");

		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(countdown()).toBe("approval.remaining seconds=2");
	});

	it("keeps the countdown visible on the collapsed summary bar", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		renderDock({
			id: "confirm-1",
			method: "confirm",
			deadlineAtMs: 1_000_000 + 5_000,
		});

		act(() => {
			dock()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		const summary = container.querySelector(".th-approval-dock-summary");
		expect(summary?.textContent).toContain("approval.remaining seconds=5");
	});

	it("keeps aria-labelledby resolving in both expanded and collapsed states", () => {
		renderDock({ id: "select-1", method: "select", title: "Run tests?", options: ["Allow"] });

		const section = dock();
		expect(section?.getAttribute("role")).toBe("region");
		const labelledBy = section?.getAttribute("aria-labelledby");
		expect(labelledBy).toBeTruthy();
		// Expanded: the heading carries the id.
		expect(document.getElementById(labelledBy ?? "")).not.toBeNull();

		act(() => {
			section?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		// Collapsed: the summary title carries the same id, so the reference
		// still resolves instead of dangling at the unmounted heading.
		const collapsedLabel = document.getElementById(labelledBy ?? "");
		expect(collapsedLabel).not.toBeNull();
		expect(collapsedLabel?.className).toBe("th-approval-dock-summary-title");
	});

	it("moves focus back to the primary control when the panel expands", () => {
		renderDock({ id: "confirm-1", method: "confirm" });

		act(() => {
			dock()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(
			document.activeElement?.closest("[data-approval-primary]"),
		).toBeNull();

		const expand = container.querySelector<HTMLButtonElement>(
			'button[aria-label="approval.expand"]',
		);
		act(() => expand?.click());

		const primary = container.querySelector("[data-approval-primary]");
		expect(document.activeElement).toBe(primary);
	});

	it("resets the draft to the new request's prefill when the request id changes", () => {
		renderDock({ id: "input-1", method: "input", prefill: "first" });

		const field = (): HTMLInputElement | null => container.querySelector("input");
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
					<ApprovalDock
						request={{ id: "input-2", method: "input", prefill: "second" }}
						onRespond={vi.fn()}
					/>
				</I18nContext.Provider>,
			);
		});
		expect(field()?.value).toBe("second");
	});

	it("renders no countdown without deadline fields and still answers", () => {
		const onRespond = vi.fn();
		renderDock({ id: "confirm-1", method: "confirm" }, onRespond);

		expect(container.querySelector(".th-approval-dock-countdown")).toBeNull();
		const allow = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		).find((button) => button.textContent === "approval.confirm");
		act(() => allow?.click());
		expect(onRespond).toHaveBeenCalledWith({ confirmed: true });
	});

	describe("space floor inside a measured chat column", () => {
		class ControlledResizeObserver {
			static instances: ControlledResizeObserver[] = [];
			private readonly cb: ResizeObserverCallback;
			readonly targets = new Set<Element>();
			constructor(cb: ResizeObserverCallback) {
				this.cb = cb;
				ControlledResizeObserver.instances.push(this);
			}
			observe(target: Element): void {
				this.targets.add(target);
			}
			unobserve(target: Element): void {
				this.targets.delete(target);
			}
			disconnect(): void {
				this.targets.clear();
			}
			trigger(): void {
				this.cb(
					[...this.targets].map(
						(target) =>
							({
								target,
								contentRect: target.getBoundingClientRect(),
							}) as unknown as ResizeObserverEntry,
					),
					this as unknown as ResizeObserver,
				);
			}
		}

		const columns: HTMLElement[] = [];

		beforeEach(() => {
			ControlledResizeObserver.instances = [];
			vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		});

		afterEach(() => {
			for (const column of columns.splice(0)) column.remove();
			vi.restoreAllMocks();
		});

		function mockHeight(element: Element, height: number): void {
			vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
				height,
				width: 600,
				top: 0,
				bottom: height,
				left: 0,
				right: 600,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			} as DOMRect);
		}

		function triggerResize(): void {
			act(() => {
				for (const observer of ControlledResizeObserver.instances) observer.trigger();
			});
		}

		// Mounts the dock as a band in a minimal .th-chat-main column:
		// content shell (with the transcript scrollport), the controls row,
		// the dock, then the composer — the same sibling order as ChatPane.
		function renderDockInColumn(
			request: ApprovalRequest,
			heights: { column: number; dock: number; controls?: number; composer?: number },
			onRespond = vi.fn(),
		): { column: HTMLElement } {
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
			mockHeight(column, heights.column);
			mockHeight(controls, heights.controls ?? 24);
			mockHeight(composer, heights.composer ?? 100);
			mockHeight(container, heights.dock);
			renderDock(request, onRespond);
			return { column };
		}

		function mockRect(element: Element, top: number, height: number): void {
			vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
				height,
				width: 600,
				top,
				bottom: top + height,
				left: 0,
				right: 600,
				x: 0,
				y: top,
				toJSON: () => ({}),
			} as DOMRect);
		}

		it("falls back to the collapsed summary when the column cannot fit the header plus one option row", () => {
			// Even with the transcript reserve fully yielded, a 160px column
			// leaves 160 − 24 controls − 100 composer = 36 — below the 48px
			// body floor.
			renderDockInColumn(
				{ id: "select-1", method: "select", title: "Proceed?", options: ["Allow", "Block"] },
				{ column: 160, dock: 0 },
			);

			expect(container.querySelector(".th-approval-dock-body")).toBeNull();
			const summary = container.querySelector(".th-approval-dock-summary");
			expect(summary).not.toBeNull();
			expect(summary?.textContent).toContain("Proceed?");
			expect(summary?.textContent).toContain("approval.pending");
			expect(
				summary?.querySelector(".th-approval-dock-toggle"),
			).not.toBeNull();
			// The collapsed summary is a fixed one-line band: it must never be
			// squeezed into a sliver of itself.
			expect(dock()?.style.flexShrink).toBe("0");
		});

		it("always answers: a toggle click expands even under the floor, and an option responds", () => {
			const onRespond = vi.fn();
			renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow", "Block"] },
				{ column: 160, dock: 0 },
				onRespond,
			);
			expect(container.querySelector(".th-approval-dock-body")).toBeNull();

			// A pending question is always answerable: the toggle is never
			// inert, no matter how short the column is.
			const expand = container.querySelector<HTMLButtonElement>(
				".th-approval-dock-summary .th-approval-dock-toggle",
			);
			expect(expand).not.toBeNull();
			expect(expand?.getAttribute("aria-disabled")).toBeNull();
			expect(expand?.getAttribute("aria-label")).toBe("approval.expand");

			act(() => expand?.click());
			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();
			// Clamped to the measured budget (160 − 24 − 100 = 36, reserve fully
			// yielded) with the content scrolling inside the body, rendered in
			// the tight density that trades padding for answerability.
			expect(dock()?.style.maxHeight).toBe("36px");
			expect(dock()?.className).toContain("th-approval-dock--tight");

			const allow = Array.from(
				container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
			).find((button) => button.textContent === "Allow");
			act(() => allow?.click());
			expect(onRespond).toHaveBeenCalledTimes(1);
			expect(onRespond).toHaveBeenCalledWith({ value: "Allow" });
		});

		it("keeps the expand toggle operable in a manual collapse with space available", () => {
			renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow", "Block"] },
				{ column: 800, dock: 0 },
			);
			const collapse = container.querySelector<HTMLButtonElement>(
				'button[aria-label="approval.collapse"]',
			);
			act(() => collapse?.click());
			const expand = container.querySelector<HTMLButtonElement>(
				".th-approval-dock-summary .th-approval-dock-toggle",
			);
			expect(expand?.getAttribute("aria-disabled")).toBeNull();
			act(() => expand?.click());
			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();
		});

		it("clamps the expanded dock to the measured budget and refuses to shrink below it", () => {
			// Budget: 500 − 24 controls − 100 composer − 120 transcript reserve
			// = 256 (the reserve holds: the dock minimum already fits).
			renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow", "Block"] },
				{ column: 500, dock: 0 },
			);

			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();
			const section = dock();
			expect(section?.style.flexShrink).toBe("0");
			expect(section?.style.maxHeight).toBe("256px");
		});

		it("re-expands on its own when space returns after a floor collapse", () => {
			const { column } = renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow"] },
				{ column: 160, dock: 0 },
			);
			expect(container.querySelector(".th-approval-dock-body")).toBeNull();

			// Space returns: the panel comes back without another gesture.
			mockHeight(column, 800);
			triggerResize();
			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();
		});

		it("keeps a manual collapse collapsed when the column gains space", () => {
			const { column } = renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow"] },
				{ column: 800, dock: 0 },
			);
			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();

			act(() => {
				dock()?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
				);
			});
			expect(container.querySelector(".th-approval-dock-body")).toBeNull();

			mockHeight(column, 1000);
			triggerResize();
			expect(container.querySelector(".th-approval-dock-body")).toBeNull();
			expect(container.querySelector(".th-approval-dock-summary")).not.toBeNull();
		});

		it("does not move focus into an unrendered body when the floor collapses the dock", () => {
			renderDockInColumn({ id: "confirm-1", method: "confirm" }, { column: 160, dock: 0 });

			expect(container.querySelector(".th-approval-dock-body")).toBeNull();
			expect(document.activeElement?.closest(".th-approval-dock-body")).toBeNull();
		});

		it("leaves outside focus untouched when space-driven expansion opens the panel", () => {
			const { column } = renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow"] },
				{ column: 160, dock: 0 },
			);
			expect(container.querySelector(".th-approval-dock-body")).toBeNull();

			const outside = document.createElement("button");
			outside.type = "button";
			document.body.appendChild(outside);
			outside.focus();
			expect(document.activeElement).toBe(outside);

			// The column grows; the dock expands by itself. No user gesture, so
			// no focus move.
			mockHeight(column, 800);
			triggerResize();
			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();
			expect(document.activeElement).toBe(outside);
			outside.remove();
		});

		it("re-scrolls the focused control fully into view after the measured clamp shrinks the body", () => {
			const { column } = renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow", "Block"] },
				{ column: 800, dock: 0 },
			);
			const body = container.querySelector<HTMLElement>(".th-approval-dock-body");
			const primary = container.querySelector<HTMLElement>("[data-approval-primary]");
			expect(body).not.toBeNull();
			expect(document.activeElement).toBe(primary);

			// After the shrink the focused row hangs 30px below the visible
			// body slice; the re-measure must scroll it fully inside.
			mockRect(body as Element, 100, 100);
			mockRect(primary as Element, 190, 40);
			mockHeight(column, 400);
			triggerResize();
			expect(body?.scrollTop).toBe(30);

			// And again when a later re-measure leaves it clipped above.
			mockRect(primary as Element, 80, 20);
			mockHeight(column, 420);
			triggerResize();
			expect(body?.scrollTop).toBe(10);
		});

		it("counts the dock's own borders in the expansion floor", () => {
			renderDockInColumn(
				{ id: "select-1", method: "select", options: ["Allow"] },
				{ column: 172, dock: 0 },
			);
			// 172 − 24 − 100 = 48 for the dock: exactly the body floor with a
			// zero-height header and no borders, so borderless math expands.
			expect(container.querySelector(".th-approval-dock-body")).not.toBeNull();

			const section = dock();
			expect(section).not.toBeNull();
			(section as HTMLElement).style.borderTopWidth = "1px";
			(section as HTMLElement).style.borderBottomWidth = "1px";
			triggerResize();
			// With 2px of borders the body would be 46 — below the floor.
			expect(container.querySelector(".th-approval-dock-body")).toBeNull();
		});

		it.each([
			["zero", 124], // 124 − 24 controls − 100 composer = 0
			["a few pixels of", 129], // budget 5
		])(
			"never renders an unusable dock after an explicit expand with %s budget",
			(_label, columnHeight) => {
				renderDockInColumn(
					{ id: "select-1", method: "select", options: ["Allow", "Block"] },
					{ column: columnHeight, dock: 0 },
				);
				expect(container.querySelector(".th-approval-dock-body")).toBeNull();

				const expand = container.querySelector<HTMLButtonElement>(
					".th-approval-dock-summary .th-approval-dock-toggle",
				);
				act(() => expand?.click());

				const section = dock();
				expect(section).not.toBeNull();
				// The tight density is what keeps the box usable here.
				expect(section?.className).toContain("th-approval-dock--tight");
				expect(
					container.querySelector(".th-approval-dock-body"),
				).not.toBeNull();
				// The clamp can never produce an unusable panel: never "0px",
				// never below the tight usable minimum (header + one complete
				// option row + borders = 32px).
				const maxHeight = section?.style.maxHeight;
				expect(maxHeight).not.toBe("0px");
				expect(Number.parseInt(maxHeight ?? "0", 10)).toBeGreaterThanOrEqual(32);
			},
		);
	});
});
