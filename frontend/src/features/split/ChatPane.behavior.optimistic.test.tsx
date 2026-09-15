import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { messageText } from "./chatEntries";
import {
	ControlledResizeObserver,
	chatSession,
	pressKey,
	renderChatPane,
	setTextareaValue,
} from "./chatPaneTestHarness";
import type { TranscriptItem } from "./useChatFrameState";

// Reconciliation is a claim about ROW IDENTITY AND CONTENT: an optimistic
// prompt and its echo must collapse into the canonical surviving row, not
// merely produce some row total. JSDOM has no layout engine, so the
// virtualizer renders no row elements to read; its `count` option is the
// layout-independent row total, and the transcript items ChatPane passes in
// carry the identity and text the test sent. Reading those keeps the
// assertion free of the row-height estimator, whose pixel totals are not a
// statement about reconciliation.
const observed = vi.hoisted(() => {
	const state: {
		current?: Virtualizer<Element, Element>;
		items: readonly TranscriptItem[];
	} = { items: [] };
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
vi.mock("./ChatTranscript", async (importOriginal) => {
	const { createElement } = await import("react");
	const actual = await importOriginal<typeof import("./ChatTranscript")>();
	const Inner = actual.ChatTranscript;
	function ObservingChatTranscript(
		props: Parameters<typeof Inner>[0],
	): ReturnType<typeof Inner> {
		observed.items = props.items;
		return createElement(Inner, props);
	}
	return { ...actual, ChatTranscript: ObservingChatTranscript };
});

const transcriptRowCount = (): number | undefined =>
	observed.current?.options.count;

function reconciledUserTurns(): readonly {
	readonly text: string;
	readonly ts: number;
	readonly id?: string;
}[] {
	return observed.items.flatMap((item) => {
		if (item.kind !== "message" || item.message.role !== "user") return [];
		const text = messageText(item.message);
		const ts = item.message.ts ?? 0;
		return item.message.id === undefined
			? [{ text, ts }]
			: [{ id: item.message.id, text, ts }];
	});
}

describe("ChatPane optimistic prompt reconciliation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: ReturnType<typeof renderChatPane>["deliver"];
	let sent: ReturnType<typeof renderChatPane>["sent"];

	beforeEach(() => {
		observed.items = [];
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
		const prompt = "repeat";
		const snapshotId = "snap-repeat";
		act(() => setTextareaValue(textarea(), prompt));
		act(() => pressKey(textarea(), "Enter"));
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "user",
					blocks: [{ kind: "text", text: prompt }],
					ts: 1,
				},
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		act(() => setTextareaValue(textarea(), prompt));
		act(() => pressKey(textarea(), "Enter"));
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						id: snapshotId,
						message: { role: "user", content: prompt, timestamp: 1 },
					},
				],
			});
		});

		expect(transcriptRowCount()).toBe(2);
		expect(reconciledUserTurns()).toEqual([
			{ id: snapshotId, text: prompt, ts: 1 },
			{ text: prompt, ts: 1 },
		]);
	});

	it("reconciles identical prompts independently after completion", () => {
		const prompt = "repeat";
		const submitAndEcho = (ts: number): void => {
			act(() => setTextareaValue(textarea(), prompt));
			act(() => pressKey(textarea(), "Enter"));
			act(() => {
				deliver({
					type: "message",
					sessionId: "chat-1",
					message: {
						role: "user",
						blocks: [{ kind: "text", text: prompt }],
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
		expect(reconciledUserTurns()).toEqual([
			{ text: prompt, ts: 1 },
			{ text: prompt, ts: 2 },
		]);
	});
});
