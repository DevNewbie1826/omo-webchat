import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText } from "./chatEntries";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

describe("useChatSession reconnect completed run", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	it("does not offer a retry draft when a reconnected run completes before the deferred entries(final) arrives (f2f5926)", () => {
		// Known baseline: initial history loads before the submit.
		act(() => harness.deliver({ type: "entries", sessionId: session.id, entries: [] }));
		act(() => {
			harness.current?.submit({ text: "work", image: null });
		});
		// Streaming starts; live surfaces arm.
		act(() => {
			harness.deliver({
				type: "messageDelta",
				sessionId: session.id,
				delta: { kind: "text_delta", delta: "partial" },
			});
		});
		expect(harness.current?.running).toBe(true);

		// Mid-run disconnect makes the run uncertain until history reattaches.
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
		// f2f5926 frame order: run.done (run completes server-side) arrives
		// BEFORE the deferred omo history walk releases entries(final).
		act(() => harness.deliver({ type: "run.done", sessionId: session.id, reason: "stop" }));
		act(() =>
			harness.deliver({
				type: "entries",
				sessionId: session.id,
				entries: [
					{
						type: "message",
						message: { role: "user", content: "work", timestamp: 1 },
					},
					{
						type: "message",
						message: { role: "assistant", content: "the reply", timestamp: 2 },
					},
				],
			}),
		);

		// The completed run must NOT be recovered as lost: no retry draft.
		expect(harness.current?.retryDraft).toBeNull();
		expect(harness.current?.running).toBe(false);
		// And the authoritative assistant reply is rendered.
		expect(
			(harness.current?.messages ?? []).map(messageText),
		).toEqual(["work", "the reply"]);
	});
});
