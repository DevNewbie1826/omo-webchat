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
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			multiSelect: true,
			options: [
				{ label: "Go", description: "Backend services" },
				{ label: "TS", description: "Frontend app" },
			],
		},
		{
			id: "q2",
			header: "Region",
			question: "Which region?",
			options: [{ label: "us-east" }, { label: "eu-west" }],
		},
	],
};

describe("ChatPane structured question dock panel", () => {
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

	const click = (el: HTMLElement | undefined): void => {
		act(() => {
			el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	};

	it("renders one dock panel with a tab per question", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));

		expect(container.querySelectorAll(".th-approval-dock")).toHaveLength(1);
		const tabs = Array.from(
			container.querySelectorAll<HTMLButtonElement>('.th-approval-dock [role="tab"]'),
		);
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Stack", "Region"]);
	});

	it("submitting sends one structured response keyed by question id, with the comment", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));

		const option = (label: string): HTMLButtonElement | undefined =>
			Array.from(
				container.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
			).find((button) => button.textContent?.includes(label));

		click(option("Go"));
		click(option("TS"));
		const regionTab = Array.from(
			container.querySelectorAll<HTMLButtonElement>('.th-approval-dock [role="tab"]'),
		).find((tab) => tab.textContent === "Region");
		click(regionTab);
		click(option("eu-west"));

		const comment = container.querySelector<HTMLInputElement>(
			".th-approval-question-comment",
		);
		expect(comment).not.toBeNull();
		act(() => {
			if (!comment) return;
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(comment, "ship it");
			comment.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const submit = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
		).find((button) => button.textContent === "approval.submit");
		click(submit);

		expect(sent).toContainEqual({
			type: "approval.respond",
			sessionId: "chat-1",
			requestId: expect.any(String),
			id: "ask-1",
			answers: {
				q1: { selected: ["Go", "TS"] },
				q2: { selected: ["eu-west"] },
			},
			comment: "ship it",
		});
		// The answered request leaves the pane.
		expect(container.querySelector(".th-approval-dock")).toBeNull();
	});

	it("a single-question request keeps the compact one-line bar, not the tabbed panel", () => {
		const { deliver } = renderWithFakeConnect();
		act(() =>
			deliver({
				type: "approval",
				sessionId: "chat-1",
				id: "ask-single",
				method: "question",
				nonBlocking: true,
				questions: [
					{ id: "q1", question: "Which stack?", options: [{ label: "Go" }, { label: "TS" }] },
				],
			}),
		);

		expect(container.querySelector(".th-question-bar")).not.toBeNull();
		expect(container.querySelector(".th-approval-dock")).toBeNull();
	});

	it("a single-question request without the nonBlocking flag renders the dock panel", () => {
		const { deliver } = renderWithFakeConnect();
		act(() =>
			deliver({
				type: "approval",
				sessionId: "chat-1",
				id: "ask-blocking",
				method: "question",
				questions: [
					{ id: "q1", question: "Which stack?", options: [{ label: "Go" }, { label: "TS" }] },
				],
			}),
		);

		expect(container.querySelector(".th-approval-dock .th-approval-question")).not.toBeNull();
		expect(container.querySelector(".th-question-bar")).toBeNull();
	});

	it("a normal composer send does not answer the pending question", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => deliver(QUESTION_FRAME));
		expect(container.querySelector(".th-approval-dock")).not.toBeNull();

		const textarea = composer();
		act(() => setTextareaValue(textarea, "just a normal message"));
		act(() => {
			textarea.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});

		expect(
			sent.some(
				(frame) =>
					frame.type === "chat.send" &&
					JSON.stringify(frame).includes("just a normal message"),
			),
		).toBe(true);
		expect(sent.some((frame) => frame.type === "approval.respond")).toBe(false);
		expect(container.querySelector(".th-approval-dock")).not.toBeNull();
	});
});
