import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

describe("ChatPane empty assistant completions", () => {
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

	it("renders a current-turn tool result after the newest user turn when the assistant completion is empty", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{ type: "message", id: "u1", message: { role: "user", content: "old-question" } },
					{ type: "message", id: "a1", message: { role: "assistant", content: "old-answer" } },
					{ type: "message", id: "u2", message: { role: "user", content: "new-question" } },
				],
			});
			deliver({ type: "run.started", sessionId: "chat-1" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "current-tool",
				toolName: "lookup",
				phase: "end",
				result: { content: [{ text: "current-output" }] },
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		const card = container.querySelector<HTMLElement>(
			".th-tool[data-tool-call-id='current-tool']",
		);
		expect(card).not.toBeNull();
		const rows = [...container.querySelectorAll<HTMLElement>(".th-chat-history .th-chat-row")];
		const currentTurnRow = rows.findIndex((row) => row.textContent?.includes("new-question"));
		expect(currentTurnRow).toBeGreaterThanOrEqual(0);
		// The anchored tool renders as its own row after the current user turn.
		const toolRowIndex = rows.findIndex((row) => row.contains(card));
		expect(toolRowIndex).toBeGreaterThan(currentTurnRow);
		// The prior answer must not own the current turn's tool output.
		const priorAnswerRow = rows.find((row) => row.textContent?.includes("old-answer"));
		expect(priorAnswerRow?.contains(card)).toBe(false);
	});

	it("renders no blank transcript row for an empty live assistant completion", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "user", blocks: [{ kind: "text", text: "hello" }] },
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [] },
			});
		});
		const rows = container.querySelectorAll(".th-chat-history .th-chat-msg");
		expect(rows.length).toBe(1);
		expect(container.querySelector(".th-chat-history .th-chat-msg--assistant")).toBeNull();
	});

	it("keeps earlier rows mounted when an empty completion is dropped at the seam", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "user", blocks: [{ kind: "text", text: "first turn" }] },
			});
		});
		const firstRow = container.querySelector<HTMLElement>(".th-chat-history .th-chat-msg");
		expect(firstRow?.textContent).toContain("first turn");

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [] },
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "real reply" }] },
			});
		});
		// Dropping the empty completion must not remount (or reorder) the
		// earlier virtualized rows: the same DOM node stays attached.
		expect(container.contains(firstRow)).toBe(true);
		const rows = [...container.querySelectorAll<HTMLElement>(".th-chat-history .th-chat-msg")];
		expect(rows.map((row) => row.textContent)).toEqual(["first turn", "real reply"]);
	});
});
