import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { transcriptItemKeys } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

const chatSession = {
	id: "chat-1",
	name: "Chat 1",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("ChatPane virtualization", () => {
	it("keeps logical row keys stable when a notice is inserted or dismissed", () => {
		const first: TranscriptItem = { kind: "message", message: { id: "entry-1", role: "user", blocks: [] } };
		const second: TranscriptItem = { kind: "message", message: { optimisticId: 7, role: "user", blocks: [] } };
		const notice: TranscriptItem = { kind: "notice", notice: { id: 9, kind: "retry_fallback_succeeded", payload: null, at: 2 } };
		expect(transcriptItemKeys([first, second])).toEqual(["message:entry-1", "optimistic:7"]);
		expect(transcriptItemKeys([first, notice, second])).toEqual(["message:entry-1", "notice:9", "optimistic:7"]);
	});

	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	it("windows a long history: only a subset of 200 messages is in the DOM", () => {
		let deliver: ((frame: ChatServerFrame) => void) | undefined;
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return { send: vi.fn(() => true), close: vi.fn() };
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

		act(() => {
			for (let i = 0; i < 200; i++) {
				deliver?.({
					type: "message",
					sessionId: "chat-1",
					message: {
						role: i % 2 === 0 ? "user" : "assistant",
						blocks: [{ kind: "text", text: `message ${i}` }],
					},
				});
			}
		});

		const historyMessages = container.querySelectorAll(
			".th-chat-history .th-chat-msg",
		);
		expect(historyMessages.length).toBeLessThan(200);
		expect(historyMessages.length).toBeGreaterThan(0);
	});
});
