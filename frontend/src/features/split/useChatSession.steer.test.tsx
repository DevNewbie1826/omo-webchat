import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame, type ChatClientFrame, type ChatConnector, type ChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";
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
		window.sessionStorage.clear();
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

	it("sends a steer frame without a transcript row and shows the pending summary", () => {
		act(() => current?.steer("also do X"));
		expect(sent.some((f) => f.type === "chat.send" && f.run.kind === "steer")).toBe(true);
		expect(current?.messages).toEqual([]);
		expect(current?.steerPending.map((item) => item.text)).toEqual(["also do X"]);
	});

	it("retires a completed steer across replay without consuming later identical user text", () => {
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true });
			deliver({ type: "run.started", sessionId: "chat-1" });
			current?.steer("also do X");
		});
		expect(current?.steerPending).toHaveLength(1);

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

	it("retires a successfully completed steer before an identical follow-up echo", () => {
		act(() => {
			deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
			deliver({ type: "run.started", sessionId: session.id });
			current?.steer("same work");
		});
		const steerFrame = sent.find((frame) => frame.type === "chat.send" && frame.run.kind === "steer");
		if (steerFrame?.type !== "chat.send" || !steerFrame.requestId) throw new Error("missing steer request identity");
		const requestId = steerFrame.requestId;
		expect(current?.messages.some((m) => m.customType === "steer" && m.blocks?.[0]?.text === "same work")).toBe(false);

		const completedAck = parseChatServerFrame(JSON.parse(JSON.stringify({
			type: "ack",
			sessionId: session.id,
			command: "chat.send",
			requestId,
			phase: "completed",
		})));
		if (completedAck === null) throw new Error("completed steer ack did not parse");

		act(() => {
			deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
			deliver(completedAck);
			deliver({ type: "run.started", sessionId: session.id });
			current?.submit({ text: "same work", image: null });
		});

		act(() => deliver({
			type: "message",
			sessionId: session.id,
			message: { role: "user", blocks: [{ kind: "text", text: "same work" }], ts: 10 },
		}));
		expect(current?.messages).toEqual([
			{ role: "user", blocks: [{ kind: "text", text: "same work" }], ts: 10 },
		]);

		// A replayed completion is inert after the operation has been retired.
		const settledMessages = current?.messages;
		act(() => deliver({
			type: "ack",
			sessionId: session.id,
			command: "chat.send",
			requestId,
			phase: "completed",
		}));
		expect(current?.messages).toBe(settledMessages);
	});

	it("renders one steer when completion precedes run.done and canonical reconciliation", () => {
		act(() => {
			deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
			deliver({ type: "run.started", sessionId: session.id });
			current?.steer("completed before done");
		});
		const steerFrame = sent.find((frame) => frame.type === "chat.send" && frame.run.kind === "steer");
		if (steerFrame?.type !== "chat.send" || !steerFrame.requestId) throw new Error("missing steer request identity");
		const requestId = steerFrame.requestId;

		act(() => deliver({
			type: "ack",
			sessionId: session.id,
			command: "chat.send",
			requestId,
			phase: "completed",
		}));
		expect(current?.messages.filter((message) => messageText(message) === "completed before done")).toEqual([]);

		act(() => {
			deliver({
				type: "message",
				sessionId: session.id,
				message: { role: "user", blocks: [{ kind: "text", text: "completed before done" }], ts: 10 },
			});
			deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
			disconnect();
			reconnect();
			deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
			deliver({
				type: "entries",
				sessionId: session.id,
				entries: [{
					type: "message",
					message: { role: "user", content: "completed before done", timestamp: 10 },
				}],
				final: true,
			});
		});

		expect(current?.messages.filter((message) => messageText(message) === "completed before done")).toHaveLength(1);
		// The canonical flush regains the steer mark from the client-side store.
		expect(current?.messages.some((message) => message.customType === "steer")).toBe(true);
	});

	it("settles a steer marker when completion replays after run.done was missed", () => {
		act(() => {
			deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
			deliver({ type: "run.started", sessionId: session.id });
			current?.steer("missed terminal");
		});
		const steerFrame = sent.find((frame) => frame.type === "chat.send" && frame.run.kind === "steer");
		if (steerFrame?.type !== "chat.send" || !steerFrame.requestId) throw new Error("missing steer request identity");
		const requestId = steerFrame.requestId;

		act(() => {
			disconnect();
			reconnect();
			deliver({ type: "ack", command: "chat.send", requestId, phase: "completed" });
			deliver({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
			deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
		});
		expect(current?.messages.some((message) => message.customType === "steer")).toBe(false);
		expect(current?.messages.map(messageText)).not.toContain("missed terminal");

		act(() => deliver({
			type: "message",
			sessionId: session.id,
			message: { role: "user", blocks: [{ kind: "text", text: "missed terminal" }], ts: 20 },
		}));
		expect(current?.messages.filter((message) => messageText(message) === "missed terminal")).toHaveLength(1);
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

	it("keeps the steer-marked entry in the transcript when the run settles (QA B2)", () => {
		act(() => {
			deliver({ type: "entries", sessionId: session.id, entries: [], final: true });
			deliver({ type: "run.started", sessionId: session.id });
			current?.steer("redirect now");
		});
		act(() => deliver({
			type: "message",
			sessionId: session.id,
			message: { role: "user", blocks: [{ kind: "text", text: "redirect now" }], ts: 10 },
		}));
		expect(current?.messages).toEqual([
			{ role: "user", customType: "steer", blocks: [{ kind: "text", text: "redirect now" }], ts: 10 },
		]);

		act(() => deliver({ type: "run.done", sessionId: session.id, reason: "stop" }));
		expect(current?.steerPending).toEqual([]);
		expect(current?.messages).toEqual([
			{ role: "user", customType: "steer", blocks: [{ kind: "text", text: "redirect now" }], ts: 10 },
		]);
	});

	it("sends two consecutive submissions during a run as queued prompts", () => {
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		act(() => {
			current?.submit({ text: "first", image: null });
			current?.submit({ text: "second", image: null });
		});

		expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
			{ type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "prompt", message: "first" } },
			{ type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "prompt", message: "second" } },
		]);
		// Queued items stay out of the transcript flow entirely.
		expect(current?.messages).toEqual([]);
		expect(current?.queuePlaceholders.map((placeholder) => placeholder.text)).toEqual(["first", "second"]);
	});

	it("replaces a queued prompt's placeholder once its queue frame lands", () => {
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		act(() => current?.submit({ text: "queued work", image: null }));
		const sentFrame = sent.at(-1);
		if (sentFrame?.type !== "chat.send") throw new Error("missing chat.send");
		const requestId = sentFrame.requestId;
		if (requestId === undefined) throw new Error("missing queued request identity");
		act(() => deliver({
			type: "queue",
			sessionId: "chat-1",
			revision: 1,
			items: [{ id: "q-1", text: "queued work", hasImage: false, createdAt: 1, requestId }],
			engine: { pendingMessageCount: 0, ordered: [] },
		}));

		expect(current?.queueItems.map((item) => item.text)).toEqual(["queued work"]);
		expect(current?.queuePlaceholders).toEqual([]);
		expect(current?.messages).toEqual([]);
	});

	it("replaces a steer-pending echo with its canonical user message", () => {
		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		act(() => current?.steer("queued work"));
		act(() => deliver({
			type: "message",
			sessionId: "chat-1",
			message: { role: "user", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
		}));

		expect(current?.messages).toEqual([
			{ role: "user", customType: "steer", blocks: [{ kind: "text", text: "queued work" }], ts: 10 },
		]);
		expect(current?.steerPending).toEqual([]);
	});

	it("sends an idle submission as a prompt", () => {
		act(() => current?.submit({ text: "start work", image: null }));
		expect(sent.filter((frame) => frame.type === "chat.send")).toEqual([
			{ type: "chat.send", sessionId: "chat-1", requestId: expect.any(String), run: { kind: "prompt", message: "start work" } },
		]);
	});

	it("uses fallback request ids for prompt, steer, and queued sends when randomUUID is unavailable", () => {
		vi.stubGlobal("crypto", { randomUUID: undefined });
		act(() => current?.submit({ text: "start work", image: null }));
		act(() => {
			current?.steer("redirect");
			current?.submit({ text: "queue next", image: null });
		});

		const sends = sent.filter((frame): frame is Extract<ChatClientFrame, { readonly type: "chat.send" }> => frame.type === "chat.send");
		expect(sends.map((frame) => frame.run.kind)).toEqual(["prompt", "steer", "prompt"]);
		expect(sends.every((frame) => typeof frame.requestId === "string" && frame.requestId.length > 0)).toBe(true);
		expect(new Set(sends.map((frame) => frame.requestId)).size).toBe(3);
	});
});
