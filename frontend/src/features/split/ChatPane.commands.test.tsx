import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pressKey,
	renderChatPane,
	requireElement,
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

	it("shows a command palette with pointer and keyboard navigation", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [
					{
						name: "fix-tests",
						description: "Fix failing tests",
						source: "prompt",
						syntax: "slash",
						sourceInfo: {
							path: "/work/.omo/prompts/fix-tests.md",
							source: "prompt",
							scope: "project",
							origin: "top-level",
						},
					},
					{
						name: "skill:demo",
						description: "Demo skill",
						source: "skill",
						syntax: "dollar",
						sourceInfo: { path: "~/.omo/skills/demo.md" },
					},
					// A compact advertised by get_commands renders like any other
					// discovered command and suppresses the curated entry (no duplicate).
					{
						name: "compact",
						description: "Compact the conversation",
						source: "builtin",
						syntax: "slash",
					},
				],
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "/");
		});

		const listbox = requireElement(
			container.querySelector<HTMLElement>('[role="listbox"]'),
			"missing listbox",
		);
		let options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		expect(options).toHaveLength(2);
		const firstOption = requireElement(options[0], "missing first option");
		const secondOption = requireElement(options[1], "missing second option");
		expect(firstOption.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(firstOption.id);
		expect(input.getAttribute("aria-controls")).toBe(listbox.id);

		act(() => {
			secondOption.dispatchEvent(
				new MouseEvent("mousemove", { bubbles: true }),
			);
		});
		options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		const hoveredOption = requireElement(options[1], "missing hovered option");
		expect(hoveredOption.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(hoveredOption.id);
		expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({
			block: "nearest",
		});

		act(() => {
			pressKey(input, "ArrowUp");
		});
		options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		const wrappedFirstOption = requireElement(
			options[0],
			"missing wrapped first option",
		);
		expect(wrappedFirstOption.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(
			wrappedFirstOption.id,
		);

		act(() => {
			pressKey(input, "ArrowDown");
		});
		options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		const wrappedSecondOption = requireElement(
			options[1],
			"missing wrapped second option",
		);
		expect(wrappedSecondOption.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(
			wrappedSecondOption.id,
		);

		act(() => {
			pressKey(input, "Escape");
		});
		expect(container.querySelector('[role="listbox"]')).toBeNull();
	});

	it("shows every provider command with pointer and keyboard navigation", () => {
		const { deliver } = renderChatPane(root);
		const commands = Array.from({ length: 12 }, (_, index) => ({
			name: `command-${String(index + 1).padStart(2, "0")}`,
			description: `Command ${index + 1}`,
		}));
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands,
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "/");
		});

		const options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		expect(options).toHaveLength(13);
		// The curated compact action rides behind the provider list: every
		// get_commands entry keeps its slot, and /compact appears exactly once.
		const compactOptions = options.filter((option) =>
			option.textContent?.includes("/compact"),
		);
		expect(compactOptions).toHaveLength(1);
		expect(compactOptions[0]).toBe(options[12]);
		const firstOption = requireElement(options[0], "missing first option");
		const lastProviderOption = requireElement(
			options[11],
			"missing last provider option",
		);
		expect(firstOption.textContent).toContain("/command-01");
		expect(lastProviderOption.textContent).toContain("/command-12");
		expect(firstOption.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(firstOption.id);

		for (let index = 0; index < 11; index += 1) {
			act(() => {
				pressKey(input, "ArrowDown");
			});
		}
		expect(lastProviderOption.getAttribute("aria-selected")).toBe("true");
		expect(input.getAttribute("aria-activedescendant")).toBe(
			lastProviderOption.id,
		);
		expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({
			block: "nearest",
		});

		act(() => {
			pressKey(input, "Enter");
		});
		expect(input.value).toBe("/command-12 ");
	});

});
