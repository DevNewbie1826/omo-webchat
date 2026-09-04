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

function pressSteer(input: HTMLTextAreaElement): void {
	input.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Enter",
			metaKey: true,
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

	it("persists an observed chat.send provider failure until dismissed", () => {
		submit("hello");
		act(() => {
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "provider_error",
				command: "chat.send",
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

	it.each(["prompt_in_flight", "compaction_in_flight"])(
		"persists the observed %s gate rejection",
		(code) => {
			act(() => deliver({
				type: "error", sessionId: "chat-1", code, message: `${code} rejected`,
			}));
			expect(alertBanner()?.textContent).toContain(`${code} rejected`);
		},
	);

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

	it("replaces the previous send failure instead of revealing it after dismissal", () => {
		act(() => deliver({
			type: "error", sessionId: "chat-1", code: "provider_error",
			command: "chat.abort", message: "First failure",
		}));
		act(() => deliver({
			type: "error", sessionId: "chat-1", code: "provider_error",
			command: "chat.compact", message: "Newest failure",
		}));
		expect(alertBanner()?.textContent).toContain("Newest failure");
		expect(alertBanner()?.textContent).not.toContain("First failure");

		act(() => alertBanner()?.querySelector<HTMLButtonElement>("button")?.click());
		expect(alertBanner()).toBeNull();
	});

	it("surfaces an observed compaction.done error in the persistent banner", () => {
		act(() => deliver({
			type: "compaction.done", sessionId: "chat-1", error: "Nothing to compact",
		}));
		expect(alertBanner()?.textContent).toContain("Nothing to compact");
	});

	it("shows the queued hint only for a pending follow-up", () => {
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		act(() => setTextareaValue(textarea(), "redirect"));
		act(() => pressSteer(textarea()));
		expect(sent.filter((frame) => frame.type === "chat.send")[0]).toMatchObject({
			run: { kind: "steer", message: "redirect" },
		});
		expect(statusText()).not.toContain("chat.sendQueued");

		submit("while running");
		expect(statusText()).toContain("chat.sendQueued");
		act(() => deliver({
			type: "message",
			sessionId: "chat-1",
			message: { role: "user", blocks: [{ kind: "text", text: "while running" }] },
		}));
		expect(statusText()).not.toContain("chat.sendQueued");
	});
});
