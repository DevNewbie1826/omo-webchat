import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { ControlledResizeObserver } from "./chatPaneTestHarness";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

const koI18n: I18nValue = {
	lang: "ko",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => translate("ko", key),
};

describe("ChatPane run.started responding indicator", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: (frame: ChatServerFrame) => void;
	let sent: ChatClientFrame[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sent = [];
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return {
				send: (frame) => {
					sent.push(frame);
					return true;
				},
				close: vi.fn(),
			};
		};
		act(() =>
			root.render(
				<I18nContext.Provider value={koI18n}>
					<ChatPane
						chatSession={session}
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
			),
		);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		ControlledResizeObserver.instances = [];
		container.remove();
		vi.unstubAllGlobals();
	});

	it("shows the responding label on an unsolicited run.started, clears stale errors, and run.done hides it", () => {
		expect(container.querySelector(".th-chat-status-item--live")).toBeNull();

		act(() => {
			deliver({ type: "error", sessionId: "chat-1", message: "stale error" });
		});
		expect(container.querySelector(".th-chat-error")?.textContent).toBe("stale error");

		// Provider-initiated run (e.g. an Omo triggerTurn continuation): the
		// frame arrives unsolicited — no chat.send is produced — and arms the
		// running UI.
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
		});
		expect(container.querySelector(".th-chat-status-item--live")?.textContent).toBe(
			translate("ko", "chat.responding"),
		);
		expect(container.querySelector(".th-chat-error")).toBeNull();
		expect(sent.filter((frame) => frame.type === "chat.send")).toHaveLength(0);

		act(() => {
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});
		expect(container.querySelector(".th-chat-status-item--live")).toBeNull();
	});

	it("clears a prior done banner when a provider-initiated run starts", () => {
		// A completed run shows the done banner.
		act(() => {
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});
		expect(container.querySelector(".th-chat-done")).not.toBeNull();

		// A provider-initiated run starts: the done banner must clear so it
		// does not show alongside the responding indicator.
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
		});
		expect(container.querySelector(".th-chat-done")).toBeNull();
		expect(container.querySelector(".th-chat-status-item--live")).not.toBeNull();
	});

	it("clears a prior done banner when a streaming state arms a run on reattach", () => {
		// A completed run shows the done banner.
		act(() => {
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});
		expect(container.querySelector(".th-chat-done")).not.toBeNull();

		// A reconnecting client learns the run is live from the attach-time
		// state snapshot: the done banner must clear so it does not show
		// alongside the responding indicator.
		act(() => {
			deliver({ type: "state", sessionId: "chat-1", isStreaming: true, isCompacting: false });
		});
		expect(container.querySelector(".th-chat-done")).toBeNull();
		expect(container.querySelector(".th-chat-status-item--live")).not.toBeNull();
	});
});
