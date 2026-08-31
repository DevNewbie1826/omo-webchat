import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
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
const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

function enterPrompt(input: HTMLTextAreaElement, text: string): void {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("missing textarea value setter");
	setter.call(input, text);
	input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
	input.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		}),
	);
}

describe("ChatPane release contracts", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: (frame: ChatServerFrame) => void;
	let disconnect: () => void;
	let reconnect: () => void;
	let sent: ChatClientFrame[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sent = [];
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			disconnect = () => handlers.onClose?.(1006);
			reconnect = () => handlers.onOpen?.();
			handlers.onOpen?.();
			return {
				send: (frame) => {
					sent.push(frame);
					return true;
				},
				close: vi.fn(),
			};
		};
		act(() =>
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatPane
						chatSession={session}
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
			),
		);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	function submit(text: string): void {
		const input = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!input) throw new Error("missing textarea");
		act(() => enterPrompt(input, text));
	}

	it("rolls back the prompt RPC that owns the optimistic run", () => {
		submit("provider retry");
		act(() =>
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "provider_error",
				command: "prompt",
				message: "Prompt rejected",
			}),
		);

		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(
			container.querySelector<HTMLTextAreaElement>("textarea")?.value,
		).toBe("provider retry");
		expect(
			container.querySelector<HTMLButtonElement>('button[type="submit"]')
				?.textContent,
		).toBe("chat.send");
	});

	it.each(["start_failed", "no_session"] as const)(
		"rolls back an active prompt for terminal %s transport state",
		(code) => {
			submit("transport retry");
			act(() =>
				deliver({
					type: "error",
					sessionId: "chat-1",
					code,
					message: "Transport stopped",
				}),
			);

			expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
			expect(
				container.querySelector<HTMLTextAreaElement>("textarea")?.value,
			).toBe("transport retry");
			expect(
				container.querySelector<HTMLButtonElement>('button[type="submit"]')
					?.textContent,
			).toBe("chat.send");
		},
	);

	it.each(["decode_failed", "provider_overflow", "provider_timeout"] as const)(
		"clears the active run, optimistic message, and submit latch for terminal %s",
		(code) => {
			submit("terminated prompt");
			expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(1);
			expect(container.querySelector(".th-btn--danger")?.textContent).toBe(
				"chat.stop",
			);

			act(() =>
				deliver({
					type: "error",
					sessionId: "chat-1",
					code,
					message: "Provider terminated",
				}),
			);

			expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
			expect(container.querySelector(".th-btn--danger")).toBeNull();
			expect(
				container.querySelector<HTMLButtonElement>('button[type="submit"]')
					?.textContent,
			).toBe("chat.send");
			expect(
				container.querySelector<HTMLTextAreaElement>("textarea")?.value,
			).toBe("terminated prompt");

			submit("retry after termination");
			expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(
				2,
			);
			expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(1);
		},
	);

	it.each(["set_model", "set_thinking_level", "query"] as const)(
		"alerts for failed %s without changing the active run",
		(command) => {
			submit("still running");
			act(() =>
				deliver({
					type: "error",
					sessionId: "chat-1",
					code: "provider_error",
					command,
					message: `${command} rejected`,
				}),
			);

			expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(1);
			expect(
				container.querySelector<HTMLTextAreaElement>("textarea")?.value,
			).toBe("");
			expect(container.querySelector('[role="alert"]')?.textContent).toBe(
				`${command} rejected`,
			);
			expect(container.querySelector(".th-btn--danger")?.textContent).toBe(
				"chat.stop",
			);
			expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(
				1,
			);
		},
	);

	it("cleans transient state when reconnect history restores a dropped completed turn", () => {
		submit("restore completed");
		act(() => {
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				delta: { kind: "text_delta", delta: "stale live reply" },
			});
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				delta: { kind: "thinking_delta", delta: "stale thought" },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "stale-tool",
				toolName: "bash",
				phase: "update",
				partial: { content: [{ text: "stale output" }] },
			});
			disconnect();
			reconnect();
			deliver({
				type: "state",
				sessionId: "chat-1",
				isStreaming: false,
				isCompacting: false,
			});
		});
		const restored: ChatServerFrame = {
			type: "entries",
			sessionId: "chat-1",
			entries: [
				{
					type: "message",
					message: { role: "user", content: "restore completed", timestamp: 1 },
				},
				{
					type: "message",
					message: { role: "assistant", content: "stored reply", timestamp: 2 },
				},
			],
		};
		act(() => deliver(restored));

		expect(
			container.querySelectorAll(".th-chat-history .th-chat-msg--user"),
		).toHaveLength(2);
		expect(
			container.querySelectorAll(".th-chat-history .th-chat-msg--assistant"),
		).toHaveLength(1);
		expect(
			container.querySelector(
				".th-chat-msg--streaming, .th-chat-thinking, .th-tool",
			),
		).toBeNull();
		expect(
			container.querySelector<HTMLButtonElement>('button[type="submit"]')
				?.textContent,
		).toBe("chat.send");
		expect(container.textContent).not.toMatch(
			/stale live reply|stale thought|stale output/,
		);

		submit("newer live turn");
		act(() => deliver(restored));
		expect(
			container.querySelectorAll(".th-chat-history .th-chat-msg--user"),
		).toHaveLength(3);
		expect(
			container.querySelectorAll(".th-chat-history .th-chat-msg--assistant"),
		).toHaveLength(1);
		expect(container.querySelector(".th-btn--danger")?.textContent).toBe(
			"chat.stop",
		);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(2);
	});
});
