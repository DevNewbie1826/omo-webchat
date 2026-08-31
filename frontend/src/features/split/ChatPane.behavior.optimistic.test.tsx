import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ControlledResizeObserver,
	chatSession,
	pressKey,
	renderChatPane,
	setTextareaValue,
} from "./chatPaneTestHarness";

describe("ChatPane optimistic prompt reconciliation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: ReturnType<typeof renderChatPane>["deliver"];
	let sent: ReturnType<typeof renderChatPane>["sent"];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => undefined)),
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		({ deliver, sent } = renderChatPane(root, chatSession));
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

	function chatSends() {
		return sent.filter((frame) => frame.type === "chat.send");
	}

	it("does not reconcile a reconnect snapshot's older identical prompt as the current optimistic one", () => {
		act(() => setTextareaValue(textarea(), "repeat"));
		act(() => pressKey(textarea(), "Enter"));
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "repeat" }],
					ts: 1,
				},
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		act(() => setTextareaValue(textarea(), "repeat"));
		act(() => pressKey(textarea(), "Enter"));
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: { role: "user", content: "repeat", timestamp: 1 },
					},
				],
			});
		});

		expect(
			container.querySelector<HTMLElement>(".th-chat-history")?.style.height,
		).toBe("160px");
	});

	it("reconciles identical prompts independently after completion", () => {
		const submitAndEcho = (ts: number): void => {
			act(() => setTextareaValue(textarea(), "repeat"));
			act(() => pressKey(textarea(), "Enter"));
			act(() => {
				deliver({
					type: "message",
					sessionId: "chat-1",
					message: {
						role: "user",
						blocks: [{ kind: "text", text: "repeat" }],
						ts,
					},
				});
				deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
			});
		};

		submitAndEcho(1);
		submitAndEcho(2);

		expect(chatSends()).toHaveLength(2);
		expect(
			container.querySelector<HTMLElement>(".th-chat-history")?.style.height,
		).toBe("160px");
	});
});
