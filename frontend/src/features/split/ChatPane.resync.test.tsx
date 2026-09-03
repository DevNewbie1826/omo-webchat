import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { I18nContext } from "../../i18n";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";
import {
	chatSession,
	ControlledResizeObserver,
	i18n,
	renderChatPane,
	requireElement,
} from "./chatPaneTestHarness";

function resyncButton(root: { container: HTMLElement }): HTMLButtonElement {
	return requireElement(
		root.container.querySelector<HTMLButtonElement>(".th-chat-resync-btn"),
		"resync control",
	);
}

function ready(resumed = true): ChatServerFrame {
	return { type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed };
}

function terminalEntries(content = "from server"): ChatServerFrame {
	return {
		type: "entries",
		sessionId: "chat-1",
		entries: [
			{ type: "message", message: { role: "user", content, timestamp: 1 } },
		],
		final: true,
	};
}

function settleInitial(deliver: (frame: ChatServerFrame) => void): void {
	act(() => {
		deliver(ready());
		deliver(terminalEntries());
	});
}

interface SessionProbeState {
	readonly connected: boolean;
	readonly historyStatus: "loading" | "loaded" | "failed";
	readonly resyncBusy: boolean;
	readonly resyncDisabled: boolean;
}

function renderSessionProbe(root: Root): {
	readonly deliver: (frame: ChatServerFrame) => void;
	readonly reconnect: () => void;
	readonly disconnect: () => void;
	readonly resync: () => boolean;
	readonly state: () => SessionProbeState;
} {
	let handlers: Parameters<ChatConnector>[0] | undefined;
	let resync = (): boolean => false;
	let state: SessionProbeState | undefined;
	const connect: ChatConnector = (nextHandlers) => {
		handlers = nextHandlers;
		nextHandlers.onOpen?.();
		return { send: vi.fn(() => true), close: vi.fn() };
	};
	function Probe() {
		const chat = useChatSession(chatSession, connect);
		resync = chat.resync;
		state = {
			connected: chat.connected,
			historyStatus: chat.historyStatus,
			resyncBusy: chat.resyncBusy,
			resyncDisabled: chat.resyncDisabled,
		};
		return <div data-testid="messages">{chat.messages.map(messageText).join("|")}</div>;
	}
	act(() => {
		root.render(
			<I18nContext.Provider value={i18n}>
				<Probe />
			</I18nContext.Provider>,
		);
	});
	return {
		deliver: (frame) => handlers?.onFrame(frame),
		reconnect: () => handlers?.onOpen?.(),
		disconnect: () => handlers?.onClose?.(1006),
		resync: () => resync(),
		state: () => {
			if (!state) throw new Error("session probe did not render");
			return state;
		},
	};
}

