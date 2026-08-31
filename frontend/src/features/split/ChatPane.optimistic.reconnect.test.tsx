import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
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
const chatSession = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

function setTextareaValue(input: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("missing textarea value setter");
	setter.call(input, value);
	input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
}

function pressEnter(input: HTMLTextAreaElement): void {
	input.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		}),
	);
}

describe("ChatPane optimistic runs", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: (frame: ChatServerFrame) => void;
	let disconnect: () => void;
	let reconnect: () => void;
	let sent: ChatClientFrame[];
	let sendResult: boolean;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sent = [];
		sendResult = true;
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			disconnect = () => handlers.onClose?.(1006);
			reconnect = () => handlers.onOpen?.();
			handlers.onOpen?.();
			return {
				send: (frame) => {
					sent.push(frame);
					return frame.type === "chat.send" ? sendResult : true;
				},
				close: vi.fn(),
			};
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
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	function textarea(): HTMLTextAreaElement {
		const input = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!input) throw new Error("missing textarea");
		return input;
	}

	function submit(text: string): void {
		act(() => setTextareaValue(textarea(), text));
		act(() => pressEnter(textarea()));
	}

	function chatSends(): ChatClientFrame[] {
		return sent.filter((frame) => frame.type === "chat.send");
	}

	it("restores an uncertain draft once when reconnect history omits it", () => {
		submit("lost in transit");

		act(() => disconnect());
		act(() => reconnect());
		act(() =>
			deliver({
				type: "state",
				sessionId: "chat-1",
				isStreaming: false,
				isCompacting: false,
			}),
		);
		act(() => deliver({ type: "entries", sessionId: "chat-1", entries: [] }));

		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(textarea().value).toBe("lost in transit");
		expect(
			container.querySelector<HTMLButtonElement>('button[type="submit"]')
				?.textContent,
		).toBe("chat.send");
		expect(chatSends()).toHaveLength(1);

		act(() => setTextareaValue(textarea(), "edited retry"));
		act(() => deliver({ type: "entries", sessionId: "chat-1", entries: [] }));
		expect(textarea().value).toBe("edited retry");
		expect(chatSends()).toHaveLength(1);
	});

	it("reconciles an uncertain send once when reconnect history contains it", () => {
		submit("arrived once");

		act(() => disconnect());
		act(() => reconnect());
		const history: ChatServerFrame = {
			type: "entries",
			sessionId: "chat-1",
			entries: [
				{
					type: "message",
					message: { role: "user", content: "arrived once", timestamp: 1 },
				},
			],
		};
		act(() => deliver(history));
		act(() =>
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "arrived once" }],
					ts: 1,
				},
			}),
		);
		act(() => deliver(history));

		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(1);
		expect(textarea().value).toBe("");
		expect(chatSends()).toHaveLength(1);
	});

	it("exposes attachment picking through a keyboard-focusable button", () => {
		const button = container.querySelector<HTMLButtonElement>(
			".th-chat-attach-btn",
		);
		const input =
			container.querySelector<HTMLInputElement>('input[type="file"]');
		if (!button || !input) throw new Error("missing attachment controls");
		const openPicker = vi.spyOn(input, "click");
		button.focus();
		expect(document.activeElement).toBe(button);
		act(() => button.click());
		expect(openPicker).toHaveBeenCalledOnce();
	});
});
