import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import ko from "../../i18n/locales/ko.json";
import { parseChatServerFrame, type ChatClientFrame, type ChatServerFrame } from "../../lib/chatWs";
import {
	ControlledResizeObserver,
	pressKey,
	renderChatPane,
	setTextareaValue,
} from "./chatPaneTestHarness";

function parsedFrame(raw: Record<string, unknown>): ChatServerFrame {
	const frame = parseChatServerFrame(raw);
	if (frame === null) throw new Error("expected a valid chat server frame");
	return frame;
}

// Observed wire shape for an idle unload: one unsolicited error frame tagged
// with the chat id and the resumable session_unloaded code.
function sessionUnloadedFrame(): ChatServerFrame {
	return parsedFrame({
		type: "error",
		sessionId: "chat-1",
		code: "session_unloaded",
		message: "session unloaded after 30m idle",
	});
}

function isChatSend(
	frame: ChatClientFrame,
): frame is Extract<ChatClientFrame, { type: "chat.send" }> {
	return frame.type === "chat.send";
}

function chatSends(sent: readonly ChatClientFrame[]) {
	return sent.filter(isChatSend);
}

// Unloads are invisible: the frame is quiet internal state, the next send
// transparently resumes, and no unloaded-specific i18n copy exists.
describe("ChatPane session_unloaded quiet handling", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: ReturnType<typeof renderChatPane>["deliver"];
	let sent: ReturnType<typeof renderChatPane>["sent"];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		({ deliver, sent } = renderChatPane(root));
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

	it("changes nothing visible: no banner, no raw error, pane stays usable", () => {
		act(() => {
			deliver(sessionUnloadedFrame());
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
		});

		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
		expect(container.querySelector(".th-chat-error")).toBeNull();
		expect(container.textContent).not.toContain("session unloaded after 30m idle");
		// No manual resume affordance of any kind.
		expect(container.textContent).not.toContain("chat.sessionUnloadedResume");
		// The pane stays usable: the composer is present, the pane is not a
		// terminal dead end.
		expect(container.querySelector(".th-chat-input")).not.toBeNull();
	});

	it("retires a stale in-flight run indicator when the unload frame lands", () => {
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
		});
		expect(container.textContent).toContain("chat.responding");

		act(() => {
			deliver(sessionUnloadedFrame());
		});

		expect(container.textContent).not.toContain("chat.responding");
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
	});

	it("lets the next chat.send proceed normally after an unload", () => {
		act(() => {
			deliver(sessionUnloadedFrame());
		});

		act(() => setTextareaValue(textarea(), "after the unload"));
		act(() => pressKey(textarea(), "Enter"));

		expect(chatSends(sent)).toHaveLength(1);
		expect(chatSends(sent)[0]).toMatchObject({
			type: "chat.send",
			run: { message: "after the unload" },
		});

		// The transparent resume lands: a state frame proves the session is
		// live again and the pane keeps working without any unload surface.
		act(() => {
			deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false });
		});
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
		expect(container.querySelector(".th-chat-input")).not.toBeNull();
	});

	it("removes the sessionUnloaded i18n keys from both locales", () => {
		const unloadedKeys = ["chat.sessionUnloadedTitle", "chat.sessionUnloadedDetail", "chat.sessionUnloadedResume"];
		for (const table of [en as Record<string, string>, ko as Record<string, string>]) {
			for (const key of unloadedKeys) {
				expect(table[key], `${key}`).toBeUndefined();
			}
		}
	});
});
