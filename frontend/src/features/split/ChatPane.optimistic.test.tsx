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

	it("uses a synchronous latch so submit reentry sends once", () => {
		act(() => setTextareaValue(textarea(), "one action"));
		const form = container.querySelector<HTMLFormElement>("form");
		act(() => {
			form?.dispatchEvent(
				new SubmitEvent("submit", { bubbles: true, cancelable: true }),
			);
			form?.dispatchEvent(
				new SubmitEvent("submit", { bubbles: true, cancelable: true }),
			);
		});
		expect(chatSends()).toHaveLength(1);
		expect(
			container.querySelectorAll(".th-chat-history .th-chat-msg--user"),
		).toHaveLength(1);
	});

	it("reconciles one matching live user echo with its optimistic row", () => {
		submit("same prompt");
		act(() =>
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "same prompt" }],
					ts: 10,
				},
			}),
		);
		expect(
			container.querySelectorAll(".th-chat-history .th-chat-msg--user"),
		).toHaveLength(1);
	});

	it("keeps the draft and rolls back when local send returns false", () => {
		sendResult = false;
		submit("not accepted");
		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(
			container.querySelector<HTMLButtonElement>('button[type="submit"]')
				?.textContent,
		).toBe("chat.send");
		expect(textarea().value).toBe("not accepted");
	});

	it("sends another submission immediately as a follow-up while a run is active", () => {
		submit("first");
		submit("second");
		expect(chatSends()).toEqual([
			{ type: "chat.send", sessionId: "chat-1", run: { kind: "prompt", message: "first" } },
			{ type: "chat.send", sessionId: "chat-1", run: { kind: "follow_up", message: "second" } },
		]);
		expect(textarea().value).toBe("");
		expect(container.querySelector(".th-chat-queued")).toBeNull();
		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(2);
	});

	it("rolls back an optimistic prompt on an observed chat.send failure", async () => {
		submit("retry this");
		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(1);

		await act(async () => {
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "provider_error",
				command: "chat.send",
				message: "Backend failed",
			});
		});

		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(textarea().value).toBe("retry this");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Backend failed",
		);
		expect(
			container.querySelector<HTMLButtonElement>('button[type="submit"]')
				?.textContent,
		).toBe("chat.send");
	});

});
