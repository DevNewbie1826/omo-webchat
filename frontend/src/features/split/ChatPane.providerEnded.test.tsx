import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatClientFrame, type ChatServerFrame } from "../../lib/chatWs";
import {
	pressKey,
	renderChatPane,
	requireElement,
	setTextareaValue,
} from "./chatPaneTestHarness";

function parsedFrame(raw: Record<string, unknown>): ChatServerFrame {
	const frame = parseChatServerFrame(raw);
	if (frame === null) throw new Error("expected a valid chat server frame");
	return frame;
}

// The locked wire shape for the shared provider process ending under the
// chat (internal/chat/session.go): one unsolicited error frame tagged with
// the chat id, carrying no command and no request id.
function providerEofFrame(): ChatServerFrame {
	return parsedFrame({
		type: "error",
		sessionId: "chat-1",
		code: "pi_eof",
		message: "Omo process ended (exit status 1)",
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

describe("ChatPane pi_eof resumable recovery", () => {
	let container: HTMLDivElement;
	let root: Root;

	// No ResizeObserver stub: a measured zero-height scrollport collapses the
	// transcript virtualizer to zero rows, and these tests count transcript
	// rows (ChatPane.optimistic.test.tsx renders under the same conditions).
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
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

	function textarea(): HTMLTextAreaElement {
		return requireElement(
			container.querySelector<HTMLTextAreaElement>('textarea[aria-label="chat.placeholder"]'),
			"chat textarea",
		);
	}

	function userRows(): NodeListOf<Element> {
		return container.querySelectorAll(".th-chat-history .th-chat-msg--user");
	}

	// prompt in flight -> pi_eof -> resumable pane (not stuck running) ->
	// resume rebinds with chat.create -> ready/state clears the marker ->
	// the next prompt submits successfully.
	it("recovers a mid-run provider end into a resumable pane whose next prompt submits", () => {
		const { deliver, sent } = renderChatPane(root);

		// Prompt in flight: accepted, pane shows the live run and Stop, and
		// the optimistic user row joins the transcript.
		act(() => setTextareaValue(textarea(), "first prompt"));
		act(() => pressKey(textarea(), "Enter"));
		expect(chatSends(sent)).toHaveLength(1);
		expect(container.textContent).toContain("chat.responding");
		expect(container.textContent).toContain("chat.stop");
		expect(userRows()).toHaveLength(1);

		// Provider dies mid-run: the pane must not stay stuck running.
		act(() => {
			deliver(providerEofFrame());
		});
		expect(container.textContent).not.toContain("chat.responding");
		expect(container.textContent).not.toContain("chat.stop");
		// Calm resumable state, not the raw terminal error; the durable
		// transcript survives - the in-flight run's optimistic row stays put
		// instead of being torn out with a retry draft.
		expect(container.textContent).toContain("chat.providerEndedTitle");
		expect(container.textContent).toContain("chat.providerEndedDetail");
		expect(container.textContent).not.toContain("Omo process ended");
		expect(userRows()).toHaveLength(1);
		expect(container.querySelector(".th-chat-error")).toBeNull();

		// The next interaction rebinds: resume re-sends chat.create, and the
		// fresh open sequence's state frame clears the resumable marker.
		const resume = requireElement(
			container.querySelector<HTMLButtonElement>(".th-unloaded-banner-actions"),
			"resume control",
		);
		act(() => {
			resume.click();
		});
		expect(sent.at(-1)).toEqual({ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" });
		act(() => {
			deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true });
			deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false });
		});
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
		expect(userRows()).toHaveLength(1);

		// The next prompt submits successfully against the fresh provider.
		act(() => setTextareaValue(textarea(), "second prompt"));
		act(() => pressKey(textarea(), "Enter"));
		const sends = chatSends(sent);
		expect(sends).toHaveLength(2);
		expect(sends[1]).toMatchObject({ type: "chat.send", run: { message: "second prompt" } });
		expect(userRows()).toHaveLength(2);
	});

	it("keeps a pi_eof frame tagged command prompt terminal instead of resumable", () => {
		const { deliver, sent } = renderChatPane(root);

		act(() => setTextareaValue(textarea(), "first prompt"));
		act(() => pressKey(textarea(), "Enter"));
		expect(chatSends(sent)).toHaveLength(1);

		act(() => {
			deliver(
				parsedFrame({
					type: "error",
					sessionId: "chat-1",
					code: "pi_eof",
					command: "prompt",
					message: "provider rejected request",
				}),
			);
		});

		// Terminal teardown: raw error surfaced, no resumable banner, the
		// optimistic run is torn out of the transcript and its text returns
		// as the retry draft in the composer.
		expect(container.querySelector(".th-unloaded-banner")).toBeNull();
		const errorRow = requireElement(container.querySelector(".th-chat-error"), "chat error row");
		expect(errorRow.textContent).toContain("provider rejected request");
		expect(userRows()).toHaveLength(0);
		expect(textarea().value).toBe("first prompt");
	});
});
