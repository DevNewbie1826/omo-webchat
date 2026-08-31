import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText } from "./chatEntries";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

describe("useChatSession reconnect recovery", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	it("clears stale live state and restores retry when an uncertain run has a user entry but no assistant", () => {
		// Initial history loads first, so the submit baseline is known.
		act(() => harness.deliver({ type: "entries", sessionId: session.id, entries: [] }));
		act(() => {
			harness.current?.submit({ text: "work", image: null });
		});
		act(() => {
			harness.deliver({
				type: "messageDelta",
				sessionId: session.id,
				delta: { kind: "text_delta", delta: "partial" },
			});
			harness.deliver({
				type: "messageDelta",
				sessionId: session.id,
				delta: { kind: "thinking_delta", delta: "pondering" },
			});
			harness.deliver({
				type: "tool",
				sessionId: session.id,
				toolCallId: "t1",
				toolName: "bash",
				phase: "start",
			});
		});
		expect(harness.current?.running).toBe(true);

		act(() => harness.disconnect());
		act(() => harness.reconnect());
		act(() =>
			harness.deliver({
				type: "state",
				sessionId: session.id,
				isStreaming: false,
				isCompacting: false,
			}),
		);
		act(() =>
			harness.deliver({
				type: "entries",
				sessionId: session.id,
				entries: [
					{
						type: "message",
						message: { role: "user", content: "work", timestamp: 1 },
					},
				],
			}),
		);

		expect(harness.current?.running).toBe(false);
		expect(harness.current?.streaming).toBe("");
		expect(harness.current?.thinking).toBe("");
		expect(harness.current?.toolCalls).toEqual({});
		expect(harness.current?.retryDraft?.text).toBe("work");
		expect(
			(harness.current?.messages ?? [])
				.filter((message) => message.role === "user")
				.map(messageText),
		).toEqual(["work"]);
	});
});
