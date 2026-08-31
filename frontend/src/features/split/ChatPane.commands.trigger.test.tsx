import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pressKey,
	renderChatPane,
	setTextareaValue,
} from "./chatPaneTestHarness";

describe("ChatPane commands", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: vi.fn(),
		});
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
		Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	});

	it.each(["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"])(
		"does not intercept %s during Korean IME composition",
		(key) => {
			const { deliver, sent } = renderChatPane(root);
			act(() =>
				deliver({
					type: "commands",
					sessionId: "chat-1",
					commands: [{ name: "테스트", description: "Korean command" }],
				}),
			);
			const input = container.querySelector<HTMLTextAreaElement>("textarea");
			if (!input) throw new Error("missing chat input");
			act(() => setTextareaValue(input, "/테"));
			const activeDescendant = input.getAttribute("aria-activedescendant");

			let keyEvent: KeyboardEvent | undefined;
			act(() => {
				keyEvent = pressKey(input, key, { isComposing: true });
			});

			expect(keyEvent?.defaultPrevented).toBe(false);
			expect(input.value).toBe("/테");
			expect(input.getAttribute("aria-activedescendant")).toBe(
				activeDescendant,
			);
			expect(container.querySelector('[role="listbox"]')).not.toBeNull();
			expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(
				0,
			);
		},
	);

	it("opens the command palette from mid-message and inserts at the trigger", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [
					{ name: "clear", description: "Clear conversation" },
				],
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "hello /");
		});

		expect(container.querySelector('[role="listbox"]')).not.toBeNull();
		const options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		expect(options.length).toBeGreaterThan(0);

		act(() => {
			pressKey(input, "Enter");
		});

		expect(input.value).toBe("hello /clear ");
	});

	it("does not open the palette when / is inside a word", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [{ name: "clear", description: "Clear" }],
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "hello/world");
		});

		expect(container.querySelector('[role="listbox"]')).toBeNull();
	});

	it("does not insert a duplicate space when the command is followed by text", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [{ name: "clear", description: "Clear conversation" }],
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "hello /cl tail");
		});

		// Move caret to right after "cl" (position 9), before the space.
		act(() => {
			input.setSelectionRange(9, 9);
			input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});

		expect(container.querySelector('[role="listbox"]')).not.toBeNull();

		act(() => {
			pressKey(input, "Enter");
		});

		expect(input.value).toBe("hello /clear tail");
	});
});
