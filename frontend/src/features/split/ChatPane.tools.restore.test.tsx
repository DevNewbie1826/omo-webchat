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

	it("keeps a restored toolCall and its result inside one expandable disclosure", () => {
		const { deliver } = renderWithFakeConnect();
		// A tall tool result: long enough that a split disclosure visibly breaks
		// the transcript when the output lands outside the invocation's frame.
		const output = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
								{ type: "toolResult", text: output },
							],
						},
					},
				],
				leafId: "leaf-1",
			});
		});

		// One tool invocation must render exactly one disclosure frame. Today the
		// restored toolCall and its adjacent result are preserved as separate
		// blocks and each renders its own ToolCard, so the named invocation frame
		// is empty (structured arguments ignored) and the output sits outside it.
		const cards = container.querySelectorAll(".th-tool");
		expect(cards).toHaveLength(1);

		const card = cards[0];
		expect(card?.querySelector(".th-tool-name")?.textContent).toBe("bash");

		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		// The full result must be contained within that single frame once opened.
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain(output);
	});

	it("merges a separate restored toolResult message into the matching invocation", () => {
		const { deliver } = renderWithFakeConnect();
		// The real provider stores a tool result as its own top-level message
		// (role "toolResult" with message-level toolCallId/toolName/isError),
		// separate from the assistant message that carries the toolCall block.
		const output = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
								{ type: "text", text: "ran ls" },
							],
						},
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							toolName: "bash",
							content: [{ type: "text", text: output }],
							isError: false,
						},
					},
				],
				leafId: "leaf-1",
			});
		});

		// One invocation must render exactly one named disclosure, and the
		// separate toolResult message must not survive as a detached text row.
		const cards = container.querySelectorAll(".th-tool");
		expect(cards).toHaveLength(1);
		const card = cards[0];
		expect(card?.querySelector(".th-tool-name")?.textContent).toBe("bash");
		expect(container.querySelectorAll(".th-chat-msg").length).toBe(1);

		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain(output);
	});

	it("renders one disclosure and no toolResult row for a live toolResult message_end", () => {
		const { deliver } = renderWithFakeConnect();
		const output = "file1\nfile2\n";
		act(() => {
			// assistant message_end carries the pending toolCall block.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
				},
			});
			// Live tool execution frames are the authoritative result.
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
			// Redundant live toolResult message_end for the same invocation.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "toolResult", blocks: [{ kind: "text", text: output }] },
			});
		});

		// Before run.done: one disclosure with the result folded into it (its
		// summary previews the first output line), zero toolResult rows.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-1']").length).toBe(1);
		expect(container.querySelectorAll(".th-chat-msg--toolResult").length).toBe(0);
		expect(
			container.querySelector(".th-tool[data-tool-call-id='call-1'] .th-tool-preview")?.textContent,
		).toBe("file1");

		act(() => {
			// A later assistant message carries the final text.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "all done" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		// After run.done: still exactly one disclosure, result inside, no detached row.
		const cards = container.querySelectorAll(".th-tool[data-tool-call-id='call-1']");
		expect(cards).toHaveLength(1);
		expect(container.querySelectorAll(".th-chat-msg--toolResult").length).toBe(0);
		const head = cards[0]?.querySelector<HTMLButtonElement>(".th-tool-head");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(cards[0]?.querySelector(".th-tool-body")?.textContent).toContain(output);
	});

});
