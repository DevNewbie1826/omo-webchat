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

	it("shows an approval modal and sends approval.respond on choice", () => {
		const { deliver, sent } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "approval",
				sessionId: "chat-1",
				id: "approve-1",
				method: "select",
				title: "Allow bash?",
				options: ["Allow", "Block"],
			});
		});
		expect(document.body.textContent).toContain("Allow bash?");
		const buttons = document.querySelectorAll<HTMLButtonElement>(
			".th-approval-options .th-btn",
		);
		const allow = Array.from(buttons).find((b) => b.textContent === "Allow");
		expect(allow).toBeDefined();
		act(() => {
			allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(sent).toContainEqual({
			type: "approval.respond",
			sessionId: "chat-1",
			requestId: expect.any(String),
			id: "approve-1",
			value: "Allow",
		});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("restores history from an entries frame without duplicating on later messages", () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{ type: "message", message: { role: "user", content: "past user" } },
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "past assistant" }],
						},
					},
				],
				leafId: "leaf-2",
			});
		});
		expect(container.textContent).toContain("past user");
		expect(container.textContent).toContain("past assistant");

		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "text", text: "live reply" }],
				},
			});
		});
		expect(container.textContent).toContain("live reply");
		const historyCount = container.querySelectorAll(
			".th-chat-history .th-chat-msg",
		).length;
		expect(historyCount).toBe(3);
	});

	it("renders a live custom hook as a collapsed tool-style disclosure", () => {
		const { deliver } = renderWithFakeConnect();
		const hookText =
			"<omo-senpi-task>\nBackground task results are automatically delivered.\n</omo-senpi-task>";
		act(() => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "custom",
					customType: "senpi-task.usage",
					blocks: [{ kind: "text", text: hookText }],
					ts: 42,
				},
			});
		});

		const hook = container.querySelector<HTMLElement>(
			'.th-hook[data-hook-type="senpi-task.usage"]',
		);
		expect(hook).not.toBeNull();
		const toggle = hook?.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(hook?.querySelector(".th-tool-preview")?.textContent).toContain(
			"<omo-senpi-task>",
		);
		expect(hook?.querySelector(".th-tool-body")).toBeNull();

		act(() => {
			toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(hook?.querySelector(".th-tool-body")?.textContent).toBe(hookText);
	});
});
