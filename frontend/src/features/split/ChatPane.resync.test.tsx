import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { I18nContext } from "../../i18n";
import { ChatPane } from "./ChatPane";
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

function ready(): ChatServerFrame {
	return { type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true };
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

function renderSessionProbe(root: Root): {
	readonly deliver: (frame: ChatServerFrame) => void;
	readonly resync: () => boolean;
} {
	let deliver: ((frame: ChatServerFrame) => void) | undefined;
	let resync = (): boolean => false;
	const connect: ChatConnector = (handlers) => {
		deliver = handlers.onFrame;
		handlers.onOpen?.();
		return { send: vi.fn(() => true), close: vi.fn() };
	};
	function Probe() {
		const chat = useChatSession(chatSession, connect);
		resync = chat.resync;
		return <div data-testid="messages">{chat.messages.map(messageText).join("|")}</div>;
	}
	act(() => {
		root.render(
			<I18nContext.Provider value={i18n}>
				<Probe />
			</I18nContext.Provider>,
		);
	});
	return { deliver: (frame) => deliver?.(frame), resync: () => resync() };
}

function renderReconnectable(root: Root): {
	readonly deliver: (frame: ChatServerFrame) => void;
	readonly reconnect: () => void;
	readonly disconnect: () => void;
	readonly sent: ChatClientFrame[];
} {
	let handlers: Parameters<ChatConnector>[0] | undefined;
	const sent: ChatClientFrame[] = [];
	const connect: ChatConnector = (nextHandlers) => {
		handlers = nextHandlers;
		nextHandlers.onOpen?.();
		return {
			send: vi.fn((frame: ChatClientFrame) => {
				sent.push(frame);
				return true;
			}),
			close: vi.fn(),
		};
	};
	act(() => {
		root.render(
			<I18nContext.Provider value={i18n}>
				<ChatPane
					chatSession={chatSession}
					focused
					splitEnabled={false}
					onFocus={() => undefined}
					onSplit={() => undefined}
					onClose={() => undefined}
					onOpenSidebar={() => undefined}
					connect={connect}
					notify={() => undefined}
				/>
			</I18nContext.Provider>,
		);
	});
	return {
		deliver: (frame) => handlers?.onFrame(frame),
		reconnect: () => handlers?.onOpen?.(),
		disconnect: () => handlers?.onClose?.(1006),
		sent,
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

	it("does not let reconnect hydration complete an in-flight resync", () => {
		const { deliver, disconnect, reconnect } = renderReconnectable(root);
		settleInitial(deliver);

		act(() => resyncButton({ container }).click());
		act(() => {
			disconnect();
			reconnect();
			deliver(ready());
			deliver(terminalEntries("reconnect branch"));
		});

		expect(resyncButton({ container }).disabled).toBe(true);
		expect(resyncButton({ container }).getAttribute("aria-busy")).toBe("true");
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

	it("clears the busy state on the matching terminal entries frame", () => {
		const { deliver } = renderChatPane(root);
		settleInitial(deliver);
		act(() => resyncButton({ container }).click());

		act(() => deliver(terminalEntries()));

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(container.textContent).not.toContain("chat.resyncBusy");
	});
});
