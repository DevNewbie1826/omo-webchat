import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import {
	ControlledResizeObserver,
	chatSession,
	pressKey,
	renderChatPane,
	setTextareaValue,
} from "./chatPaneTestHarness";

// Reconciliation is a claim about ROW IDENTITY: an optimistic prompt and its
// echo must collapse into ONE transcript row. JSDOM has no layout engine, so
// the virtualizer renders no row elements to count; its `count` option is the
// authoritative row total and is layout-independent. Reading it also keeps the
// assertion free of the row-height estimator, whose pixel totals are not a
// statement about reconciliation.
const observed = vi.hoisted(() => {
	const state: { current?: Virtualizer<Element, Element> } = {};
	return state;
});
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-virtual")>();
	return {
		...actual,
		useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
			const instance = actual.useVirtualizer(...args);
			observed.current = instance;
			return instance;
		},
	};
});

const transcriptRowCount = (): number | undefined =>
	observed.current?.options.count;

describe("ChatPane optimistic prompt reconciliation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: ReturnType<typeof renderChatPane>["deliver"];
	let sent: ReturnType<typeof renderChatPane>["sent"];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => undefined)),
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		({ deliver, sent } = renderChatPane(root, chatSession));
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		ControlledResizeObserver.instances = [];
		container.remove();
		vi.unstubAllGlobals();
	});

	function textarea(): HTMLTextAreaElement {
		const element = container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="chat.placeholder"]',
		);
		if (!element) throw new Error("missing chat textarea");
		return element;
	}

	function chatSends() {
		return sent.filter((frame) => frame.type === "chat.send");
	}

	it("does not reconcile a reconnect snapshot's older identical prompt as the current optimistic one", () => {
		act(() => setTextareaValue(textarea(), "repeat"));
		act(() => pressKey(textarea(), "Enter"));
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: "repeat" }],
					ts: 1,
				},
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		act(() => setTextareaValue(textarea(), "repeat"));
		act(() => pressKey(textarea(), "Enter"));
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: { role: "user", content: "repeat", timestamp: 1 },
					},
				],
			});
		});

		expect(transcriptRowCount()).toBe(2);
	});

	it("reconciles identical prompts independently after completion", () => {
		const submitAndEcho = (ts: number): void => {
			act(() => setTextareaValue(textarea(), "repeat"));
			act(() => pressKey(textarea(), "Enter"));
			act(() => {
				deliver({
					type: "message",
					sessionId: "chat-1",
					message: {
						role: "user",
						blocks: [{ kind: "text", text: "repeat" }],
						ts,
					},
				});
				deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
			});
		};

		submitAndEcho(1);
		submitAndEcho(2);

		expect(chatSends()).toHaveLength(2);
		expect(transcriptRowCount()).toBe(2);
	});
});
