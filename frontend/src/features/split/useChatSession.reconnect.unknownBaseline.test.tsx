import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

describe("useChatSession reconnect unknown baseline", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	it("does not complete an uncertain run from an old identical turn when the baseline is unknown", () => {
		// Submit lands before any history snapshot: the baseline count is unknown.
		act(() => {
			harness.current?.submit({ text: "hello", image: null });
		});

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
						message: { role: "user", content: "hello", timestamp: 1 },
					},
					{
						type: "message",
						message: { role: "assistant", content: "old reply", timestamp: 2 },
					},
				],
			}),
		);

		// The stale identical turn must not pose as completion: retry is restored.
		expect(harness.current?.running).toBe(false);
		expect(harness.current?.retryDraft?.text).toBe("hello");
		expect(harness.current?.streaming).toBe("");
		expect(harness.current?.toolCalls).toEqual({});

		// Retry submits exactly one new prompt.
		act(() => {
			harness.current?.submit({ text: "hello", image: null });
		});
		expect(harness.sent.filter((frame) => frame.type === "chat.send")).toHaveLength(2);
	});
});
