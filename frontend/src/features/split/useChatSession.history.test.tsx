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

describe("useChatSession history ordering", () => {
	let root: Root;
	let container: HTMLDivElement;
	let deliver: (frame: ChatServerFrame) => void;
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

	it("merges a delayed stale snapshot without erasing a completed live turn", () => {
		act(() => {
			current?.submit({ text: "completed live prompt", image: null });
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "completed live prompt" }],
					ts: 10,
				},
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "text", text: "completed live reply" }],
					ts: 11,
				},
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		act(() =>
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: {
							role: "assistant",
							content: "older history",
							timestamp: 1,
						},
					},
				],
			}),
		);

		expect(current?.messages.map(messageText)).toEqual([
			"older history",
			"completed live prompt",
			"completed live reply",
		]);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);
	});
});
