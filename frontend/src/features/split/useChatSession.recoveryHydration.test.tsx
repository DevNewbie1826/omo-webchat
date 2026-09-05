import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText } from "./chatEntries";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

const prompt = "idle-resume-once";
const reply = "fixture response";

function entry(id: string, role: "user" | "assistant", content: string) {
	return { type: "message", id, message: { role, content } } as const;
}

describe("useChatSession same-socket recovery hydration", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	it("replaces a settled optimistic prompt with its canonical occurrence without collapsing an older identical turn", () => {
		// A prior identical turn is authoritative and must remain distinct.
		act(() => harness.deliver({
			type: "entries",
			sessionId: session.id,
			entries: [entry("entry-1", "user", prompt), entry("entry-2", "assistant", "older reply")],
		}));

		let accepted = false;
		act(() => {
			accepted = harness.current?.submit({ text: prompt, image: null }) ?? false;
		});
		expect(accepted).toBe(true);

		// The isolated provider fixture emits the normal prompt response and
		// lifecycle. Like the observed provider contract, it does not need a
		// separate live user-message echo: agent_settled is the run terminal.
		const request = harness.sent.find((frame) => frame.type === "chat.send");
		const requestId = request?.type === "chat.send" ? request.requestId ?? "" : "";
		expect(requestId).not.toBe("");
		act(() => {
			harness.deliver({
				type: "ack",
				sessionId: session.id,
				command: "chat.send",
				requestId,
			});
			harness.deliver({ type: "run.started", sessionId: session.id });
			harness.deliver({
				type: "message",
				sessionId: session.id,
				message: { role: "assistant", blocks: [{ kind: "text", text: reply }] },
			});
			harness.deliver({ type: "run.done", sessionId: session.id, reason: "end_turn" });
		});
		expect(harness.current?.running).toBe(false);

		// A successful close_session lifecycle is recovered lazily by the
		// subsequent chat.commands operation on this same browser socket. The
		// replacement route then hydrates the complete authoritative history.
		act(() => {
			harness.deliver({
				type: "ready",
				sessionId: session.id,
				piSessionId: "durable-chat-1",
				resumed: true,
			});
			harness.deliver({
				type: "state",
				sessionId: session.id,
				isStreaming: false,
				isCompacting: false,
			});
			harness.deliver({
				type: "entries",
				sessionId: session.id,
				entries: [
					entry("entry-1", "user", prompt),
					entry("entry-2", "assistant", "older reply"),
					entry("entry-3", "user", prompt),
					entry("entry-4", "assistant", reply),
				],
			});
		});

		expect(harness.current?.messages.map((message) => [message.role, messageText(message)])).toEqual([
			["user", prompt],
			["assistant", "older reply"],
			["user", prompt],
			["assistant", reply],
		]);
		expect(harness.current?.messages.filter(
			(message) => message.role === "user" && messageText(message) === prompt,
		)).toHaveLength(2);
		expect(harness.sent.filter((frame) => frame.type === "chat.send")).toHaveLength(1);
	});
});
