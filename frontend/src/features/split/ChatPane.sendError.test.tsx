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

describe("ChatPane send-error banner", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: (frame: ChatServerFrame) => void;
	let sent: ChatClientFrame[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sent = [];
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return {
				send: (frame) => {
					sent.push(frame);
					return true;
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

	function alertBanner(): HTMLElement | null {
		return container.querySelector<HTMLElement>(".th-send-error-banner");
	}

	function statusText(): string {
		return container.querySelector(".th-chat-status")?.textContent ?? "";
	}

	it("persists a send-path failure banner until dismissed", () => {
		submit("hello");
		act(() => {
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "send_failed",
				message: "Backend failed",
			});
		});
		expect(alertBanner()?.textContent).toContain("Backend failed");
		// A later successful live frame must not clear the banner.
		act(() => {
			deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false });
		});
		expect(alertBanner()?.textContent).toContain("Backend failed");

		const dismiss = alertBanner()?.querySelector<HTMLButtonElement>("button");
		expect(dismiss).not.toBeNull();
		act(() => dismiss!.click());
		expect(alertBanner()).toBeNull();
	});

	it("keeps non-send errors out of the persistent banner", () => {
		act(() => {
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "decode_failed",
				message: "history gone",
			});
		});
		expect(alertBanner()).toBeNull();
	});

	it("shows the queued hint while a run is active after a queued send", () => {
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
		});
		submit("while running");
		const sends = sent.filter((frame) => frame.type === "chat.send");
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({ run: { kind: "follow_up", message: "while running" } });
		expect(statusText()).toContain("chat.sendQueued");

		act(() => {
			deliver({ type: "run.done", sessionId: "chat-1", reason: "end_turn" });
		});
		expect(statusText()).not.toContain("chat.sendQueued");
	});
});