describe("ChatPane resync", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		ControlledResizeObserver.instances = [];
		container.remove();
		vi.unstubAllGlobals();
	});

	it("does not let a delayed initial-attach ready satisfy a later resync", () => {
		const { deliver, sent } = renderChatPane(root);

		act(() => deliver(terminalEntries("initial branch")));
		expect(resyncButton({ container }).disabled).toBe(false);
		act(() => resyncButton({ container }).click());

		act(() => deliver(ready()));
		expect(resyncButton({ container }).disabled).toBe(true);
		expect(resyncButton({ container }).getAttribute("aria-busy")).toBe("true");
		expect(sent.filter((frame) => frame.type === "chat.close")).toHaveLength(1);

		act(() => deliver(terminalEntries("refreshed branch")));
		expect(resyncButton({ container }).disabled).toBe(false);
	});

	it("retires an in-flight resync on disconnect and converges on reconnect history", () => {
		const probe = renderSessionProbe(root);
		settleInitial(probe.deliver);

		act(() => {
			expect(probe.resync()).toBe(true);
		});
		act(() => probe.disconnect());
		expect(probe.state()).toMatchObject({
			connected: false,
			resyncBusy: false,
			resyncDisabled: true,
		});

		act(() => {
			probe.reconnect();
			probe.deliver(ready());
			probe.deliver(terminalEntries("reconnect branch"));
		});

		expect(probe.state()).toMatchObject({
			connected: true,
			historyStatus: "loaded",
			resyncBusy: false,
			resyncDisabled: false,
		});
		const transcript = requireElement(container.querySelector('[data-testid="messages"]'), "message probe");
		expect(transcript.textContent).toContain("reconnect branch");
	});

	it("closes a ready-only fresh attach before claiming a later resync terminal", () => {
		const probe = renderSessionProbe(root);

		act(() => probe.deliver(ready(false)));
		expect(probe.state().historyStatus).toBe("loaded");
		expect(probe.state().resyncDisabled).toBe(false);

		act(() => {
			expect(probe.resync()).toBe(true);
			probe.deliver(terminalEntries("resynced after fresh attach"));
		});

		expect(probe.state().historyStatus).toBe("loaded");
		expect(probe.state().resyncBusy).toBe(false);
		const transcript = requireElement(container.querySelector('[data-testid="messages"]'), "message probe");
		expect(transcript.textContent).toContain("resynced after fresh attach");
	});

	it("exposes manual resync busy separately from disabled state", () => {
		const probe = renderSessionProbe(root);

		expect(probe.state()).toMatchObject({
			connected: true,
			historyStatus: "loading",
			resyncBusy: false,
			resyncDisabled: true,
		});

		act(() => probe.deliver(ready(false)));
		expect(probe.state().resyncDisabled).toBe(false);

		act(() => probe.disconnect());
		expect(probe.state()).toMatchObject({
			connected: false,
			resyncBusy: false,
			resyncDisabled: true,
		});

		act(() => {
			probe.reconnect();
			probe.deliver(ready(false));
		});
		act(() => {
			expect(probe.resync()).toBe(true);
		});
		expect(probe.state()).toMatchObject({ resyncBusy: true, resyncDisabled: true });
	});

	it("gates a repeated click while the first replay is pending", () => {
		const { deliver, sent } = renderChatPane(root);
		act(() => deliver(terminalEntries("initial branch")));

		act(() => resyncButton({ container }).click());
		act(() => deliver(ready()));
		act(() => resyncButton({ container }).click());

		expect(sent.filter((frame) => frame.type === "chat.close")).toHaveLength(1);
		expect(sent.filter((frame) => frame.type === "chat.create")).toHaveLength(2);
		expect(resyncButton({ container }).disabled).toBe(true);
	});

	it("replaces a divergent branch while preserving only messages received after the click", () => {
		const { deliver, resync } = renderSessionProbe(root);
		settleInitial(deliver);
		act(() => deliver({
			type: "message",
			sessionId: "chat-1",
			message: { role: "assistant", blocks: [{ kind: "text", text: "obsolete branch" }], ts: 2 },
		}));

		act(() => {
			expect(resync()).toBe(true);
		});
		act(() => deliver({
			type: "message",
			sessionId: "chat-1",
			message: { role: "assistant", blocks: [{ kind: "text", text: "post-click delta" }], ts: 3 },
		}));
		act(() => {
			deliver(ready());
			deliver(terminalEntries("refreshed branch"));
		});

		const transcript = requireElement(container.querySelector('[data-testid="messages"]'), "message probe");
		expect(transcript.textContent).toContain("refreshed branch");
		expect(transcript.textContent).toContain("post-click delta");
		expect(transcript.textContent).not.toContain("obsolete branch");
	});

	it("is gated while initial history, a run, or compaction is in flight", () => {
		const { deliver } = renderChatPane(root);
		expect(resyncButton({ container }).disabled).toBe(true);
		settleInitial(deliver);

		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		expect(resyncButton({ container }).disabled).toBe(true);

		act(() => deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" }));
		expect(resyncButton({ container }).disabled).toBe(false);

		act(() => deliver({ type: "compaction.started", sessionId: "chat-1" }));
		expect(resyncButton({ container }).disabled).toBe(true);

		act(() => deliver({ type: "compaction.done", sessionId: "chat-1" }));
		expect(resyncButton({ container }).disabled).toBe(false);
	});

	it("clears the busy state and surfaces a terminal history error", () => {
		const { deliver } = renderChatPane(root);
		settleInitial(deliver);
		act(() => resyncButton({ container }).click());

		act(() => deliver({
			type: "error",
			sessionId: "chat-1",
			code: "initialize_failed",
			message: "resync failed",
		}));

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(container.textContent).not.toContain("chat.resyncBusy");
		const error = requireElement(container.querySelector(".th-chat-error"), "surfaced resync failure");
		expect(error.textContent).toBe("resync failed");
	});

	it.each([
		"no_chat",
		"unsupported_provider",
		"adoption_required",
		"bad_create",
		"start_failed",
		"session-active",
	] as const)("treats chat.create error %s as a resync terminal", (code) => {
		const { deliver } = renderChatPane(root);
		settleInitial(deliver);
		act(() => resyncButton({ container }).click());

		act(() => deliver({
			type: "error",
			sessionId: "chat-1",
			code,
			message: `${code} failure`,
		}));

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(resyncButton({ container }).getAttribute("aria-busy")).not.toBe("true");
		const error = requireElement(container.querySelector(".th-chat-error"), "surfaced create failure");
		expect(error.textContent).toBe(`${code} failure`);
	});

	it("clears the busy state on the matching terminal entries frame", () => {
		const { deliver } = renderChatPane(root);
		settleInitial(deliver);
		act(() => resyncButton({ container }).click());

		act(() => deliver(terminalEntries()));

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(container.textContent).not.toContain("chat.resyncBusy");
	});
});
