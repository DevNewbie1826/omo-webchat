import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mountReconnectHarness,
	session,
	unmountReconnectHarness,
	type ReconnectHarness,
} from "./useChatSession.reconnect.support";

/**
 * C3: the UI must distinguish the four RPC recovery states the c2 seam makes
 * observable — reconnecting (socket lost), resuming (transport re-established,
 * rebinding replay pending), recovered (ready replay observed), and incomplete
 * (the server mapped a resume failure) — instead of collapsing them into one
 * generic connected flag.
 */
describe("useChatSession recovery states", () => {
	let harness: ReconnectHarness;

	beforeEach(() => {
		harness = mountReconnectHarness();
	});

	afterEach(async () => {
		await unmountReconnectHarness(harness);
	});

	const ready = (resumed = true) =>
		harness.deliver({
			type: "ready",
			sessionId: session.id,
			piSessionId: "pi-1",
			resumed,
		});

	it("is idle before any disconnect", () => {
		expect(harness.current?.recovery).toBeNull();
	});

	it("distinguishes reconnecting, resuming, and recovered across a drop cycle", () => {
		act(() => ready(false));
		expect(harness.current?.recovery).toBeNull();

		act(() => harness.disconnect());
		expect(harness.current?.recovery?.phase).toBe("reconnecting");

		act(() => harness.reconnect());
		expect(harness.current?.recovery?.phase).toBe("resuming");

		act(() => ready(true));
		expect(harness.current?.recovery?.phase).toBe("recovered");
	});

	it("marks recovery incomplete with the reason when the resume fails mid-recovery", () => {
		act(() => harness.disconnect());
		act(() => harness.reconnect());
		expect(harness.current?.recovery?.phase).toBe("resuming");

		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "resume_failed",
				message: "session is active in another process",
			}),
		);
		expect(harness.current?.recovery?.phase).toBe("incomplete");
		expect(harness.current?.recovery?.reason).toBe(
			"session is active in another process",
		);
	});

	it("never reports an incomplete recovery as recovered when a later ready arrives", () => {
		act(() => harness.disconnect());
		act(() => harness.reconnect());
		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "session-active",
				message: "session is active in another process",
			}),
		);
		act(() => ready(false));
		expect(harness.current?.recovery?.phase).toBe("incomplete");
	});

	it("starts a fresh recovery cycle on the next drop", () => {
		act(() => harness.disconnect());
		act(() => harness.reconnect());
		act(() => ready(true));
		expect(harness.current?.recovery?.phase).toBe("recovered");

		act(() => harness.disconnect());
		expect(harness.current?.recovery?.phase).toBe("reconnecting");
	});

	it("does not label an initial-attach failure as recovery-incomplete", () => {
		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "resume_failed",
				message: "no such session",
			}),
		);
		expect(harness.current?.recovery).toBeNull();
	});

	// Server-driven recovery: an RPC loss keeps the browser socket open, so
	// provider_disconnected — not a close/open pair — starts the cycle, and the
	// automatic rebinding replay's ready completes it without any user action.
	it("starts reconnecting on provider_disconnected while the socket stays open", () => {
		act(() => ready(false));
		expect(harness.current?.recovery).toBeNull();

		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "provider_disconnected",
				message: "provider connection lost",
			}),
		);
		expect(harness.current?.recovery?.phase).toBe("reconnecting");
	});

	it("recovers from a server-driven cycle on the rebinding replay's ready", () => {
		act(() => ready(false));
		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "provider_disconnected",
				message: "provider connection lost",
			}),
		);
		act(() => ready(true));
		expect(harness.current?.recovery?.phase).toBe("recovered");
	});

	it("marks a server-driven cycle incomplete when the automatic resume fails", () => {
		act(() => ready(false));
		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "provider_disconnected",
				message: "provider connection lost",
			}),
		);
		act(() =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "resume_failed",
				message: "session is active in another process",
			}),
		);
		expect(harness.current?.recovery?.phase).toBe("incomplete");
		expect(harness.current?.recovery?.reason).toBe(
			"session is active in another process",
		);

		// A late replay ready must not re-report the failure as a success.
		act(() => ready(true));
		expect(harness.current?.recovery?.phase).toBe("incomplete");
	});

	it("starts a fresh server-driven cycle on the next provider_disconnected", () => {
		act(() => ready(false));
		const loss = () =>
			harness.deliver({
				type: "error",
				sessionId: session.id,
				code: "provider_disconnected",
				message: "provider connection lost",
			});
		act(() => loss());
		act(() => ready(true));
		expect(harness.current?.recovery?.phase).toBe("recovered");

		act(() => loss());
		expect(harness.current?.recovery?.phase).toBe("reconnecting");
		act(() => ready(true));
		expect(harness.current?.recovery?.phase).toBe("recovered");
	});
});
