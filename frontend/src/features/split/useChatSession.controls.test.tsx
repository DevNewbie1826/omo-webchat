import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession control transactions", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: ReturnType<typeof useChatSession> | undefined;
	let deliver: (frame: ChatServerFrame) => void;
	let disconnect: () => void;
	let sent: ChatClientFrame[];
	let send: (frame: ChatClientFrame) => boolean;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sent = [];
		send = (frame) => {
			sent.push(frame);
			return true;
		};
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			disconnect = () => handlers.onClose?.(1006);
			handlers.onOpen?.();
			return { send: (frame) => send(frame), close: () => undefined };
		};
		function Probe() {
			current = useChatSession(session, connect);
			return null;
		}
		act(() => root.render(<Probe />));
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	const deliveredSets = (): ChatClientFrame[] =>
		sent.filter((frame) => frame.type === "chat.set");

	const lastRequestId = (type: ChatClientFrame["type"]): string => {
		const matches = sent.filter((frame) => frame.type === type);
		const last = matches[matches.length - 1];
		if (!last || !("requestId" in last) || last.requestId === undefined) {
			throw new Error(`no requestId captured on last ${type} frame`);
		}
		return last.requestId;
	};

	it("commits model changes on ack, blocks double-submit, and rolls back to the last ack on error", () => {
		act(() =>
			deliver({
				type: "state",
				sessionId: session.id,
				isStreaming: false,
				isCompacting: false,
				thinkingLevel: "medium",
				model: { provider: "mock", modelId: "m1" },
			}),
		);
		expect(current?.currentModelKey).toBe("mock/m1");

		let accepted = false;
		act(() => {
			accepted = current?.changeModel("mock/m2") ?? false;
		});
		expect(accepted).toBe(true);
		expect(current?.currentModelKey).toBe("mock/m2");

		act(() => {
			accepted = current?.changeModel("mock/m3") ?? false;
		});
		expect(accepted).toBe(false);
		expect(deliveredSets()).toHaveLength(1);

		act(() =>
			deliver({ type: "ack", sessionId: session.id, command: "set_model", requestId: lastRequestId("chat.set") }),
		);
		act(() => {
			accepted = current?.changeModel("mock/m3") ?? false;
		});
		expect(accepted).toBe(true);
		expect(deliveredSets()).toHaveLength(2);

		act(() =>
			deliver({
				type: "error",
				sessionId: session.id,
				code: "provider_error",
				command: "set_model",
				requestId: lastRequestId("chat.set"),
				message: "model rejected",
			}),
		);
		expect(current?.currentModelKey).toBe("mock/m2");
		expect(current?.error).toBe("model rejected");

		act(() => {
			accepted = current?.changeModel("mock/m3") ?? false;
		});
		expect(accepted).toBe(true);
		expect(deliveredSets()).toHaveLength(3);
	});

	it("rolls back thinking level to the last state-confirmed value on error", () => {
		act(() =>
			deliver({
				type: "state",
				sessionId: session.id,
				isStreaming: false,
				isCompacting: false,
				thinkingLevel: "low",
			}),
		);
		expect(current?.thinkingLevel).toBe("low");

		act(() => current?.changeThinkingLevel("high"));
		expect(current?.thinkingLevel).toBe("high");

		act(() =>
			deliver({
				type: "error",
				sessionId: session.id,
				code: "provider_error",
				command: "set_thinking_level",
				requestId: lastRequestId("chat.set"),
				message: "thinking rejected",
			}),
		);
		expect(current?.thinkingLevel).toBe("low");
		expect(current?.error).toBe("thinking rejected");
	});

	it("keeps approval single-submit until ack and restores the request on later failure", () => {
		act(() =>
			deliver({
				type: "approval",
				sessionId: session.id,
				id: "ap-1",
				method: "confirm",
			}),
		);

		let responded = false;
		act(() => {
			responded = current?.respondApproval({ confirmed: true }) ?? false;
		});
		expect(responded).toBe(true);
		expect(current?.pendingApproval).toBeNull();

		act(() => {
			responded = current?.respondApproval({ confirmed: true }) ?? false;
		});
		expect(responded).toBe(false);
		expect(
			sent.filter((frame) => frame.type === "approval.respond"),
		).toHaveLength(1);

		act(() =>
			deliver({
				type: "ack",
				sessionId: session.id,
				command: "extension_ui_response",
				id: "ap-1",
				requestId: lastRequestId("approval.respond"),
			}),
		);
		act(() =>
			deliver({
				type: "error",
				sessionId: session.id,
				code: "approval_failed",
				command: "extension_ui_response",
				requestId: lastRequestId("approval.respond"),
				message: "approval expired",
			}),
		);
		expect(current?.pendingApproval?.id).toBe("ap-1");
		expect(current?.error).toBe("approval expired");

		act(() => {
			responded = current?.respondApproval({ confirmed: true }) ?? false;
		});
		expect(responded).toBe(true);
		expect(
			sent.filter((frame) => frame.type === "approval.respond"),
		).toHaveLength(2);
	});

	it("rolls back pending controls on disconnect", () => {
		act(() =>
			deliver({
				type: "state",
				sessionId: session.id,
				isStreaming: false,
				isCompacting: false,
				thinkingLevel: "low",
				model: { provider: "mock", modelId: "m1" },
			}),
		);
		act(() => current?.changeModel("mock/m2"));
		expect(current?.currentModelKey).toBe("mock/m2");

		act(() => disconnect());

		expect(current?.currentModelKey).toBe("mock/m1");
	});

	it("surfaces stop send failures instead of failing silently", () => {
		send = () => false;

		let stopped = true;
		act(() => {
			stopped = current?.stop() ?? true;
		});

		expect(stopped).toBe(false);
		expect(current?.error).not.toBe("");
	});
});
