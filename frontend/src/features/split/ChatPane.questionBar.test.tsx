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
import { requireElement, setTextareaValue } from "./chatPaneTestHarness";

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
		const band = container.querySelector(".th-question-band");
		expect(band).not.toBeNull();
		// Non-blocking: no auto-opened window, no takeover of the column.
		expect(document.querySelector(".th-modal")).toBeNull();

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
		// The band is still present with the question still pending, and the
		// window opens only from the band's Open button.
		expect(container.querySelector(".th-question-band")).not.toBeNull();
		expect(document.querySelector(".th-modal")).toBeNull();
		act(() => {
			container
				.querySelector<HTMLButtonElement>(".th-question-band-open")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(document.querySelector(".th-modal")).not.toBeNull();
		expect(document.querySelector(".th-modal")?.textContent).toContain("Which stack?");
	});

	it("answering through the band-opened window sends the structured answer and dismisses it", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));
		expect(container.querySelector(".th-question-band")).not.toBeNull();
		act(() => {
			container
				.querySelector<HTMLButtonElement>(".th-question-band-open")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const option = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find((button) => button.textContent === "Go");
		expect(option).toBeDefined();
		act(() => {
			option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		// The panel answers with one structured response on its explicit Submit
		// (the window contract), unlike the retired bar's instant single-select.
		const submit = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.submit");
		expect(submit).toBeDefined();
		act(() => {
			submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(sent).toContainEqual({
			type: "approval.respond",
			sessionId: "chat-1",
			requestId: expect.any(String),
			id: "ask-1",
			answers: { q1: { selected: ["Go"] } },
		});
		expect(container.querySelector(".th-question-band")).toBeNull();
		expect(document.querySelector(".th-modal")).toBeNull();
	});

	it("a rejected response restores the question to its band without reopening the window", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));
		// Non-blocking arrival: band only, no auto-opened window.
		expect(container.querySelector(".th-question-band")).not.toBeNull();
		expect(document.querySelector(".th-modal")).toBeNull();
		// Open the window explicitly from the band, choose an option, submit.
		act(() => {
			container
				.querySelector<HTMLButtonElement>(".th-question-band-open")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const option = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find((button) => button.textContent === "Go");
		expect(option).toBeDefined();
		act(() => {
			option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const submit = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.submit");
		expect(submit).toBeDefined();
		act(() => {
			submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(sent).toContainEqual({
			type: "approval.respond",
			sessionId: "chat-1",
			requestId: expect.any(String),
			id: "ask-1",
			answers: { q1: { selected: ["Go"] } },
		});
		// The optimistic removal dismisses both band and window.
		expect(container.querySelector(".th-question-band")).toBeNull();
		expect(document.querySelector(".th-modal")).toBeNull();
		// The server rejects the response: an error carrying the response's
		// requestId and the extension_ui_response command rolls the request
		// back (the same non-blocking id is pending again).
		const response = sent.find((frame) => frame.type === "approval.respond");
		if (!response || response.type !== "approval.respond") {
			throw new Error("missing approval.respond frame");
		}
		const requestId = requireElement(response.requestId, "response request id");
		act(() => {
			deliver({
				type: "error",
				sessionId: "chat-1",
				command: "extension_ui_response",
				requestId,
				message: "rejected",
			});
		});
		// The restored non-blocking question stays in its notice band; no dialog
		// opens and no tab takes focus without a second explicit Open gesture —
		// the same contract as the initial arrival.
		expect(container.querySelector(".th-question-band")).not.toBeNull();
		expect(document.querySelector(".th-modal")).toBeNull();
		expect(document.activeElement).not.toBe(
			document.querySelector(".th-approval-question-tab"),
		);
	});

	it("a request without the non-blocking flag auto-opens the window (blocking presentation)", () => {
		const { deliver } = renderWithFakeConnect();
		const { nonBlocking: _omitted, ...blockingFrame } = QUESTION_FRAME;
		act(() => deliver(blockingFrame));
		expect(document.querySelector(".th-modal")).not.toBeNull();
		expect(container.querySelector(".th-question-band")).not.toBeNull();
	});

	it("a request with nonBlocking: false auto-opens the window (blocking presentation)", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => deliver({ ...QUESTION_FRAME, nonBlocking: false }));
		expect(document.querySelector(".th-modal")).not.toBeNull();
		expect(container.querySelector(".th-question-band")).not.toBeNull();
	});

	it("the composer's focus and draft are untouched when the band appears", () => {
		const { deliver } = renderWithFakeConnect();
		const textarea = composer();
		act(() => {
			textarea.focus();
			setTextareaValue(textarea, "draft in progress");
		});
		expect(document.activeElement).toBe(textarea);

		act(() => deliver(QUESTION_FRAME));

		// The band announces the question without touching focus or typing;
		// the window (which would take focus) stays closed until opened.
		expect(container.querySelector(".th-question-band")).not.toBeNull();
		expect(document.querySelector(".th-modal")).toBeNull();
		expect(document.activeElement).toBe(textarea);
		expect(textarea.value).toBe("draft in progress");
	});
});
