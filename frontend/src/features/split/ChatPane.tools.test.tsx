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

	it("renders a live tool block collapsed while running and keeps it collapsed when untouched", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "start",
				args: { command: "ls" },
			});
		});
		const card = container.querySelector(".th-tool[data-tool-call-id='call-1']");
		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(head?.tagName).toBe("BUTTON");
		// Running: the untouched card stays collapsed; the head preview carries
		// the live progress instead.
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(card?.querySelector(".th-tool-body")).toBeNull();

		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "line1\nline2\n" }] },
				isError: false,
			});
		});
		// Untouched: completion must not open the card either; the output stays
		// reachable behind the invocation summary.
		expect(container.textContent).toContain("tool.done");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(card?.querySelector(".th-tool-body")).toBeNull();
		// The user's toggle freezes the choice from then on.
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain("line1\nline2\n");

		// A later call starts collapsed too; the user opens it and the open
		// choice stays frozen through that call's completion.
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-2",
				toolName: "bash",
				phase: "start",
				args: { command: "pwd" },
			});
		});
		const head2 = container.querySelector<HTMLButtonElement>(".th-tool[data-tool-call-id='call-2'] .th-tool-head");
		expect(head2?.getAttribute("aria-expanded")).toBe("false");
		act(() => {
			head2?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(head2?.getAttribute("aria-expanded")).toBe("true");
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-2",
				toolName: "bash",
				phase: "end",
				result: { content: [{ text: "/work\n" }] },
				isError: false,
			});
		});
		expect(head2?.getAttribute("aria-expanded")).toBe("true");
	});

	it("renders an omo task as a live sub-agent card and follows its reported status", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "task-1",
				toolName: "task",
				phase: "update",
				args: { description: "Fallback description" },
				partial: {
					content: [{ text: "↳ last: inspecting files" }],
					details: { task_id: "st_1", status: "running", task_summary: "Inspect frontend" },
				},
			});
		});

		const card = container.querySelector(".th-tool[data-tool-call-id='task-1']");
		expect(card?.querySelector(".th-tool-name")?.textContent).toBe("Inspect frontend");
		expect(card?.querySelector(".th-tool-status--running")?.textContent).toBe("tool.running");
		expect(card?.querySelector(".th-tool-glyph--running")).not.toBeNull();
		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		// A running sub-agent stays collapsed untouched; the head preview still
		// carries its live output.
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(card?.querySelector(".th-tool-preview")?.textContent).toBe("↳ last: inspecting files");
		expect(card?.querySelector(".th-tool-body")).toBeNull();
		// The user opens it, then collapses it again; completion must not
		// override that choice.
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain("↳ last: inspecting files");
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(head?.getAttribute("aria-expanded")).toBe("false");

		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "task-1",
				toolName: "task",
				phase: "end",
				args: { description: "Fallback description" },
				result: {
					content: [{ text: "Inspection complete" }],
					details: { task_id: "st_1", status: "completed", task_summary: "Inspect frontend" },
				},
				isError: false,
			});
		});

		expect(card?.classList.contains("th-tool--ok")).toBe(true);
		expect(card?.querySelector(".th-tool-status--ok")?.textContent).toBe("tool.done");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		// The user re-opens it to read the final output.
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain("Inspection complete");
	});

	it("renders a task name and derives completion without status details", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "task-fallback",
				toolName: "task",
				phase: "update",
				args: { tasks: [{ name: "Greeter", effort: "low", task: "Say hello", agent: "explore" }] },
				partial: {
					content: [{ text: "Running agent Greeter…" }],
					details: { results: [], totalDurationMs: 12 },
				},
			});
		});

		const card = container.querySelector(".th-tool[data-tool-call-id='task-fallback']");
		expect(card?.querySelector(".th-tool-name")?.textContent).toBe("Greeter");
		expect(card?.querySelector(".th-tool-status--running")?.textContent).toBe("tool.running");
		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(card?.querySelector(".th-tool-preview")?.textContent).toBe("Running agent Greeter…");
		expect(card?.querySelector(".th-tool-body")).toBeNull();
		// The user opens it; later phase updates must not move that choice.
		act(() => {
			head?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain("Running agent Greeter…");

		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "task-fallback",
				toolName: "task",
				phase: "update",
				args: { tasks: [{ name: "Greeter", effort: "low", task: "Say hello", agent: "explore" }] },
				partial: {
					content: [{ text: "Agent Greeter complete" }],
					details: { results: [{ name: "Greeter" }], totalDurationMs: 20 },
				},
			});
		});

		// The phase update must not move the choice the user made.
		expect(card?.classList.contains("th-tool--ok")).toBe(true);
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain("Agent Greeter complete");
	});

	it("renders a failed task with error styling", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "task-error",
				toolName: "task",
				phase: "end",
				args: { description: "Broken task" },
				result: {
					content: [{ text: "Agent failed" }],
					details: { status: "completed", task_summary: "Broken sub-agent" },
				},
				isError: true,
			});
		});

		const card = container.querySelector(".th-tool[data-tool-call-id='task-error']");
		expect(card?.classList.contains("th-tool--error")).toBe(true);
		expect(card?.querySelector(".th-tool-status--error")?.textContent).toBe("tool.error");
		expect(card?.querySelector(".th-tool-glyph--error")?.textContent).toBe("!");
		// A failed call is the one phase that auto-opens an untouched card, so
		// the failure output is impossible to miss.
		const head = card?.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(card?.querySelector(".th-tool-body")?.textContent).toContain("Agent failed");
	});

});
