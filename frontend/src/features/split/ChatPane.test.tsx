import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

const chatSession = {
	id: "chat-1",
	name: "Chat 1",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("ChatPane streaming", () => {
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

	it("renders text deltas live and retains the finalized assistant message", async () => {
		let deliver: ((frame: ChatServerFrame) => void) | undefined;
		const send = vi.fn(() => true);
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return { send, close: vi.fn() };
		};

		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatPane
						chatSession={chatSession}
						focused
						splitEnabled={false}
						onFocus={() => undefined}
						onSplit={() => undefined}
						onClose={() => undefined}
						onOpenSidebar={() => undefined}
						connect={connect}
						notify={() => undefined}
					/>
				</I18nContext.Provider>,
			);
		});

		act(() => {
			deliver?.({
				type: "models",
				sessionId: "chat-1",
				models: [
					{ provider: "alpha", modelId: "shared", name: "Shared A" },
					{ provider: "beta", modelId: "shared", name: "Shared B" },
				],
			});
			deliver?.({
				type: "state",
				sessionId: "chat-1",
				isStreaming: false,
				isCompacting: false,
				model: { provider: "beta", modelId: "shared" },
			});
		});
		const pickerBtn = container.querySelector<HTMLButtonElement>(".th-model-picker-btn");
		expect(pickerBtn?.textContent).toContain("Shared B");

		act(() => pickerBtn?.click());
		const options = Array.from(
			container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
		);
		expect(options).toHaveLength(2);
		const alphaOption = options.find((opt) => opt.textContent?.includes("Shared A"));
		if (!alphaOption) throw new Error("missing alpha option");
		act(() => alphaOption.click());
		expect(send).toHaveBeenLastCalledWith({
			type: "chat.set",
			sessionId: "chat-1",
			requestId: expect.any(String),
			model: { provider: "alpha", modelId: "shared" },
		});

		await act(async () => {
			deliver?.({
				type: "ready",
				sessionId: "chat-1",
				piSessionId: null,
				resumed: false,
			});
			deliver?.({
				type: "messageDelta",
				sessionId: "chat-1",
				messageId: "message-1",
				delta: { kind: "text_delta", contentIndex: 0, delta: "Hello " },
			});
			deliver?.({
				type: "messageDelta",
				sessionId: "chat-1",
				messageId: "message-1",
				delta: { kind: "text_delta", contentIndex: 0, delta: "world" },
			});
		});
		expect(container.textContent).toContain("Hello world");

		act(() => {
			deliver?.({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [
						{
							kind: "thinking",
							id: "thought-1",
							thinking: "First private thought",
						},
						{
							kind: "thinking",
							id: "thought-2",
							text: "Second private thought",
						},
						{ kind: "text", id: "answer-1", text: "Hello world" },
					],
					model: "claude",
					usage: {},
					ts: 1,
				},
			});
			deliver?.({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		expect(container.textContent).toContain("Hello world");
		const finalizedThinking = Array.from(
			container.querySelectorAll<HTMLDetailsElement>(
				".th-chat-history .th-chat-thinking",
			),
		);
		expect(finalizedThinking).toHaveLength(2);
		expect(finalizedThinking.every((details) => !details.open)).toBe(true);
		expect(
			finalizedThinking.map(
				(details) => details.querySelector("summary")?.textContent,
			),
		).toEqual(["chat.thinking", "chat.thinking"]);
		expect(
			finalizedThinking.map(
				(details) => details.querySelector("pre")?.textContent,
			),
		).toEqual(["First private thought", "Second private thought"]);
		expect(container.textContent).toContain("chat.done");
	});
});
