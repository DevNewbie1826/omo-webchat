import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

describe("useChatSession reconnect echoed in-flight", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	it("recovers an echoed in-flight run when disconnect lands before the assistant reply", () => {
		// Known baseline: initial history loads before the submit.
		act(() => harness.deliver({ type: "entries", sessionId: session.id, entries: [] }));
		act(() => {
			harness.current?.submit({ text: "work", image: null });
		});
		// The server echoes the user message, removing the display-pending row.
		act(() =>
			harness.deliver({
				type: "message",
				sessionId: session.id,
				message: { role: "user", blocks: [{ kind: "text", text: "work" }] },
			}),
		);
		// Live surfaces populate before any assistant reply arrives.
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

		// The echoed run is recovered: stale surfaces clear and retry is restored.
		expect(harness.current?.running).toBe(false);
		expect(harness.current?.streaming).toBe("");
		expect(harness.current?.thinking).toBe("");
		expect(harness.current?.toolCalls).toEqual({});
		expect(harness.current?.retryDraft?.text).toBe("work");
	});
});
