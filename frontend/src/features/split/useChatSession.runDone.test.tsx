import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession run.done transient cleanup", () => {
	let root: Root;
	let container: HTMLDivElement;
	let deliver: (frame: ChatServerFrame) => void;
	let disconnect: () => void;
	let reconnect: () => void;
	let sent: ChatClientFrame[];
	let current: ReturnType<typeof useChatSession> | undefined;

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
				close: () => undefined,
			};
		};
		function Probe() {
			current = useChatSession(session, connect);
			return null;
		}
		act(() => root.render(<Probe />));
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	it("clears live tool/streaming state on run.done and preserves finalized message blocks", async () => {
		await act(async () => {
			current?.submit({ text: "do work", image: null });
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				delta: { kind: "text_delta", delta: "partial" },
			});
			deliver({
				type: "messageDelta",
				sessionId: "chat-1",
				delta: { kind: "thinking_delta", delta: "pondering" },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "tool-1",
				toolName: "bash",
				phase: "start",
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "tool-1",
				toolName: "bash",
				phase: "update",
				partial: { content: [{ text: "live output" }] },
			});
		});

		expect(Object.keys(current?.toolCalls ?? {})).toEqual(["tool-1"]);
		expect(current?.streaming).toBe("partial");
		expect(current?.thinking).toBe("pondering");

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "text", text: "final reply" }],
					ts: 5,
				},
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		// run.done is authoritative: every transient surface is cleared.
		expect(current?.toolCalls).toEqual({});
		expect(current?.streaming).toBe("");
		expect(current?.thinking).toBe("");
		expect(current?.running).toBe(false);
		// Finalized message blocks are preserved.
		expect(current?.messages.map(messageText)).toContain("final reply");

		// Reconnect history must not resurrect a stale tool card.
		act(() => {
			disconnect();
			reconnect();
		});
		act(() =>
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: { role: "user", content: "do work", timestamp: 1 },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: "final reply",
							timestamp: 5,
						},
					},
				],
			}),
		);

		expect(current?.toolCalls).toEqual({});
		expect(current?.messages.map(messageText)).toContain("final reply");
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);
	});
});
