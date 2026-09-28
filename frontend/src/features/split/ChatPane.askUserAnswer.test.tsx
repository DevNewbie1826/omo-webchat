import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate, type I18nValue } from "../../i18n";
import { renderChatPane, i18n as identityI18n } from "./chatPaneTestHarness";

// Same seam as ChatTranscript.disclosureMeasure.test.tsx: observe the real
// virtualizer so a chip toggle can be asserted to re-measure its row.
const observedVirtualizer = vi.hoisted(() => ({ current: undefined as Virtualizer<Element, Element> | undefined }));
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
	return {
		...actual,
		useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
			const instance = actual.useVirtualizer(...args);
			observedVirtualizer.current = instance;
			return instance;
		},
	};
});

const koI18n: I18nValue = {
	...identityI18n,
	lang: "ko",
	t: (key, vars) => translate("ko", key, vars),
};

const QUESTION_ARGS = {
	questions: [
		{ id: "q1", header: "QA1", question: "pick", options: ["A", "B"] },
	],
	waitForAnswer: true,
} as const;

describe("ChatPane omo answer frames (IS-2, IS-9)", () => {
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

	function deliverQuestionToolCall(deliver: (frame: never) => void): void {
		deliver({
			type: "tool",
			sessionId: "chat-1",
			toolCallId: "toolu_x",
			toolName: "ask_user_question",
			phase: "start",
			args: QUESTION_ARGS,
		} as never);
	}

	it("renders a live answer frame as an answer chip, never a user bubble", () => {
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliverQuestionToolCall(deliver);
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "[Answer to question toolu_x]\nQA1: A" }],
				},
			} as never);
		});

		const chip = container.querySelector<HTMLElement>(".th-ask-answer");
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain("↳ QA1: A");
		// The engine's answer text must never read as the user's own bubble.
		expect(container.querySelector(".th-chat-msg--user")).toBeNull();
		// Collapsed by default; the disclosure expands to the full body.
		const toggle = chip?.querySelector<HTMLButtonElement>(".th-ask-answer-toggle");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(chip?.querySelector(".th-ask-answer-body")).toBeNull();
		act(() => {
			toggle?.click();
		});
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(chip?.querySelector(".th-ask-answer-body")?.textContent).toBe("QA1: A");
	});

	it("renders a timeout body with the localized (no answer) marker", () => {
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliverQuestionToolCall(deliver);
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [
						{
							kind: "text",
							text: "[Answer to question toolu_x]\nThe user did not answer within 30 minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)",
						},
					],
				},
			} as never);
		});

		const chip = container.querySelector<HTMLElement>(".th-ask-answer");
		expect(chip?.textContent).toContain("↳ QA1: (답 없음)");
		expect(container.querySelector(".th-chat-msg--user")).toBeNull();
	});

	it("renders history answer frames through the same chip path", () => {
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				final: true,
				entries: [
					{
						type: "message",
						id: "a1",
						message: {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "toolu_x",
									name: "ask_user_question",
									arguments: QUESTION_ARGS,
								},
							],
						},
					},
					{
						type: "message",
						id: "u1",
						message: {
							role: "user",
							content: "[Answer to question toolu_x]\nQA1: A",
						},
					},
				],
			} as never);
		});

		const chip = container.querySelector<HTMLElement>(".th-ask-answer");
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain("↳ QA1: A");
		expect(container.querySelector(".th-chat-msg--user")).toBeNull();
	});

	it("shows the question tool card header with headers and the wait label", () => {
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliverQuestionToolCall(deliver);
		});

		const head = container.querySelector<HTMLElement>(
			".th-tool[data-tool-call-id='toolu_x'] .th-tool-head",
		);
		expect(head).not.toBeNull();
		expect(head?.textContent).toContain("[QA1]");
		expect(head?.textContent).toContain("답을 기다림");
	});

	it("summarizes a finished question tool call from its result details", () => {
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "toolu_x",
				toolName: "ask_user_question",
				phase: "end",
				args: QUESTION_ARGS,
				result: {
					content: [{ text: "QA1: A" }],
					details: { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] },
				},
				isError: false,
			} as never);
		});

		const head = container.querySelector<HTMLElement>(
			".th-tool[data-tool-call-id='toolu_x'] .th-tool-head",
		);
		expect(head?.textContent).toContain("[QA1]");
		expect(head?.textContent).toContain("answered; 1 answered; 0 unanswered");
	});

	it("re-measures the chip row when the disclosure expands, so the next row never overlaps", async () => {
		vi.stubGlobal("ResizeObserver", class {
			observe() {}
			unobserve() {}
			disconnect() {}
		});
		// The chip row is 40px collapsed and 120px once its body opens.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
			if (this.matches(".th-chat-row") && this.querySelector(".th-ask-answer") !== null) {
				return this.querySelector(".th-ask-answer-body") !== null ? 120 : 40;
			}
			return 40;
		});
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliverQuestionToolCall(deliver);
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "[Answer to question toolu_x]\nQA1: A" }],
				},
			} as never);
		});
		const virtualizer = observedVirtualizer.current;
		if (!virtualizer) throw new Error("missing virtualizer");
		const chipRow = container.querySelector<HTMLElement>(".th-chat-row:has(.th-ask-answer)");
		if (!chipRow) throw new Error("missing chip row");
		const chipIndex = Number(chipRow.dataset["index"]);
		expect(virtualizer.measurementsCache[chipIndex]?.size).toBe(40);

		const toggle = container.querySelector<HTMLButtonElement>(".th-ask-answer-toggle");
		if (!toggle) throw new Error("missing chip toggle");
		await act(async () => {
			toggle.click();
		});
		expect(virtualizer.measurementsCache[chipIndex]?.size).toBe(120);
		await act(async () => {
			toggle.click();
		});
		expect(virtualizer.measurementsCache[chipIndex]?.size).toBe(40);
	});

	it("renders the journaled question_closed_while_disconnected notice with its headers", () => {
		const { deliver } = renderChatPane(root, undefined, koI18n);
		act(() => {
			deliver({ type: "entries", sessionId: "chat-1", entries: [], final: true } as never);
			deliver({
				type: "notice",
				sessionId: "chat-1",
				kind: "question_closed_while_disconnected",
				payload: { requestId: "toolu_x", id: "q-1", headers: ["QA1"], hadSubmittedAnswer: true },
				at: 1,
			} as never);
		});

		const row = container.querySelector<HTMLElement>(".th-notice-status--warning");
		expect(row).not.toBeNull();
		expect(row?.textContent).toContain(translate("ko", "question.delivery.closedWhileDisconnected"));
		expect(row?.textContent).toContain("[QA1]");
	});
});
