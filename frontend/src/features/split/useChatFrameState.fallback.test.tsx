import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatFrameState } from "./useChatFrameState";
import { parseChatServerFrame } from "../../lib/chatWsParse";

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** A request frame the panel does not recognise must land in the dock state
 *  as a minimal fallback entry — never dropped silently. */
it("keeps an unknown-method request visible in the approval dock state", () => {
	// Given
	const raw = {
		type: "approval",
		sessionId: "s",
		id: "u1",
		method: "gate.omega",
		title: "Deploy to prod?",
		message: "Approve the rollout",
	};
	const frame = parseChatServerFrame(raw);
	const captured: { current?: ReturnType<typeof useChatFrameState> } = {};
	function Probe() {
		captured.current = useChatFrameState();
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		act(() => root.render(<Probe />));
		// When
		if (frame === null) throw new Error("unknown-method approval frame dropped by the parser");
		act(() => captured.current?.handleFrame(frame));
		// Then
		expect(captured.current?.pendingApproval).toMatchObject({
			id: "u1",
			method: "fallback",
			title: "Deploy to prod?",
			message: "Approve the rollout",
		});
	} finally {
		act(() => root.unmount());
	}
});

/** Known methods keep their exact current state paths. */
it("keeps a known select request on its exact current path", () => {
	// Given
	const raw = { type: "approval", sessionId: "s", id: "a1", method: "select", options: ["yes", "no"] };
	const frame = parseChatServerFrame(raw);
	const captured: { current?: ReturnType<typeof useChatFrameState> } = {};
	function Probe() {
		captured.current = useChatFrameState();
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		act(() => root.render(<Probe />));
		// When
		if (frame === null) throw new Error("select approval frame rejected");
		act(() => captured.current?.handleFrame(frame));
		// Then
		expect(captured.current?.pendingApproval).toEqual({
			id: "a1",
			method: "select",
			options: ["yes", "no"],
		});
	} finally {
		act(() => root.unmount());
	}
});
