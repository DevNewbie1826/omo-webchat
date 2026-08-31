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

describe("ChatPane tool cards and approvals", () => {
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

	it("renders exactly one disclosure when message_end toolCall is finalized by run.done", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			// message_end carries the pending toolCall block.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [
						{ kind: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
						{ kind: "text", text: "ran ls" },
					],
				},
			});
			// Live tool frames stream the final result for the same call id.
			deliver({ type: "tool", sessionId: "chat-1", toolCallId: "call-1", toolName: "bash", phase: "start" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "file1\nfile2\n" }] },
				isError: false,
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		const cards = container.querySelectorAll(".th-tool[data-tool-call-id='call-1']");
		expect(cards).toHaveLength(1);
		// The finalized block rests collapsed behind its invocation summary; the
		// full output stays inside the one frame, revealed on disclosure.
		expect(cards[0]?.querySelector(".th-tool-preview")?.textContent).toBe("file1");
		const head = cards[0]?.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(cards[0]?.querySelector(".th-tool-body")?.textContent).toContain("file1\nfile2\n");
	});

	it("renders one disclosure for a toolCall while its live result streams before run.done", () => {
		const { deliver } = renderWithFakeConnect();
		const output = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
		act(() => {
			// message_end carries the pending toolCall block into the transcript.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [
						{ kind: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
						{ kind: "text", text: "ran ls" },
					],
				},
			});
			// Live tool frames stream the result for the same call id.
			deliver({ type: "tool", sessionId: "chat-1", toolCallId: "call-1", toolName: "bash", phase: "start" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: output }] },
				isError: false,
			});
			// Deliberately no run.done yet: the transcript must already collapse
			// the history toolCall card and the live result card into a single
			// disclosure for call-1, instead of rendering the tall output in a
			// second frame outside the invocation.
		});

		const cards = container.querySelectorAll(".th-tool[data-tool-call-id='call-1']");
		expect(cards).toHaveLength(1);

		const card = cards[0];
		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain(output);
	});

	it("keeps start-frame command arguments visible during execution and after run.done", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-args",
				toolName: "bash",
				phase: "start",
				args: { command: "find . -maxdepth 1" },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-args",
				toolName: "bash",
				phase: "update",
				partial: { content: [{ text: "./frontend" }], details: { progress: 1 } },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-args",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "./frontend\n" }] },
			});
		});

		let card = container.querySelector<HTMLElement>(".th-tool[data-tool-call-id='call-args']");
		expect(card?.querySelector(".th-tool-cmd")?.textContent).toBe("find . -maxdepth 1");

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "done" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		card = container.querySelector<HTMLElement>(".th-tool[data-tool-call-id='call-args']");
		expect(card?.querySelector(".th-tool-cmd")?.textContent).toBe("find . -maxdepth 1");
	});

	it("auto-collapses an untouched live tool card when it completes", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-auto",
				toolName: "bash",
				phase: "start",
				args: { command: "ls" },
			});
		});
		const head = container.querySelector<HTMLButtonElement>(".th-tool[data-tool-call-id='call-auto'] .th-tool-head");
		// Running: the untouched card is expanded so current work is observable.
		expect(head?.getAttribute("aria-expanded")).toBe("true");

		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-auto",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "line1\nline2\n" }] },
				isError: false,
			});
		});
		// The user never toggled it: completion alone must collapse the card.
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector(".th-tool[data-tool-call-id='call-auto'] .th-tool-body")).toBeNull();
	});

	it("keeps a reconnect-style running mount collapsed after it finalizes", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			// History restored on reconnect already carries the toolCall block.
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "call-re", name: "bash", arguments: { command: "ls" } }],
							timestamp: 1,
						},
					},
				],
			});
			// The server re-streams the same call while it is still running, so
			// the restored block mounts in its running phase.
			deliver({ type: "tool", sessionId: "chat-1", toolCallId: "call-re", toolName: "bash", phase: "start" });
		});
		const head = container.querySelector<HTMLButtonElement>(".th-tool[data-tool-call-id='call-re'] .th-tool-head");
		expect(head?.getAttribute("aria-expanded")).toBe("true");

		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-re",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "file1\n" }] },
				isError: false,
			});
		});
		// Untouched across the running mount: finalizing collapses it.
		expect(head?.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps the user's expanded choice across the live-to-history run.done transition", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({ type: "tool", sessionId: "chat-1", toolCallId: "call-open", toolName: "bash", phase: "start" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-open",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "output" }] },
			});
		});

		const liveHead = container.querySelector<HTMLButtonElement>(".th-tool[data-tool-call-id='call-open'] .th-tool-head");
		expect(liveHead?.getAttribute("aria-expanded")).toBe("false");
		act(() => liveHead?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(liveHead?.getAttribute("aria-expanded")).toBe("true");

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "done" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		const historyHead = container.querySelector<HTMLButtonElement>(".th-tool[data-tool-call-id='call-open'] .th-tool-head");
		expect(historyHead?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector(".th-tool[data-tool-call-id='call-open'] .th-tool-body")?.textContent).toContain("output");
	});

	it("renders one disclosure when the toolCall and final text land in separate assistant messages", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			// The first assistant message carries the pending toolCall block.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
				},
			});
			// Live tool frames stream the result for the same call id.
			deliver({ type: "tool", sessionId: "chat-1", toolCallId: "call-1", toolName: "bash", phase: "start" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "file1\nfile2\n" }] },
				isError: false,
			});
			// A later assistant message carries the final text, no tool block.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "all done" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		// run.done must finalize the call where the toolCall actually lives
		// instead of attaching a second card to the later text-only message.
		const cards = container.querySelectorAll(".th-tool[data-tool-call-id='call-1']");
		expect(cards).toHaveLength(1);
		const head = cards[0]?.querySelector<HTMLButtonElement>(".th-tool-head");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(cards[0]?.querySelector(".th-tool-body")?.textContent).toContain("file1\nfile2\n");
	});

});
