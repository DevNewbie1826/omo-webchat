import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession active-run sends", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: ReturnType<typeof useChatSession> | undefined;
	let sent: ChatClientFrame[];
	let deliver: (frame: ChatServerFrame) => void;
	let disconnect: () => void;
	let reconnect: () => void;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sent = [];
		const connect: ChatConnector = (handlers) => {
			disconnect = () => handlers.onClose?.(1006);
			reconnect = () => handlers.onOpen?.();
			handlers.onOpen?.();
			deliver = handlers.onFrame;
			return { send: (frame) => { sent.push(frame); return true; }, close: () => undefined };
		};
		function Probe() {
			current = useChatSession(session, connect);
			return null;
		}
		act(() => root.render(<Probe />));
	});

	afterEach(async () => {
		await act(async () => { root.unmount(); });
		container.remove();
		vi.unstubAllGlobals();
	});

	it("sends a steer frame and appends a steer marker to the transcript", () => {
		act(() => current?.steer("also do X"));
		expect(sent.some((f) => f.type === "chat.send" && f.run.kind === "steer")).toBe(true);
		const steer = current?.messages.find((m) => m.customType === "steer");
		expect(steer?.blocks?.[0]?.text).toBe("also do X");
	});

	it("retires a completed steer across replay without consuming later identical user text", () => {
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
			deliver({ type: "run.started", sessionId: "chat-1" });
			current?.steer("also do X");
		});
		expect(current?.messages.some((m) => m.customType === "steer")).toBe(true);

		act(() => {
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
			disconnect();
			reconnect();
			deliver({ type: "state", sessionId: "chat-1", isStreaming: false, isCompacting: false });
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
		});
		expect(current?.messages.some((m) => m.customType === "steer")).toBe(false);

		act(() => deliver({
			type: "message",
			sessionId: "chat-1",
			message: { role: "user", blocks: [{ kind: "text", text: "also do X" }] },
		}));
		expect(current?.messages).toEqual([
			{ role: "user", blocks: [{ kind: "text", text: "also do X" }] },
		]);
	});

	it("restores a steer when its correlated rejection arrives after run.done", () => {
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
			current?.steer("late rejected steer");
		});
		const frame = sent.find((candidate) => candidate.type === "chat.send" && candidate.run.kind === "steer");
		if (frame?.type !== "chat.send" || !frame.requestId) throw new Error("missing steer request identity");
		const requestId = frame.requestId;

		act(() => deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" }));
		expect(current?.messages.some((message) => message.customType === "steer")).toBe(false);

		act(() => deliver({
			type: "error",
			sessionId: "chat-1",
			code: "send_failed",
			command: "chat.send",
			requestId,
			message: "Steer rejected late",
		}));
		expect(current?.retryDraft?.text).toBe("late rejected steer");
		expect(current?.failedDrafts).toContainEqual(expect.objectContaining({
			requestId,
			text: "late rejected steer",
		}));
	});

	it("sends two consecutive submissions during a run as follow-ups", () => {
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		act(() => {
			current?.submit({ text: "first", image: null });
			current?.submit({ text: "second", image: null });
		});

		expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
			{ type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "follow_up", message: "first" } },
			{ type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "follow_up", message: "second" } },
		]);
		expect(current?.messages.filter((message) => message.customType === "followUp").map((message) => message.blocks?.[0]?.text)).toEqual([
			"first",
			"second",
		]);
	});

	it("replaces a follow-up marker with its canonical user message", () => {
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		act(() => current?.submit({ text: "queued work", image: null }));
		act(() => deliver({
			type: "message",
			sessionId: "chat-1",
			message: { role: "user", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
		}));

		expect(current?.messages).toEqual([
			{ role: "user", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
		]);
	});

	it("sends an idle submission as a prompt", () => {
		act(() => current?.submit({ text: "start work", image: null }));
		expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
			{ type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "prompt", message: "start work" } },
		]);
	});

	it("uses fallback request ids for prompt, steer, and follow-up sends when randomUUID is unavailable", () => {
		vi.stubGlobal("crypto", { randomUUID: undefined });
		act(() => current?.submit({ text: "start work", image: null }));
		act(() => {
			current?.steer("redirect");
			current?.submit({ text: "queue next", image: null });
		});

		const sends = sent.filter((frame): frame is Extract<ChatClientFrame, { readonly type: "chat.send" }> => frame.type === "chat.send");
		expect(sends.map((frame) => frame.run.kind)).toEqual(["prompt", "steer", "follow_up"]);
		expect(sends.every((frame) => typeof frame.requestId === "string" && frame.requestId.length > 0)).toBe(true);
		expect(new Set(sends.map((frame) => frame.requestId)).size).toBe(3);
	});
});
