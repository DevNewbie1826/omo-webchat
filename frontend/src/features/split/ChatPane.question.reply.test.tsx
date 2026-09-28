import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ChatClientFrame, ChatServerFrame } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import {
	chatSession,
	i18n,
	pressKey,
	requireElement,
	setTextareaValue,
} from "./chatPaneTestHarness";

/** Non-blocking shown question with two options on one question. */
const QUESTION_FRAME: ChatServerFrame = {
	type: "approval",
	sessionId: "chat-1",
	id: "ask-1",
	method: "question",
	nonBlocking: true,
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			options: [{ label: "Go" }, { label: "TS" }],
		},
	],
};

const BLOCKING_FRAME: ChatServerFrame = {
	type: "approval",
	sessionId: "chat-1",
	id: "ask-block",
	method: "question",
	questions: [
		{
			id: "q1",
			header: "Gate",
			question: "Proceed?",
			options: [{ label: "Yes" }, { label: "No" }],
		},
	],
};

describe("ChatPane composer reply mode (omo question parity)", () => {
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
		vi.useRealTimers();
	});

	function render(): {
		deliver: (frame: ChatServerFrame) => void;
		sent: ChatClientFrame[];
	} {
		let deliverFn: ((frame: ChatServerFrame) => void) | undefined;
		const sent: ChatClientFrame[] = [];
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
						connect={(handlers) => {
							deliverFn = handlers.onFrame;
							handlers.onOpen?.();
							return {
								send: vi.fn((frame: ChatClientFrame) => {
									sent.push(frame);
									return true;
								}),
								close: vi.fn(),
							};
						}}
						notify={() => undefined}
					/>
				</I18nContext.Provider>,
			);
		});
		return { deliver: (f) => deliverFn?.(f), sent };
	}

	function composer(): HTMLTextAreaElement {
		return requireElement(
			container.querySelector<HTMLTextAreaElement>(".th-chat-input textarea"),
			"composer textarea",
		);
	}

	it("typing into the empty focused composer enters reply mode and Enter answers with the comment", () => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "h"));
		// The reply label names the shown question's header.
		const label = container.querySelector(".th-chat-reply-label");
		expect(label?.textContent).toContain("question.reply.label");
		act(() => setTextareaValue(textarea, "hello there"));
		act(() => {
			pressKey(textarea, "Enter");
		});
		const respond = sent.find((frame) => frame.type === "approval.respond");
		expect(respond).toMatchObject({
			type: "approval.respond",
			sessionId: "chat-1",
			id: "ask-1",
			comment: "hello there",
		});
		expect(sent.some((frame) => frame.type === "chat.send")).toBe(false);
		// The composer cleared and reply mode ended.
		expect(textarea.value).toBe("");
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
	});

	it("the send button answers as a comment in reply mode (touch submit path)", () => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "button answer"));
		act(() => {
			container
				.querySelector<HTMLButtonElement>(".th-chat-send-btn")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(sent.find((frame) => frame.type === "approval.respond")).toMatchObject({
			id: "ask-1",
			comment: "button answer",
		});
		expect(sent.some((frame) => frame.type === "chat.send")).toBe(false);
	});

	it("sends the reply instead of aborting a running non-blocking question", () => {
		const { deliver, sent } = render();
		act(() => deliver({ type: "state", sessionId: "chat-1", isStreaming: true, isCompacting: false }));
		act(() => deliver(QUESTION_FRAME));
		act(() => setTextareaValue(composer(), "answer while running"));
		const send = requireElement(container.querySelector<HTMLButtonElement>(".th-chat-send-btn"), "send button");
		expect(send.classList.contains("th-btn--danger")).toBe(false);
		expect(send.textContent).toContain("chat.send");
		act(() => send.click());
		expect(sent.filter((frame) => frame.type === "approval.respond")).toHaveLength(1);
		expect(sent.filter((frame) => frame.type === "approval.respond")[0]).toMatchObject({
			id: "ask-1", comment: "answer while running",
		});
		expect(sent.some((frame) => frame.type === "chat.abort")).toBe(false);
	});

	it.each(["/help", "!ls"])("%s never routes to the answer", (text) => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, text));
		// No reply label: a leading / or ! never enters reply mode.
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
		act(() => {
			pressKey(textarea, "Enter");
		});
		expect(sent.some((frame) => frame.type === "approval.respond")).toBe(false);
	});

	it("Alt+Enter sends the text as a normal chat message", () => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "hi"));
		act(() => {
			textarea.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }),
			);
		});
		expect(
			sent.some(
				(frame) => frame.type === "chat.send" && JSON.stringify(frame).includes("hi"),
			),
		).toBe(true);
		expect(sent.some((frame) => frame.type === "approval.respond")).toBe(false);
	});

	it("the send-as-message toggle switches Enter back to a normal message", () => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "toggle me"));
		const toggle = requireElement(
			container.querySelector<HTMLButtonElement>(".th-chat-reply-toggle"),
			"reply toggle",
		);
		expect(toggle.textContent).toBe("question.reply.sendAsMessage");
		act(() => {
			toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(toggle.textContent).toBe("question.reply.backToAnswer");
		act(() => {
			pressKey(textarea, "Enter");
		});
		expect(sent.some((frame) => frame.type === "chat.send")).toBe(true);
		expect(sent.some((frame) => frame.type === "approval.respond")).toBe(false);
	});

	it("digit 2 on the empty composer opens the window with option 2 picked", () => {
		const { deliver } = render();
		act(() => deliver(QUESTION_FRAME));
		expect(document.querySelector(".th-modal")).toBeNull();
		const textarea = composer();
		act(() => {
			textarea.focus();
		});
		act(() => {
			pressKey(textarea, "2");
		});
		// The digit never inserts.
		expect(textarea.value).toBe("");
		const modal = requireElement(document.querySelector(".th-modal"), "question window");
		const picked = Array.from(
			modal.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find((button) => button.textContent?.includes("TS"));
		expect(picked?.getAttribute("aria-pressed")).toBe("true");
	});

	it("a digit beyond the option count does not open the window", () => {
		const { deliver } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => {
			textarea.focus();
			pressKey(textarea, "9");
		});
		expect(document.querySelector(".th-modal")).toBeNull();
	});

	it("keeps the draft answers when the composer comment answers (IS-1)", () => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		// Pick an option in the window first.
		act(() => {
			container
				.querySelector<HTMLButtonElement>(".th-question-band-open")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const option = Array.from(
			document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
		).find((button) => button.textContent?.includes("Go"));
		act(() => {
			option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const textarea = composer();
		act(() => setTextareaValue(textarea, "with a comment"));
		act(() => {
			pressKey(textarea, "Enter");
		});
		expect(sent.find((frame) => frame.type === "approval.respond")).toMatchObject({
			id: "ask-1",
			answers: { q1: { selected: ["Go"] } },
			comment: "with a comment",
		});
	});

	it("the ended question leaves reply mode, keeps the text, and says so (IS-8)", () => {
		const { deliver } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "half typed"));
		expect(container.querySelector(".th-chat-reply-label")).not.toBeNull();
		act(() =>
			deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome: "answered" }),
		);
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
		expect(textarea.value).toBe("half typed");
		expect(container.querySelector(".th-chat-reply-ended")?.textContent).toBe(
			"question.noLongerPending",
		);
	});

	it("keeps the reply bound to A when A resolves while B stays pending", () => {
		const { deliver, sent } = render();
		act(() => {
			deliver({ ...QUESTION_FRAME, requestId: "req-a" });
			deliver({ ...QUESTION_FRAME, id: "ask-b", requestId: "req-b",
				questions: [{ id: "q1", header: "Beta", question: "Other?" }] });
		});
		const textarea = composer();
		act(() => setTextareaValue(textarea, "answer for A"));
		act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome: "answered" }));
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
		expect(textarea.value).toBe("answer for A");
		expect(container.querySelector(".th-chat-reply-ended")?.textContent).toBe("question.noLongerPending");
		act(() => pressKey(textarea, "Enter"));
		expect(sent.some((frame) => frame.type === "approval.respond" && frame.id === "ask-b")).toBe(false);
	});

	it("does not assign A's remaining text to a forced reply for blocking B", () => {
		const { deliver, sent } = render();
		act(() => deliver({ ...QUESTION_FRAME, requestId: "req-a" }));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "answer for A"));
		act(() => deliver({ ...BLOCKING_FRAME, id: "ask-b", requestId: "req-b" }));
		act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome: "answered" }));
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
		expect(textarea.value).toBe("answer for A");
		expect(container.querySelector(".th-chat-reply-ended")?.textContent).toBe("question.noLongerPending");
		act(() => pressKey(textarea, "Enter"));
		expect(sent.some((frame) => frame.type === "approval.respond" && frame.id === "ask-b")).toBe(false);
	});

	it("does not lose A's ending when one snapshot removes A and B together", () => {
		const { deliver } = render();
		act(() => {
			deliver({ ...QUESTION_FRAME, requestId: "req-a" });
			deliver({ ...QUESTION_FRAME, id: "ask-b", requestId: "req-b" });
		});
		const textarea = composer();
		act(() => setTextareaValue(textarea, "answer for A"));
		act(() => deliver({ type: "questions.snapshot", sessionId: "chat-1", ids: [] }));
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
		expect(textarea.value).toBe("answer for A");
		expect(container.querySelector(".th-chat-reply-ended")?.textContent).toBe("question.noLongerPending");
	});

	it("keeps A's ending when separate resolved frames share one React commit", () => {
		const { deliver, sent } = render();
		act(() => {
			deliver({ ...QUESTION_FRAME, requestId: "req-a" });
			deliver({ ...QUESTION_FRAME, id: "ask-b", requestId: "req-b" });
		});
		const textarea = composer();
		act(() => setTextareaValue(textarea, "answer for A"));
		act(() => {
			deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome: "answered" });
			deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-b", outcome: "answered" });
		});
		expect(container.querySelector(".th-chat-reply-label")).toBeNull();
		expect(container.querySelector(".th-chat-reply-ended")?.textContent).toBe("question.noLongerPending");
		expect(textarea.value).toBe("answer for A");
		act(() => pressKey(textarea, "Enter"));
		expect(sent.some(frame => frame.type === "chat.send")).toBe(true);
		expect(sent.some(frame => frame.type === "approval.respond")).toBe(false);
	});

	it("keeps A's stable reply key when the displayed question cycles and A gets a new wire id", () => {
		const { deliver, sent } = render();
		act(() => {
			deliver({ ...QUESTION_FRAME, requestId: "req-a" });
			deliver({ ...QUESTION_FRAME, id: "ask-b", requestId: "req-b",
				questions: [{ id: "q1", header: "Beta", question: "Other?" }] });
		});
		act(() => setTextareaValue(composer(), "for Alpha"));
		act(() => container.querySelector<HTMLButtonElement>(".th-question-pending-next")?.click());
		act(() => deliver({ ...QUESTION_FRAME, id: "ask-a-new", requestId: "req-a" }));
		act(() => pressKey(composer(), "Enter"));
		expect(sent.filter((frame) => frame.type === "approval.respond")).toHaveLength(1);
		expect(sent.find((frame) => frame.type === "approval.respond")).toMatchObject({
			id: "ask-a-new", comment: "for Alpha",
		});
	});

	it("uses the restored answer without another keystroke after a sibling pane's failed send", () => {
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "my additional comment"));
		const submittedAnswer = { answers: { q1: { selected: ["Go"] } } };
		act(() => deliver({ ...QUESTION_FRAME, delivery: "sending", submittedAnswer }));
		act(() => deliver({ ...QUESTION_FRAME, delivery: "failed", deliveryError: "unconfirmed", submittedAnswer }));
		act(() => pressKey(textarea, "Enter"));
		expect(sent.filter(frame => frame.type === "approval.respond")).toMatchObject([{
			id: "ask-1",
			answers: { q1: { selected: ["Go"] } },
			comment: "my additional comment",
		}]);
	});

	it("answers the pinned question with its current draft after the display cycles", () => {
		const { deliver, sent } = render();
		act(() => {
			deliver({ ...QUESTION_FRAME, requestId: "req-a" });
			deliver({ ...QUESTION_FRAME, id: "ask-b", requestId: "req-b",
				questions: [{ id: "q1", header: "Beta", question: "Other?" }] });
		});
		const textarea = composer();
		act(() => setTextareaValue(textarea, "for Alpha"));
		act(() => container.querySelector<HTMLButtonElement>(".th-question-pending-next")?.click());
		act(() => deliver({ ...QUESTION_FRAME, id: "ask-a-new", requestId: "req-a",
			delivery: "failed", deliveryError: "unconfirmed",
			submittedAnswer: { answers: { q1: { selected: ["Go"] } } } }));
		act(() => pressKey(textarea, "Enter"));
		expect(sent.filter(frame => frame.type === "approval.respond")).toMatchObject([{
			id: "ask-a-new",
			answers: { q1: { selected: ["Go"] } },
			comment: "for Alpha",
		}]);
	});

	it("throttles composer reply edits with current answers and comment, cancelling on send", () => {
		vi.useFakeTimers();
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		const textarea = composer();
		act(() => setTextareaValue(textarea, "first"));
		act(() => vi.advanceTimersByTime(500));
		act(() => setTextareaValue(textarea, "second"));
		act(() => vi.advanceTimersByTime(500));
		expect(sent.filter((frame) => frame.type === "approval.progress")).toEqual([{
			type: "approval.progress", sessionId: "chat-1", id: "ask-1", answers: {}, comment: "second",
		}]);
		act(() => setTextareaValue(textarea, "third"));
		act(() => vi.advanceTimersByTime(1_000));
		expect(sent.filter((frame) => frame.type === "approval.progress")).toHaveLength(2);
		expect(sent.filter((frame) => frame.type === "approval.progress")[1]).toMatchObject({
			id: "ask-1", answers: {}, comment: "third",
		});
		act(() => setTextareaValue(textarea, "final"));
		act(() => pressKey(textarea, "Enter"));
		act(() => vi.advanceTimersByTime(1_000));
		expect(sent.filter((frame) => frame.type === "approval.progress")).toHaveLength(2);
	});

	it("never reports progress for edits in normal-message mode", () => {
		vi.useFakeTimers();
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		act(() => setTextareaValue(composer(), "/normal"));
		act(() => vi.advanceTimersByTime(2_500));
		expect(sent.some((frame) => frame.type === "approval.progress")).toBe(false);
	});

	it("cancels an armed reply progress frame when switching to message mode", () => {
		vi.useFakeTimers();
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		act(() => setTextareaValue(composer(), "draft reply"));
		act(() => requireElement(container.querySelector<HTMLButtonElement>(".th-chat-reply-toggle"), "reply toggle").click());
		act(() => vi.advanceTimersByTime(1_000));
		expect(sent.some((frame) => frame.type === "approval.progress")).toBe(false);
	});

	it("reports the question's selected draft alongside composer text and cancels on ending", () => {
		vi.useFakeTimers();
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		act(() => container.querySelector<HTMLButtonElement>(".th-question-band-open")?.click());
		const option = Array.from(document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"))
			.find((button) => button.textContent?.includes("Go"));
		act(() => option?.click());
		act(() => setTextareaValue(composer(), "comment in composer"));
		act(() => vi.advanceTimersByTime(1_000));
		expect(sent.filter((frame) => frame.type === "approval.progress").at(-1)).toMatchObject({
			id: "ask-1", answers: { q1: { selected: ["Go"] } }, comment: "comment in composer",
		});
		act(() => setTextareaValue(composer(), "new text before closure"));
		act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome: "answered" }));
		const count = sent.filter((frame) => frame.type === "approval.progress").length;
		act(() => vi.advanceTimersByTime(1_000));
		expect(sent.filter((frame) => frame.type === "approval.progress")).toHaveLength(count);
	});

	it("shows the already resolved notice for a pending question's explicit outcome", () => {
		const { deliver } = render();
		act(() => deliver(QUESTION_FRAME));
		act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome: "already_resolved" }));
		expect(container.querySelector(".th-question-closed-notice")?.textContent).toBe(
			"question.delivery.alreadyResolved",
		);
	});

	it.each(["answered", "comment-submitted"] as const)(
		"closes a normally %s question without an already-resolved notice",
		(outcome) => {
			const { deliver } = render();
			act(() => deliver(QUESTION_FRAME));
			act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: "ask-1", outcome }));
			expect(container.querySelector(".th-question-closed-notice")).toBeNull();
		},
	);

	it("shows the pending count and cycles to the next question (IS-7)", () => {
		const { deliver } = render();
		act(() => deliver({ ...QUESTION_FRAME, title: "First ask" } as ChatServerFrame));
		act(() =>
			deliver({
				...QUESTION_FRAME,
				id: "ask-2",
				title: "Second ask",
				questions: [{ id: "q1", header: "Second", question: "Another?" }],
			} as ChatServerFrame),
		);
		const band = requireElement(container.querySelector(".th-question-band"), "band");
		expect(band.textContent).toContain("question.pending.count");
		expect(band.textContent).toContain("First ask");
		act(() => {
			band
				.querySelector<HTMLButtonElement>(".th-question-pending-next")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(container.querySelector(".th-question-band")?.textContent).toContain("Second ask");
	});

	it("reports draft edits as throttled progress frames (IS-5)", () => {
		vi.useFakeTimers();
		const { deliver, sent } = render();
		act(() => deliver(QUESTION_FRAME));
		act(() => {
			container
				.querySelector<HTMLButtonElement>(".th-question-band-open")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const input = requireElement(
			document.querySelector<HTMLInputElement>(".th-approval-question-text"),
			"answer input",
		);
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		act(() => {
			setter?.call(input, "typed answer");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(sent.some((frame) => frame.type === "approval.progress")).toBe(false);
		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		const progress = sent.filter((frame) => frame.type === "approval.progress");
		expect(progress).toHaveLength(1);
		expect(progress[0]).toMatchObject({
			sessionId: "chat-1",
			id: "ask-1",
			answers: { q1: { selected: [], text: "typed answer" } },
		});
	});

	describe("blocking question (IS-3)", () => {
		function renderBlocking() {
			const rendered = render();
			act(() => {
				rendered.deliver({ type: "state", sessionId: "chat-1", isStreaming: true, isCompacting: false });
			});
			act(() => rendered.deliver(BLOCKING_FRAME));
			return rendered;
		}

		it("never shows Stop in the send slot and Esc does not abort", () => {
			const { sent } = renderBlocking();
			// The blocking window auto-opened (D2).
			expect(document.querySelector(".th-modal")).not.toBeNull();
			expect(container.querySelector(".th-chat-send-btn.th-btn--danger")).toBeNull();
			const textarea = composer();
			act(() => {
				textarea.focus();
				pressKey(textarea, "Escape");
			});
			expect(sent.some((frame) => frame.type === "chat.abort")).toBe(false);
		});

		it("collapsing the window forces reply mode; Enter answers as a comment", () => {
			const { sent } = renderBlocking();
			// Collapse the window via its close control.
			act(() => {
				document
					.querySelector<HTMLButtonElement>(".th-modal .th-modal-close, .th-modal [aria-label='common.close']")
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(document.querySelector(".th-modal")).toBeNull();
			// Forced reply mode: the label shows without typing.
			expect(container.querySelector(".th-chat-reply-label")?.textContent).toContain(
				"question.reply.label",
			);
			const textarea = composer();
			act(() => setTextareaValue(textarea, "go ahead"));
			act(() => {
				pressKey(textarea, "Enter");
			});
			expect(sent.find((frame) => frame.type === "approval.respond")).toMatchObject({
				id: "ask-block",
				comment: "go ahead",
			});
		});

		it("keeps a forced answer on its blocking question when the display cycles to another", () => {
			const rendered = render();
			act(() => {
				rendered.deliver({ type: "state", sessionId: "chat-1", isStreaming: true, isCompacting: false });
			});
			// Text typed before any question arrives: reply mode was never entered.
			act(() => setTextareaValue(composer(), "prepared answer"));
			act(() => rendered.deliver({ ...BLOCKING_FRAME, requestId: "req-block" }));
			act(() => rendered.deliver({ ...QUESTION_FRAME, id: "ask-b", requestId: "req-b" }));
			act(() => {
				document
					.querySelector<HTMLButtonElement>(".th-modal .th-modal-close, .th-modal [aria-label='common.close']")
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(document.querySelector(".th-modal")).toBeNull();
			expect(container.querySelector(".th-chat-reply-label")).not.toBeNull();
			act(() => requireElement(
				container.querySelector<HTMLButtonElement>(".th-question-band .th-question-pending-next"),
				"next question",
			).click());
			// The band now shows the non-blocking question; the composer still
			// answers the blocking one it was forced onto.
			expect(container.querySelector(".th-chat-reply-label")).not.toBeNull();
			act(() => {
				pressKey(composer(), "Enter");
			});
			const responses = rendered.sent.filter((frame) => frame.type === "approval.respond");
			expect(responses).toHaveLength(1);
			expect(responses[0]).toMatchObject({ id: "ask-block", comment: "prepared answer" });
			expect(rendered.sent.some((frame) => frame.type === "chat.send" || frame.type === "chat.abort")).toBe(false);
		});

		it("the steer button is the send-as-message control", () => {
			const { sent } = renderBlocking();
			const steer = requireElement(
				container.querySelector<HTMLButtonElement>(".th-chat-steer-btn"),
				"steer button",
			);
			expect(steer.textContent).toContain("question.reply.sendAsMessage");
			const textarea = composer();
			act(() => setTextareaValue(textarea, "as a message"));
			act(() => {
				steer.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(sent.some((frame) => frame.type === "chat.send")).toBe(true);
			expect(sent.some((frame) => frame.type === "approval.respond")).toBe(false);
		});

		it("the send-as-message control is visually and nominally distinct from send", () => {
			renderBlocking();
			const steer = requireElement(
				container.querySelector<HTMLButtonElement>(".th-chat-steer-btn"),
				"steer button",
			);
			const send = requireElement(
				container.querySelector<HTMLButtonElement>(".th-chat-send-btn"),
				"send button",
			);
			// Different accessible names (the visually hidden label is the name).
			expect(steer.textContent).toContain("question.reply.sendAsMessage");
			expect(send.textContent).toContain("chat.send");
			expect(steer.textContent).not.toBe(send.textContent);
			// Different visible content: a distinct message glyph, not a second
			// copy of the send arrow, plus the ghost modifier class.
			expect(steer.classList.contains("th-chat-steer-btn--message")).toBe(true);
			const steerIcon = steer.querySelector("svg")?.innerHTML;
			const sendIcon = send.querySelector("svg")?.innerHTML;
			expect(steerIcon).toBeTruthy();
			expect(steerIcon).not.toBe(sendIcon);
		});
	});

	it("without a pending question Stop and Esc behave as before", () => {
		const { deliver, sent } = render();
		act(() => {
			deliver({ type: "state", sessionId: "chat-1", isStreaming: true, isCompacting: false });
		});
		expect(container.querySelector(".th-chat-send-btn.th-btn--danger")).not.toBeNull();
		const textarea = composer();
		act(() => {
			textarea.focus();
			pressKey(textarea, "Escape");
		});
		expect(sent.some((frame) => frame.type === "chat.abort")).toBe(true);
	});

	describe("delivery confirmation (IS-6)", () => {
		function openAndSubmit(sent: ChatClientFrame[], deliver: (frame: ChatServerFrame) => void): void {
			act(() => deliver(QUESTION_FRAME));
			act(() => {
				container
					.querySelector<HTMLButtonElement>(".th-question-band-open")
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			const option = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
			).find((button) => button.textContent?.includes("Go"));
			act(() => {
				option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			const submit = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
			).find((button) => button.textContent === "approval.submit");
			act(() => {
				submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(sent.filter((frame) => frame.type === "approval.respond")).toHaveLength(1);
		}

		it("locks the window as sending after Send and refuses a second send", () => {
			const { deliver, sent } = render();
			openAndSubmit(sent, deliver);
			// Sending state: status line, disabled inputs, no second write.
			expect(document.querySelector(".th-question-delivery--sending")?.textContent).toBe(
				"question.delivery.sending",
			);
			expect(
				document.querySelector<HTMLButtonElement>(".th-approval-question-option")?.disabled,
			).toBe(true);
			const submitAgain = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
			).find((button) => button.textContent === "approval.submit");
			expect(submitAgain?.disabled).toBe(true);
			act(() => {
				submitAgain?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(sent.filter((frame) => frame.type === "approval.respond")).toHaveLength(1);
		});

		it("a failed delivery restores the draft with the error and a resend control", () => {
			const { deliver, sent } = render();
			act(() => deliver(QUESTION_FRAME));
			act(() => {
				container
					.querySelector<HTMLButtonElement>(".th-question-band-open")
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			const option = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-option"),
			).find((button) => button.textContent?.includes("Go"));
			act(() => {
				option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			const submit = Array.from(
				document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"),
			).find((button) => button.textContent === "approval.submit");
			act(() => {
				submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			// The server acks the first write (committing the control ledger)
			// before republishing the question as failed with the submitted answer.
			const first = sent.find((frame) => frame.type === "approval.respond");
			if (!first || first.type !== "approval.respond") throw new Error("missing respond frame");
			act(() =>
				deliver({
					type: "ack",
					sessionId: "chat-1",
					command: "extension_ui_response",
					id: "ask-1",
					...(first.requestId ? { requestId: first.requestId } : {}),
				} as ChatServerFrame),
			);
			act(() =>
				deliver({
					...QUESTION_FRAME,
					delivery: "failed",
					deliveryError: "unconfirmed",
					submittedAnswer: { answers: { q1: { selected: ["Go"] } } },
				} as ChatServerFrame),
			);
			expect(document.querySelector(".th-question-delivery--failed")?.textContent).toContain(
				"question.delivery.unconfirmed",
			);
			// Inputs re-enabled with the draft intact.
			expect(
				document.querySelector<HTMLButtonElement>(".th-approval-question-option")?.disabled,
			).toBe(false);
			expect(option?.getAttribute("aria-pressed")).toBe("true");
			const resend = requireElement(
				document.querySelector<HTMLButtonElement>(".th-modal .th-question-delivery-resend"),
				"resend button",
			);
			act(() => {
				resend.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			const resends = sent.filter((frame) => frame.type === "approval.respond");
			expect(resends).toHaveLength(2);
			expect(resends[1]).toMatchObject({ id: "ask-1", answers: { q1: { selected: ["Go"] } } });
		});

		it("an incomplete failure explains what is missing", () => {
			const { deliver } = render();
			act(() =>
				deliver({
					...QUESTION_FRAME,
					delivery: "failed",
					deliveryError: "question_incomplete",
					submittedAnswer: { answers: {}, comment: "only a note" },
				} as ChatServerFrame),
			);
			expect(container.querySelector(".th-question-band")?.textContent).toContain(
				"question.delivery.incomplete",
			);
		});
	});
});
