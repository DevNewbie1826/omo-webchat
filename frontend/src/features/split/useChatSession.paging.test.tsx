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

	it("discards uncommitted cold pages when external-write rejects hydration", () => {
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("disk", "user", "from disk")], final: false });
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "external-write-detected",
				message: "external write detected",
			});
		});
		expect(current?.messages.map(messageText)).toEqual([]);
		expect(current?.historyStatus).toBe("failed");
		expect(current?.externalWriteDetected).toBe(true);
	});

	it.each([false, true])("preserves completed history on rejected resync (partial pages: %s)", (partial) => {
		act(() => {
			deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true });
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("old", "user", "retained transcript")], final: true });
		});
		const completed = current?.messages;
		act(() => { expect(current?.resync()).toBe(true); });
		expect(sent.slice(-2)).toEqual([
			{ type: "chat.close", sessionId: "chat-1" },
			{ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" },
		]);
		act(() => {
			deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-2", resumed: true });
			if (partial) deliver({ type: "entries", sessionId: "chat-1", entries: [entry("rejected", "user", "rejected disk page")], final: false });
			deliver({ type: "error", sessionId: "chat-1", code: "external-write-detected", message: "changed" });
		});
		expect(current?.messages).toBe(completed);
		expect(current?.messages.map(messageText)).toEqual(["retained transcript"]);
		expect(current?.historyStatus).toBe("failed");
		expect(current?.historyLoaded).toBe(false);
		expect(current?.resyncBusy).toBe(false);
		expect(current?.externalWriteDetected).toBe(true);
		act(() => { expect(current?.reloadExternalWrite()).toBe(true); });
		act(() => {
			deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-3", resumed: true });
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
		});
		expect(current?.messages).toEqual([]);
		expect(current?.historyStatus).toBe("loaded");
		expect(current?.externalWriteDetected).toBe(false);
	});

	it("accepts authoritative empty success during normal resync", () => {
		act(() => {
			deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true });
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("old", "user", "old branch")], final: true });
		});
		act(() => { expect(current?.resync()).toBe(true); });
		act(() => {
			deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-2", resumed: true });
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
		});
		expect(current?.messages).toEqual([]);
		expect(current?.historyStatus).toBe("loaded");
		expect(current?.externalWriteDetected).toBe(false);
	});

	it("reconciles immediately for a single final frame (backward compatible)", () => {
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [entry("e-1", "user", "solo")] });
		});
		expect(current?.messages.map(messageText)).toEqual(["solo"]);
	});
});
