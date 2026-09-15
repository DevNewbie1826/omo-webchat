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

	it("restores focus to the pane composer textarea when unmounted while focused", async () => {
		const pane = document.createElement("div");
		pane.className = "th-chat-pane";
		const composer = document.createElement("textarea");
		pane.appendChild(composer);
		pane.appendChild(container);
		document.body.appendChild(pane);

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

	it("returns focus to the pane composer textarea when collapsing", () => {
		const pane = document.createElement("div");
		pane.className = "th-chat-pane";
		const composer = document.createElement("textarea");
		pane.appendChild(composer);
		pane.appendChild(container);
		document.body.appendChild(pane);

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
});
