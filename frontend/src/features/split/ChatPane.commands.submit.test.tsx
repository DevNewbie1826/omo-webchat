import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	chatSession,
	pressKey,
	renderChatPane,
	requireElement,
	setTextareaValue,
} from "./chatPaneTestHarness";

describe("ChatPane slash command submission", () => {
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

	it("inserts a selected slash command without sending, then submits it explicitly once", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
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
						sourceInfo: { path: "/work/.omo/prompts/fix-tests.md" },
					},
					{
						name: "skill:demo",
						description: "Demo skill",
						source: "skill",
						syntax: "dollar",
						sourceInfo: { path: "~/.omo/skills/demo.md" },
					},
				],
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "$skill");
		});
		act(() => {
			pressKey(input, "Enter");
		});

		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
		expect(input.value).toBe("$skill:demo ");
		expect(document.activeElement).toBe(input);

		act(() => {
			pressKey(input, "Enter");
		});
		const chatSends = sent.filter((frame) => frame.type === "chat.send");
		expect(chatSends).toHaveLength(1);
		expect(chatSends[0]).toEqual({
			type: "chat.send",
			sessionId: "chat-1",
			run: { kind: "prompt", message: "$skill:demo" },
		});
		expect(container.querySelector('[role="listbox"]')).toBeNull();
	});

	it("submits an exact /compact as the dedicated RPC, not a prompt", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => {
			deliver({
				type: "commands",
				sessionId: "chat-1",
				commands: [],
			});
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "/compact");
		});
		act(() => {
			// Escape dismisses the curated palette entry so the raw text is
			// submitted — the interception must still route it to the RPC.
			pressKey(input, "Escape");
		});
		act(() => {
			pressKey(input, "Enter");
		});

		expect(sent.filter((frame) => frame.type === "chat.compact")).toEqual([
			{ type: "chat.compact", sessionId: "chat-1" },
		]);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
		expect(
			container.querySelectorAll(".th-chat-msg--user"),
		).toHaveLength(0);
		expect(input.value).toBe("");
	});

	it("never hijacks a provider-advertised compact command", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => deliver({
			type: "commands",
			sessionId: "chat-1",
			commands: [{ name: "compact", description: "Provider compact", source: "extension", syntax: "slash" }],
		}));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		act(() => setTextareaValue(input, "/"));
		act(() => pressKey(input, "Enter"));
		expect(input.value).toBe("/compact ");
		expect(sent.filter((frame) => frame.type === "chat.compact")).toHaveLength(0);

		act(() => pressKey(input, "Enter"));
		expect(sent.filter((frame) => frame.type === "chat.compact")).toHaveLength(0);
		expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
			{ type: "chat.send", sessionId: "chat-1", run: { kind: "prompt", message: "/compact" } },
		]);
	});

	it("keeps a curated compact selection authoritative through a later command refresh", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => deliver({ type: "commands", sessionId: "chat-1", commands: [] }));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		act(() => setTextareaValue(input, "/"));
		act(() => pressKey(input, "Enter"));
		expect(input.value).toBe("/compact ");
		act(() => deliver({
			type: "commands",
			sessionId: "chat-1",
			commands: [{ name: "compact", source: "extension", syntax: "slash" }],
		}));

		act(() => pressKey(input, "Enter"));
		expect(sent.filter((frame) => frame.type === "chat.compact")).toEqual([
			{ type: "chat.compact", sessionId: "chat-1" },
		]);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
	});

	it("opens and inserts dollar skills with provider identity intact", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => deliver({
			type: "commands",
			sessionId: "chat-1",
			commands: [{
				name: "skill:demo",
				description: "Demo skill",
				source: "skill",
				syntax: "dollar",
				sourceInfo: { path: "~/.omo/skills/demo.md", source: "skill" },
			}],
		}));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		act(() => setTextareaValue(input, "$"));
		const option = requireElement(container.querySelector<HTMLElement>('[role="option"]'), "missing dollar skill");
		expect(option.textContent).toContain("$skill:demo");
		expect(option.textContent).toContain("~/.omo/skills/demo.md");
		act(() => pressKey(input, "Enter"));
		expect(input.value).toBe("$skill:demo ");
		expect(document.activeElement).toBe(input);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);

		act(() => pressKey(input, "Enter"));
		expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
			{ type: "chat.send", sessionId: "chat-1", run: { kind: "prompt", message: "$skill:demo" } },
		]);
	});

	it("keeps dollar skills out of the slash palette", () => {
		const { deliver } = renderChatPane(root, chatSession);
		act(() => deliver({
			type: "commands",
			sessionId: "chat-1",
			commands: [
				{ name: "fix-tests", syntax: "slash" },
				{ name: "skill:demo", syntax: "dollar", sourceInfo: { path: "~/.omo/skills/demo.md" } },
			],
		}));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		act(() => setTextareaValue(input, "/"));
		const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
		expect(options.some((option) => option.textContent?.includes("skill:demo"))).toBe(false);
		expect(options.some((option) => option.textContent?.includes("/fix-tests"))).toBe(true);
	});

	it("gates prompt submission and optimistic UI while compacting", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => deliver({ type: "compaction.started", sessionId: "chat-1" }));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing chat input");
		const send = requireElement(container.querySelector<HTMLButtonElement>(".th-chat-send-btn"), "missing send button");
		expect(input.disabled).toBe(true);
		expect(send.disabled).toBe(true);
		act(() => setTextareaValue(input, "not during compact"));
		act(() => pressKey(input, "Enter"));
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);
		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(input.value).toBe("not during compact");

		act(() => deliver({ type: "compaction.done", sessionId: "chat-1" }));
		expect(input.disabled).toBe(false);
		act(() => pressKey(input, "Enter"));
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);
	});

	it("keeps /compact with arguments on the prompt path", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => {
			deliver({ type: "commands", sessionId: "chat-1", commands: [] });
		});

		const input = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!input) throw new Error("missing chat input");

		act(() => {
			setTextareaValue(input, "/compact aggressive");
		});
		act(() => {
			pressKey(input, "Escape");
		});
		act(() => {
			pressKey(input, "Enter");
		});

		const chatSends = sent.filter((frame) => frame.type === "chat.send");
		expect(chatSends).toEqual([
			{
				type: "chat.send",
				sessionId: "chat-1",
				run: { kind: "prompt", message: "/compact aggressive" },
			},
		]);
		expect(sent.filter((frame) => frame.type === "chat.compact")).toHaveLength(0);
	});
});
