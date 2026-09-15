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

/** The dock's minimal fallback for a request whose type this client cannot
 *  fully render: the request's text, a plain confirmation, free text, and
 *  always the explicit cancel control. */
describe("ApprovalDock unknown-request fallback", () => {
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

	const dock = (): HTMLElement | null => container.querySelector(".th-approval-dock");

	it("renders a visible entry naming the request and its text with the unsupported note", () => {
		renderDock({
			id: "u1",
			method: "fallback",
			title: "Deploy to prod?",
			message: "Approve the rollout",
		});

		expect(dock()).not.toBeNull();
		expect(dock()?.textContent).toContain("Deploy to prod?");
		expect(dock()?.textContent).toContain("Approve the rollout");
		expect(container.querySelector(".th-approval-fallback-note")?.textContent).toContain(
			"approval.unsupportedNote",
		);
	});

	it("answers with plain confirmation, free text, and always cancel", () => {
		const onRespond = vi.fn();
		renderDock({ id: "u1", method: "fallback", title: "Deploy?" }, onRespond);

		const form = container.querySelector("form.th-approval-form");
		expect(form).not.toBeNull();
		const labels = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-dock button"),
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

	it("collapses on Escape and keeps the request visible in the summary", () => {
		const onRespond = vi.fn();
		renderDock({ id: "u1", method: "fallback", title: "Deploy to prod?" }, onRespond);

		act(() => {
			dock()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});

		expect(onRespond).not.toHaveBeenCalled();
		const summary = container.querySelector(".th-approval-dock-summary");
		expect(summary?.textContent).toContain("Deploy to prod?");
		expect(summary?.textContent).toContain("approval.pending");
		expect(container.querySelector(".th-approval-fallback-note")).toBeNull();
	});

	it("keeps the known select rendering exactly as before", () => {
		renderDock({ id: "s1", method: "select", title: "Run tests?", options: ["Allow", "Block"] });

		expect(container.querySelector(".th-approval-fallback-note")).toBeNull();
		const options = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-options button"),
		);
		expect(options.map((button) => button.textContent)).toEqual([
			"Allow",
			"Block",
			"approval.cancel",
		]);
	});
});
