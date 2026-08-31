import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

function entry(id: string, role: string, text: string): unknown {
	return { id, type: "message", message: { role, content: text } };
}

describe("useChatSession paged entries", () => {
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

	it("buffers non-final pages and reconciles the full set on the final page", () => {
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("e-1", "user", "one")], final: false });
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("e-2", "assistant", "two")], final: false });
		});
		expect(current?.messages).toHaveLength(0);

		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("e-3", "user", "three")], final: true });
		});
		expect(current?.messages.map(messageText)).toEqual(["one", "two", "three"]);
	});

	it("reconciles immediately for a single final frame (backward compatible)", () => {
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("e-1", "user", "solo")] });
		});
		expect(current?.messages.map(messageText)).toEqual(["solo"]);
	});
});
