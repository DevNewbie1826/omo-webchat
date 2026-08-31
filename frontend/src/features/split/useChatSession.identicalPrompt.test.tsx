import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession delayed identical-prompt history", () => {
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

	it("keeps the active run associated until real completion, not stale identical history", () => {
		// First submit lands before the initial history snapshot arrives.
		let firstAccepted = false;
		act(() => {
			firstAccepted = current?.submit({ text: "hello", image: null }) ?? false;
		});
		expect(firstAccepted).toBe(true);
		expect(current?.running).toBe(true);

		// Delayed initial history already contains an OLD identical turn + reply.
		act(() =>
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: { role: "user", content: "hello", timestamp: 1 },
					},
					{
						type: "message",
						message: { role: "assistant", content: "old reply", timestamp: 2 },
					},
				],
			}),
		);

		// Old history must not clear the running/active association.
		expect(current?.running).toBe(true);
		// The optimistic run stays associated exactly once: no dropped association, no duplicate.
		const optimisticTurns = (current?.messages ?? []).filter(
			(message) =>
				message.role === "user" && message.optimisticId !== undefined,
		);
		expect(optimisticTurns).toHaveLength(1);

		// Second identical submit remains blocked until real completion.
		let secondAccepted = true;
		act(() => {
			secondAccepted = current?.submit({ text: "hello", image: null }) ?? false;
		});
		expect(secondAccepted).toBe(false);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);

		// Real completion: actual server echo + assistant reply + run.done.
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "hello" }],
					ts: 3,
				},
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "text", text: "new reply" }],
					ts: 4,
				},
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});
		expect(current?.running).toBe(false);

		// Now the next submit is unblocked.
		let thirdAccepted = false;
		act(() => {
			thirdAccepted = current?.submit({ text: "hello", image: null }) ?? false;
		});
		expect(thirdAccepted).toBe(true);
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(2);
	});
});
