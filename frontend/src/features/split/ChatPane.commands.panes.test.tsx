import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	renderTwoChatComposers,
	requireElement,
	setTextareaValue,
} from "./chatPaneTestHarness";

const commands = [
	{
		name: "fix-tests",
		description: "Fix failing tests",
		source: "prompt",
		syntax: "slash",
		sourceInfo: { path: "/work/.omo/prompts/fix-tests.md" },
	},
	{
		name: "skill:demo",
		description: "Demo skill",
		source: "skill",
		syntax: "dollar",
		sourceInfo: { path: "~/.omo/skills/demo.md" },
	},
] as const;

describe("ChatPane command palette identity", () => {
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

	it("uses unique palette IDs and exact ARIA references for two split-pane composers", () => {
		renderTwoChatComposers(root, commands);

		const inputs = Array.from(
			container.querySelectorAll<HTMLTextAreaElement>("textarea"),
		);
		expect(inputs).toHaveLength(2);
		act(() => {
			for (const input of inputs) setTextareaValue(input, "$skill");
		});

		const listboxes = Array.from(
			container.querySelectorAll<HTMLElement>('[role="listbox"]'),
		);
		const options = Array.from(
			container.querySelectorAll<HTMLElement>('[role="option"]'),
		);
		expect(listboxes).toHaveLength(2);
		expect(new Set(listboxes.map((listbox) => listbox.id)).size).toBe(2);
		expect(new Set(options.map((option) => option.id)).size).toBe(
			options.length,
		);

		inputs.forEach((input, index) => {
			const listbox = requireElement(listboxes[index], "missing listbox");
			const firstOption = listbox.querySelector<HTMLElement>('[role="option"]');
			expect(input.getAttribute("aria-controls")).toBe(listbox.id);
			expect(input.getAttribute("aria-activedescendant")).toBe(firstOption?.id);
			expect(
				document.getElementById(input.getAttribute("aria-controls") ?? ""),
			).toBe(listbox);
			expect(
				document.getElementById(
					input.getAttribute("aria-activedescendant") ?? "",
				),
			).toBe(firstOption);
		});
	});
});
