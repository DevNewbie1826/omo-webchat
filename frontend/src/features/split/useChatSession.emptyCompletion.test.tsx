import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession empty assistant completions", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: ReturnType<typeof useChatSession> | undefined;
	let deliver: (frame: ChatServerFrame) => void;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

	it("anchors a current-turn tool result after the newest user turn when the completion is empty", () => {
		act(() => {
			deliver({
				type: "entries",
				sessionId: session.id,
				entries: [
					{ type: "message", id: "u1", message: { role: "user", content: "old-question" } },
					{ type: "message", id: "a1", message: { role: "assistant", content: "old-answer" } },
					{ type: "message", id: "u2", message: { role: "user", content: "new-question" } },
				],
			});
			deliver({ type: "run.started", sessionId: session.id });
			deliver({
				type: "tool",
				sessionId: session.id,
				toolCallId: "current-tool",
				toolName: "lookup",
				phase: "end",
				result: { content: [{ text: "current-output" }] },
			});
			deliver({
				type: "message",
				sessionId: session.id,
				message: { role: "assistant", blocks: [] },
			});
			deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
		});

		const messages = current?.messages ?? [];
		const currentUserIndex = messages.findIndex((message) => message.id === "u2");
		expect(currentUserIndex).toBe(2);
		const toolOwnerIndex = messages.findIndex((message) =>
			(message.blocks ?? []).some((block) => block.id === "current-tool"),
		);
		// Observed pre-change behavior: the empty completion is still appended,
		// so run.done materializes the unresolved tool onto it — after u2 —
		// instead of onto the older answer a1.
		expect(toolOwnerIndex).toBeGreaterThan(currentUserIndex);
	});

	it("retains an empty assistant completion in transcript state; blank-row filtering is presentation-owned", () => {
		act(() => {
			deliver({
				type: "message",
				sessionId: session.id,
				message: { role: "assistant", blocks: [] },
			});
		});
		expect(current?.messages).toEqual([{ role: "assistant", blocks: [] }]);
	});

	it("clears streaming and thinking on an empty assistant completion so the next message starts fresh", async () => {
		await act(async () => {
			deliver({ type: "messageDelta", sessionId: session.id, delta: { kind: "text_delta", delta: "discarded-" } });
			deliver({ type: "messageDelta", sessionId: session.id, delta: { kind: "thinking_delta", delta: "discarded-thought" } });
		});
		expect(current?.streaming).toBe("discarded-");

		await act(async () => {
			deliver({
				type: "message",
				sessionId: session.id,
				message: { role: "assistant", blocks: [] },
			});
		});
		expect(current?.streaming).toBe("");
		expect(current?.thinking).toBe("");

		await act(async () => {
			deliver({ type: "messageDelta", sessionId: session.id, delta: { kind: "text_delta", delta: "next-message" } });
		});
		expect(current?.streaming).toBe("next-message");
	});
});
