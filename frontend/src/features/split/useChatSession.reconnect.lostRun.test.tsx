import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

describe("useChatSession reconnect lost run", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	it("requires explicit recovery of an unconfirmed run (user entry, no reply, no run.done)", () => {
		// Known baseline: initial history loads before the submit.
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
		});
		expect(harness.current?.running).toBe(true);

		// Mid-run disconnect; the run is uncertain. No run.done ever arrives.
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

		// Missing reply is not proof of failure: explicit recovery restores the original.
		expect(harness.current?.retryDraft).toBeNull();
    expect(harness.current?.sendRequests).toMatchObject([{ phase: "unknown", draft: { text: "work" } }]);
    const requestId = harness.current!.sendRequests[0]!.requestId;
    act(() => harness.current?.recoverFailedDraft(requestId));
    expect(harness.current?.retryDraft?.text).toBe("work");
		expect(harness.current?.running).toBe(false);
	});
});
