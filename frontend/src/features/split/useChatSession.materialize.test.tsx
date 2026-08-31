import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatTranscript } from "./ChatTranscript";
import type { UiMessage } from "./chatEntries";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

describe("useChatSession tool materialization", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: ReturnType<typeof useChatSession> | undefined;
	let deliver: (frame: ChatServerFrame) => void;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return { send: () => true, close: () => undefined };
		};
		function Probe() {
			current = useChatSession(session, connect);
			return null;
		}
		act(() => root.render(<Probe />));
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	it("materializes finalized live tools into the assistant message on run.done", () => {
		act(() => {
			current?.submit({ text: "do work", image: null });
			deliver({
				type: "tool",
				sessionId: session.id,
				toolCallId: "t1",
				toolName: "bash",
				phase: "start",
			});
			deliver({
				type: "tool",
				sessionId: session.id,
				toolCallId: "t1",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "hi\n" }] },
			});
			deliver({
				type: "message",
				sessionId: session.id,
				message: {
					role: "assistant",
					blocks: [{ kind: "text", text: "done" }],
				},
			});
			deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
		});

		expect(current?.toolCalls).toEqual({});
		const assistant = (current?.messages ?? [])
			.filter((message) => message.role === "assistant")
			.at(-1);
		expect(assistant?.blocks?.[0]).toEqual({
			kind: "tool",
			id: "t1",
			name: "bash",
			text: "hi\n",
			isError: false,
		});
		expect(assistant?.blocks?.[1]).toEqual({ kind: "text", text: "done" });
	});

	it("keeps structured thinking and tool fields from restored history", () => {
		act(() =>
			deliver({
				type: "entries",
				sessionId: session.id,
				entries: [
					{
						type: "message",
						message: {
							role: "assistant",
							timestamp: 9,
							content: [
								{ type: "thinking", thinking: "ponder" },
								{
									type: "tool",
									id: "t9",
									name: "bash",
									text: "out",
									isError: false,
								},
								{ type: "text", text: "final" },
							],
						},
					},
				],
			}),
		);

		const message = current?.messages[0];
		expect(message?.blocks?.[0]).toEqual({
			kind: "thinking",
			thinking: "ponder",
		});
		expect(message?.blocks?.[1]).toEqual({
			kind: "tool",
			id: "t9",
			name: "bash",
			text: "out",
			isError: false,
		});
	});
});

describe("ChatTranscript persisted disclosures", () => {
	let root: Root;
	let container: HTMLDivElement;

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

	it("renders persisted tool blocks as compact ToolCard disclosures", () => {
		const messages: readonly UiMessage[] = [
			{
				role: "assistant",
				blocks: [
					{ kind: "tool", id: "t9", name: "bash", text: "out", isError: false },
					{ kind: "text", text: "final" },
				],
			},
		];

		act(() =>
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript
						messages={messages}
						streaming=""
						thinking=""
						toolCalls={{}}
						doneReason={null}
						error=""
						restoreVersion={0}
					historyLoaded
					focused
					/>
				</I18nContext.Provider>,
			),
		);

		const card = container.querySelector<HTMLElement>(
			".th-tool[data-tool-call-id='t9']",
		);
		expect(card).not.toBeNull();
		expect(card?.querySelector(".th-tool-name")?.textContent).toBe("bash");
	});
});
