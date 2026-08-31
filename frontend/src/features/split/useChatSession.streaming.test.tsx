import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession streaming throttle", () => {
	let root: Root;
	let container: HTMLDivElement;
	let deliver: (frame: ChatServerFrame) => void;
	let current: ReturnType<typeof useChatSession> | undefined;
	let rafQueue: Array<(ts: number) => void>;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		rafQueue = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return { send: () => true, close: () => undefined };
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

	it("coalesces a delta burst into one rAF and flushes the accumulated text", async () => {
		await act(async () => {
			for (let i = 0; i < 5; i++) {
				deliver({ type: "messageDelta", sessionId: "chat-1", delta: { kind: "text_delta", delta: "x" } });
			}
		});
		expect(rafQueue).toHaveLength(1);
		expect(current?.streaming).toBe("");

		await act(async () => {
			rafQueue.splice(0).forEach((cb) => cb(0));
		});
		expect(current?.streaming).toBe("xxxxx");
	});

	it("clears buffered streaming on run.done without a stuck indicator, preserving the finalized text", async () => {
		await act(async () => {
			deliver({ type: "messageDelta", sessionId: "chat-1", delta: { kind: "text_delta", delta: "tail" } });
		});
		expect(rafQueue).toHaveLength(1);

		await act(async () => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "final reply" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		expect(current?.streaming).toBe("");
		expect(current?.messages.map(messageText)).toContain("final reply");
	});
});
