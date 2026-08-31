import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame } from "../../lib/chatWs";
import {
	ControlledResizeObserver,
	longChatSession,
	pressKey,
	renderChatPane,
	setTextareaValue,
} from "./chatPaneTestHarness";

function isChatSend(
	frame: ChatClientFrame,
): frame is Extract<ChatClientFrame, { type: "chat.send" }> {
	return frame.type === "chat.send";
}

function chatSends(sent: readonly ChatClientFrame[]) {
	return sent.filter(isChatSend);
}

describe("ChatPane composer, echo reconciliation, and layout", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: ReturnType<typeof renderChatPane>["deliver"];
	let sent: ReturnType<typeof renderChatPane>["sent"];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => undefined)),
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		({ deliver, sent } = renderChatPane(root, longChatSession));
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		ControlledResizeObserver.instances = [];
		container.remove();
		vi.unstubAllGlobals();
	});

	function textarea(): HTMLTextAreaElement {
		const element = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!element) throw new Error("missing chat textarea");
		return element;
	}

	it("uses a multiline textarea: Shift+Enter adds a newline and Enter sends once", () => {
		const input = textarea();
		expect(input.rows).toBe(1);

		act(() => setTextareaValue(input, "line one"));
		act(() => pressKey(input, "Enter", { shiftKey: true }));
		expect(chatSends(sent)).toHaveLength(0);

		act(() => setTextareaValue(input, "line one\nline two"));
		act(() => pressKey(input, "Enter"));
		expect(chatSends(sent)).toHaveLength(1);
		expect(chatSends(sent)[0]).toMatchObject({
			type: "chat.send",
			run: { message: "line one\nline two" },
		});
	});

	it("keeps the palette attached to the composer and the file panel outside chat-main", () => {
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [{ name: "fix-tests", description: "Fix tests" }],
			});
		});
		act(() => setTextareaValue(textarea(), "/"));

		const palette = container.querySelector(".th-chat-slash");
		const composerInner = container.querySelector(".th-chat-input-inner");
		const slashInput = textarea();
		expect(palette?.parentElement).toBe(composerInner);
		expect(slashInput.getAttribute("role")).toBe("combobox");
		expect(slashInput.getAttribute("aria-expanded")).toBe("true");
		const listbox = container.querySelector<HTMLElement>("[role='listbox']");
		const firstOption = listbox?.querySelector<HTMLElement>("[role='option']");
		expect(listbox).not.toBeNull();
		expect(slashInput.getAttribute("aria-controls")).toBe(listbox?.id);
		expect(slashInput.getAttribute("aria-activedescendant")).toBe(
			firstOption?.id,
		);
		expect(
			document.getElementById(slashInput.getAttribute("aria-controls") ?? ""),
		).toBe(listbox);
		expect(
			document.getElementById(
				slashInput.getAttribute("aria-activedescendant") ?? "",
			),
		).toBe(firstOption);

		const pane = container.querySelector<HTMLElement>(".th-chat-pane");
		const main = container.querySelector<HTMLElement>(".th-chat-main");
		const fileToggle =
			container.querySelector<HTMLButtonElement>(".th-files-toggle");
		if (!pane || !main || !fileToggle) throw new Error("missing layout hooks");
		act(() => fileToggle.click());

		expect(main.parentElement).toBe(pane);
		expect(container.querySelector(".th-files")?.parentElement).toBe(pane);
		expect(main.className).toBe("th-chat-main");
	});

	it("restores 60 messages at the bottom, follows growth, and exposes scroll intent", () => {
		const body = container.querySelector<HTMLDivElement>(".th-chat-body");
		if (!body) throw new Error("missing scrollport");
		let scrollHeight = 4_800;
		Object.defineProperties(body, {
			clientHeight: { configurable: true, get: () => 400 },
			scrollHeight: { configurable: true, get: () => scrollHeight },
			scrollTop: { configurable: true, writable: true, value: 0 },
		});

		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: Array.from({ length: 60 }, (_, index) => ({
					type: "message",
					message: {
						role: index % 2 ? "assistant" : "user",
						content: `restored ${index}`,
					},
				})),
			});
		});
		expect(body.scrollTop).toBe(4_800);
		act(() => body.dispatchEvent(new Event("scroll", { bubbles: true })));

		scrollHeight = 5_000;
		const content = container.querySelector<HTMLElement>(".th-chat-content");
		if (!content) throw new Error("missing observed chat content");
		act(() => ControlledResizeObserver.trigger(content));
		expect(body.scrollTop).toBe(5_000);
		act(() => body.dispatchEvent(new Event("scroll", { bubbles: true })));

		act(() => {
			body.scrollTop = 3_000;
			body.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		const scrollButton = container.querySelector<HTMLButtonElement>(
			".th-chat-scroll-bottom",
		);
		expect(scrollButton).not.toBeNull();
		expect(scrollButton?.getAttribute("aria-label")).toBe(
			"chat.scrollToBottom",
		);

		scrollHeight = 5_200;
		act(() => ControlledResizeObserver.trigger(content));
		expect(body.scrollTop).toBe(3_000);

		act(() => scrollButton?.click());
		expect(body.scrollTop).toBe(5_200);
		expect(container.querySelector(".th-chat-scroll-bottom")).toBeNull();
	});
});
