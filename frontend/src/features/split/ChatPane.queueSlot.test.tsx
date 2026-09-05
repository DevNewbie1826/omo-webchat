import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatSession, i18n, pressKey, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

describe("ChatPane queue slot placement", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("renders the queue panel outside the transcript scrollport, above the composer", () => {
		const { deliver, sent } = renderChatPane(root, chatSession);
		act(() => deliver({ type: "run.started", sessionId: chatSession.id }));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing composer");
		act(() => setTextareaValue(input, "queued work"));
		act(() => pressKey(input, "Enter"));
		const last = sent.at(-1);
		if (last?.type !== "chat.send") throw new Error("missing chat.send");
		expect(last.run).toEqual({ kind: "prompt", message: "queued work" });

		const requestId = last.requestId;
		if (requestId === undefined) throw new Error("missing requestId");
		act(() => deliver({
			type: "queue",
			sessionId: chatSession.id,
			revision: 1,
			items: [{ id: "q-1", text: "queued work", hasImage: false, createdAt: 1, requestId }],
			engine: { pendingMessageCount: 0, ordered: [] },
		}));

		const panel = requireElement(container.querySelector<HTMLElement>(".th-queue"), "missing queue panel");
		// Fixed slot: never inside the transcript scrollport.
		expect(container.querySelector(".th-chat-scrollport .th-queue")).toBeNull();
		expect(container.querySelector(".th-chat-scrollport")?.contains(panel)).toBe(false);
		// Slot order: after the shelves, before the composer.
		const main = panel.closest(".th-chat-main");
		if (!main) throw new Error("missing chat main");
		const transcript = requireElement(main.querySelector(".th-chat-scrollport"), "transcript");
		const composer = requireElement(main.querySelector("form.th-chat-input"), "composer");
		expect(transcript.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		expect(panel.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		expect(panel.closest(".th-chat-main-content")).not.toBeNull();
		// The queued item must not appear as a transcript row.
		expect(container.querySelectorAll(".th-chat-scrollport .th-chat-msg--user")).toHaveLength(0);
	});

	it("shows the steer pending summary in the fixed status strip", () => {
		const { deliver } = renderChatPane(root, chatSession);
		act(() => deliver({ type: "run.started", sessionId: chatSession.id }));
		const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "missing composer");
		act(() => setTextareaValue(input, "redirect course"));
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		})));

		const status = requireElement(container.querySelector<HTMLElement>(".th-chat-status"), "missing status strip");
		expect(status.textContent).toContain("chat.steerPending");
		expect(container.querySelector(".th-chat-scrollport .th-chat-msg--user")).toBeNull();
	});
});
