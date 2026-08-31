import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest } from "./ApprovalModal";
import { ApprovalModal } from "./ApprovalModal";

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

const requests: Record<ApprovalRequest["method"], ApprovalRequest> = {
	select: { id: "select-1", method: "select", options: ["Allow", "Block"] },
	confirm: { id: "confirm-1", method: "confirm" },
	input: { id: "input-1", method: "input", prefill: "answer" },
	editor: { id: "editor-1", method: "editor", prefill: "multiple\nlines" },
};

describe("ApprovalModal dialog behavior", () => {
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

	function renderModal(request: ApprovalRequest, onRespond = vi.fn()): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ApprovalModal request={request} onRespond={onRespond} />
				</I18nContext.Provider>,
			);
		});
	}

	it.each([
		["select", "button", "Allow"],
		["confirm", "button", "approval.confirm"],
		["input", "input", "answer"],
		["editor", "textarea", "multiple\nlines"],
	] as const)("focuses the primary %s control", (method, tagName, value) => {
		renderModal(requests[method]);

		expect(
			document.querySelector('[role="dialog"]')?.getAttribute("aria-modal"),
		).toBe("true");
		expect(document.activeElement?.tagName.toLowerCase()).toBe(tagName);
		const content =
			tagName === "button"
				? document.activeElement?.textContent
				: (document.activeElement as HTMLInputElement | HTMLTextAreaElement)
						.value;
		expect(content).toBe(value);
	});

	it("gives stacked approvals unique, self-referencing title IDs", () => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ApprovalModal request={{ ...requests.confirm, title: "First" }} onRespond={vi.fn()} />
					<ApprovalModal request={{ ...requests.confirm, title: "Second" }} onRespond={vi.fn()} />
				</I18nContext.Provider>,
			);
		});

		const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
		expect(dialogs).toHaveLength(2);
		const labels = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
		expect(labels[0]).toBeTruthy();
		expect(labels[1]).toBeTruthy();
		expect(labels[0]).not.toBe(labels[1]);

		const titles = labels.map((label) => document.getElementById(label ?? ""));
		expect(titles[0]?.textContent).toBe("First");
		expect(titles[1]?.textContent).toBe("Second");
	});

	it("traps forward and reverse Tab navigation", () => {
		renderModal(requests.select);
		const close = document.querySelector<HTMLButtonElement>(".th-modal-close");
		const actions = document.querySelectorAll<HTMLButtonElement>(
			".th-approval-options button",
		);
		const last = actions[actions.length - 1];
		if (!close || !last) throw new Error("missing approval controls");

		last.focus();
		act(() =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Tab",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(document.activeElement).toBe(close);

		close.focus();
		act(() =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Tab",
					shiftKey: true,
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(document.activeElement).toBe(last);
	});

	it("cancels on Escape and restores focus to the opener", () => {
		const onRespond = vi.fn();
		function Harness() {
			const [request, setRequest] = useState<ApprovalRequest | null>(null);
			return (
				<I18nContext.Provider value={i18n}>
					<button type="button" onClick={() => setRequest(requests.confirm)}>
						Open approval
					</button>
					{request && (
						<ApprovalModal
							request={request}
							onRespond={(response) => {
								onRespond(response);
								setRequest(null);
							}}
						/>
					)}
				</I18nContext.Provider>
			);
		}
		act(() => root.render(<Harness />));
		const opener = container.querySelector<HTMLButtonElement>("button");
		opener?.focus();
		act(() => opener?.click());
		expect(document.activeElement?.textContent).toBe("approval.confirm");

		act(() =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Escape",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(opener);
	});
});
