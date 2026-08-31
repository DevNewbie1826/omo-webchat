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

	it("never duplicates a provider-advertised compact command", () => {
		const { deliver } = renderChatPane(root);
		const commands = Array.from({ length: 12 }, (_, index) =>
			index === 4
				? {
						name: "compact",
						description: "Provider compaction",
						source: "extension",
						syntax: "slash",
					}
				: {
						name: `command-${String(index + 1).padStart(2, "0")}`,
						description: `Command ${index + 1}`,
					},
		);
		act(() => {
			deliver({ type: "commands", sessionId: "chat-1", commands });
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
		// The discovered compact stands in for the curated one: the palette
		// lists exactly what the provider advertised, no duplicate row.
		expect(options).toHaveLength(12);
		const compactOptions = options.filter((option) =>
			option.textContent?.includes("/compact"),
		);
		expect(compactOptions).toHaveLength(1);
		expect(compactOptions[0]).toBe(options[4]);
		expect(compactOptions[0]?.textContent).toContain("Provider compaction");
	});

	it("selects curated compact as draft text and dispatches only on explicit submit", () => {
		const { deliver, sent } = renderChatPane(root);
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [{ name: "hooks", description: "Inspect hooks", source: "extension", syntax: "slash" }],
			});
		});

		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		act(() => setTextareaValue(input, "/"));
		act(() => pressKey(input, "ArrowDown"));
		act(() => pressKey(input, "Enter"));

		expect(sent.filter((frame) => frame.type === "chat.compact")).toHaveLength(0);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
		expect(input.value).toBe("/compact ");
		expect(document.activeElement).toBe(input);
		expect(container.querySelector('[role="listbox"]')).toBeNull();

		act(() => pressKey(input, "Enter"));
		expect(sent.filter((frame) => frame.type === "chat.compact")).toEqual([
			{ type: "chat.compact", sessionId: "chat-1" },
		]);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(input.value).toBe("");
	});

	it("gives pointer selection the same insert-then-submit compact behavior", () => {
		const { deliver, sent } = renderChatPane(root);
		act(() => deliver({ type: "commands", sessionId: "chat-1", commands: [] }));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		act(() => setTextareaValue(input, "/"));
		const option = requireElement(container.querySelector<HTMLButtonElement>('[role="option"]'), "missing compact option");
		act(() => option.click());

		expect(input.value).toBe("/compact ");
		expect(document.activeElement).toBe(input);
		expect(sent.filter((frame) => frame.type === "chat.compact")).toHaveLength(0);

		const send = requireElement(container.querySelector<HTMLButtonElement>(".th-chat-send-btn"), "missing send button");
		act(() => send.click());
		expect(sent.filter((frame) => frame.type === "chat.compact")).toEqual([
			{ type: "chat.compact", sessionId: "chat-1" },
		]);
	});

});
