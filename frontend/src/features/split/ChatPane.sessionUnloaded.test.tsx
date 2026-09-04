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

	it("settles a transparently resumed send through admission and completed replay", () => {
		act(() => {
			deliver(sessionUnloadedFrame());
		});
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();

		act(() => setTextareaValue(textarea(), "after the unload"));
		act(() => pressKey(textarea(), "Enter"));

		const send = chatSends(sent)[0];
		if (!send?.requestId) throw new Error("missing chat.send request id");
		const requestId = send.requestId;
		expect(chatSends(sent)).toHaveLength(1);
		expect(send).toMatchObject({
			type: "chat.send",
			run: { kind: "prompt", message: "after the unload" },
		});
		expect(container.textContent).toContain("chat.responding");

		// Admission belongs to the first attempt. The resumed retry emits the
		// provider lifecycle and its terminal outcome is replayed to this pane.
		act(() => {
			deliver({ type: "ack", sessionId: "chat-1", command: "chat.send", requestId });
			deliver({ type: "run.started", sessionId: "chat-1" });
			deliver({ type: "run.done", sessionId: "chat-1", reason: "end_turn" });
			deliver({
				type: "ack",
				sessionId: "chat-1",
				command: "chat.send",
				requestId,
				phase: "completed",
			});
		});

		expect(container.textContent).not.toContain("chat.responding");
		expect(textarea().value).toBe("");
		expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent).toBe("chat.send");
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
	});

	it("restores the draft when transparent resume fails with typed correlation", () => {
		act(() => {
			deliver(sessionUnloadedFrame());
		});
		act(() => setTextareaValue(textarea(), "recover this draft"));
		act(() => pressKey(textarea(), "Enter"));

		const send = chatSends(sent)[0];
		if (!send?.requestId) throw new Error("missing chat.send request id");
		const requestId = send.requestId;
		expect(container.textContent).toContain("chat.responding");

		act(() => {
			deliver(parsedFrame({
				type: "error",
				sessionId: "chat-1",
				code: "resume_failed",
				command: "chat.send",
				requestId,
				dangling: true,
				candidates: [],
				message: "stored session no longer resolves",
			}));
		});

		expect(container.querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
		expect(textarea().value).toBe("recover this draft");
		expect(container.textContent).not.toContain("chat.responding");
		expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent).toBe("chat.send");
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
		expect(container.querySelector(".th-send-error-banner")).toBeNull();
		expect(container.textContent).not.toContain("stored session no longer resolves");

		act(() => pressKey(textarea(), "Enter"));
		expect(chatSends(sent)).toHaveLength(2);
		expect(chatSends(sent)[1]).toMatchObject({
			type: "chat.send",
			run: { kind: "prompt", message: "recover this draft" },
		});
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
