import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type {
	ChatClient,
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { setTextareaValue } from "./chatPaneTestHarness";

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

const QUESTION_FRAME: ChatServerFrame = {
	type: "approval",
	sessionId: "chat-1",
	id: "ask-1",
	method: "question",
	nonBlocking: true,
	questions: [
		{
			id: "q1",
			question: "Which stack?",
			options: [{ label: "Go" }, { label: "TS" }],
		},
	],
};

describe("ChatPane non-blocking question widget", () => {
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

	function renderWithFakeConnect(): {
		deliver: (frame: ChatServerFrame) => void;
		sent: ChatClientFrame[];
	} {
		let deliver: ((frame: ChatServerFrame) => void) | undefined;
		const sent: ChatClientFrame[] = [];
		const send = vi.fn((m: ChatClientFrame) => {
			sent.push(m);
			return true;
		});
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			const client: ChatClient = { send, close: vi.fn() };
			return client;
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
		return { deliver: (f) => deliver?.(f), sent };
	}

	function composer(): HTMLTextAreaElement {
		const textarea = container.querySelector<HTMLTextAreaElement>(
			".th-chat-input textarea",
		);
		if (!textarea) throw new Error("missing composer textarea");
		return textarea;
	}

	it("a normal send does not answer the pending question", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));
		expect(container.querySelector(".th-question-bar")).not.toBeNull();

		const textarea = composer();
		act(() => setTextareaValue(textarea, "just a normal message"));
		act(() => {
			textarea.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});

		// The ordinary message went out as a chat send…
		expect(
			sent.some(
				(frame) =>
					frame.type === "chat.send" &&
					JSON.stringify(frame).includes("just a normal message"),
			),
		).toBe(true);
		// …and nothing answered the question.
		expect(sent.some((frame) => frame.type === "approval.respond")).toBe(false);
		// The widget is still present with the question still pending.
		const bar = container.querySelector(".th-question-bar");
		expect(bar).not.toBeNull();
		expect(bar?.textContent).toContain("Which stack?");
	});

	it("answering through the widget sends the structured answer and dismisses it", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));
		const bar = container.querySelector(".th-question-bar");
		expect(bar).not.toBeNull();
		const option = Array.from(
			bar?.querySelectorAll<HTMLButtonElement>("button") ?? [],
		).find((button) => button.textContent === "Go");
		expect(option).toBeDefined();
		act(() => {
			option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(sent).toContainEqual({
			type: "approval.respond",
			sessionId: "chat-1",
			requestId: expect.any(String),
			id: "ask-1",
			answers: { q1: { selected: ["Go"] } },
		});
		expect(container.querySelector(".th-question-bar")).toBeNull();
	});

	it("a request without the non-blocking flag keeps the blocking dock presentation", () => {
		const { deliver } = renderWithFakeConnect();
		const { nonBlocking: _omitted, ...blockingFrame } = QUESTION_FRAME;
		act(() => deliver(blockingFrame));
		expect(container.querySelector(".th-question-bar")).toBeNull();
		expect(container.querySelector(".th-approval-dock")).not.toBeNull();
	});

	it("a request with nonBlocking: false keeps the blocking dock presentation", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => deliver({ ...QUESTION_FRAME, nonBlocking: false }));
		expect(container.querySelector(".th-question-bar")).toBeNull();
		expect(container.querySelector(".th-approval-dock")).not.toBeNull();
	});

	it("the composer's focus and draft are untouched when the widget appears", () => {
		const { deliver } = renderWithFakeConnect();
		const textarea = composer();
		act(() => {
			textarea.focus();
			setTextareaValue(textarea, "draft in progress");
		});
		expect(document.activeElement).toBe(textarea);

		act(() => deliver(QUESTION_FRAME));

		expect(container.querySelector(".th-question-bar")).not.toBeNull();
		expect(document.activeElement).toBe(textarea);
		expect(textarea.value).toBe("draft in progress");
	});
});
