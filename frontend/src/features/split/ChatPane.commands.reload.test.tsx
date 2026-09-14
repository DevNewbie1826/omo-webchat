import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatServerFrame, CommandEntry } from "../../lib/chatWs";
import { pressKey, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

const historyLoaded: ChatServerFrame = { type: "entries", sessionId: "chat-1", entries: [], final: true };

function frames(sent: readonly ChatClientFrame[], type: ChatClientFrame["type"], from = 0): ChatClientFrame[] {
	return sent.slice(from).filter((frame) => frame.type === type);
}

function promptTexts(sent: readonly ChatClientFrame[], from = 0): string[] {
	return frames(sent, "chat.send", from).map((frame) => (frame as { run: { message: string } }).run.message);
}

describe("ChatPane /reload command", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
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

	function mount(commands: readonly CommandEntry[] = []) {
		const rendered = renderChatPane(root);
		act(() => {
			rendered.deliver({ type: "commands", sessionId: "chat-1", commands });
			rendered.deliver(historyLoaded);
		});
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		return { ...rendered, input };
	}

	// Typing an exact slash command opens the palette, so the first Enter
	// inserts the row and the second Enter submits, exactly like /compact.
	function typeAndSubmit(input: HTMLTextAreaElement, text: string): void {
		act(() => setTextareaValue(input, text));
		if (container.querySelector('[role="option"]')) act(() => pressKey(input, "Enter"));
		act(() => pressKey(input, "Enter"));
	}

	it("re-attaches the session on exact /reload instead of sending a prompt", () => {
		const { sent, input } = mount();
		const before = sent.length;
		typeAndSubmit(input, "/reload");

		expect(frames(sent, "chat.send", before)).toHaveLength(0);
		expect(frames(sent, "chat.close", before)).toEqual([{ type: "chat.close", sessionId: "chat-1" }]);
		expect(frames(sent, "chat.create", before)).toEqual([{ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" }]);
		expect(input.value).toBe("");
	});

	it("shows the curated /reload row with its localized description", () => {
		const { input } = mount();
		act(() => setTextareaValue(input, "/rel"));
		const option = requireElement(container.querySelector<HTMLButtonElement>('[role="option"]'), "missing reload option");
		expect(option.textContent).toContain("/reload");
		expect(option.textContent).toContain("chat.reloadDescription");
	});

	it.each(["/reload now", "please /reload it"])("keeps %j on the prompt path", (text) => {
		const { sent, input } = mount();
		const before = sent.length;
		typeAndSubmit(input, text);
		expect(frames(sent, "chat.close", before)).toHaveLength(0);
		expect(promptTexts(sent, before)).toEqual([text]);
	});

	it("lets a provider-advertised /reload stay authoritative", () => {
		const { sent, input } = mount([
			{ name: "reload", description: "Provider reload", source: "extension", syntax: "slash" },
		]);
		act(() => setTextareaValue(input, "/"));
		const reloadRows = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
			.filter((option) => option.textContent?.includes("/reload"));
		expect(reloadRows).toHaveLength(1);
		expect(reloadRows[0]?.textContent).toContain("Provider reload");

		const before = sent.length;
		typeAndSubmit(input, "/reload");
		expect(frames(sent, "chat.close", before)).toHaveLength(0);
		expect(promptTexts(sent, before)).toEqual(["/reload"]);
	});

	it("refuses /reload while the assistant is responding and never steers it into the model", () => {
		const { sent, input, deliver } = mount();
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		const before = sent.length;
		act(() => setTextareaValue(input, "/reload"));
		act(() => pressKey(input, "Enter")); // palette insert only
		expect(input.value).toBe("/reload ");
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));

		expect(frames(sent, "chat.send", before)).toHaveLength(0);
		expect(frames(sent, "chat.close", before)).toHaveLength(0);
		expect(input.value).toBe("/reload ");
		expect(container.textContent).toContain("chat.resyncBusyResponding");
	});
});
