import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession client send failures", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: ReturnType<typeof useChatSession> | undefined;
	let deliver: (frame: ChatServerFrame) => void;
	let send: (frame: ChatClientFrame) => boolean;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		send = () => true;
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			handlers.onOpen?.();
			return { send: (frame) => send(frame), close: () => undefined };
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

	it.each([
		["model", () => current?.changeModel("openai/gpt-5")],
		["thinking", () => current?.changeThinkingLevel("high")],
	] as const)(
		"surfaces a %s send returning false without disturbing the active prompt",
		(_name, operation) => {
			act(() => current?.submit({ text: "keep running", image: null }));
			send = () => false;

			act(operation);

			expect(current?.error).not.toBe("");
			expect(current?.running).toBe(true);
			expect(current?.messages).toHaveLength(1);
		},
	);

	it("surfaces a thrown control send without disturbing the active prompt", () => {
		act(() => current?.submit({ text: "keep running", image: null }));
		send = () => {
			throw new Error("socket write failed");
		};

		act(() => current?.changeThinkingLevel("high"));

		expect(current?.error).toContain("socket write failed");
		expect(current?.running).toBe(true);
		expect(current?.messages).toHaveLength(1);
	});

	it("keeps provider process ownership server-side when switching chat sessions", async () => {
		const closes: string[] = [];
		const sendsBySession = new Map<string, string[]>();
		const connect: ChatConnector = (handlers) => {
			let currentSession = "";
			const client = {
				send: (frame: ChatClientFrame) => {
					if (frame.type === "chat.create") currentSession = frame.chatId;
					if (frame.type === "chat.send") {
						const target = frame.sessionId || currentSession;
						sendsBySession.set(target, [...(sendsBySession.get(target) ?? []), frame.run.message]);
					}
					return true;
				},
				close: () => {
					closes.push(currentSession);
				},
			};
			queueMicrotask(() => handlers.onOpen?.());
			return client;
		};
		let active: ReturnType<typeof useChatSession> | undefined;
		function Probe({ activeId }: { readonly activeId: string }) {
			active = useChatSession({ ...session, id: activeId }, connect);
			return null;
		}
		act(() => root.render(<Probe activeId="chat-a" key="chat-a" />));
		await act(async () => undefined);
		act(() => active?.submit({ text: "long task", image: null }));
		act(() => root.render(<Probe activeId="chat-b" key="chat-b" />));
		await act(async () => undefined);
		act(() => active?.submit({ text: "second task", image: null }));

		expect(closes).toEqual(["chat-a"]);
		expect(sendsBySession.get("chat-a")).toEqual(["long task"]);
		expect(sendsBySession.get("chat-b")).toEqual(["second task"]);
	});

	it("keeps an approval available for retry until its response send succeeds", () => {
		act(() => current?.submit({ text: "keep running", image: null }));
		act(() =>
			deliver({
				type: "approval",
				sessionId: session.id,
				id: "approval-1",
				method: "confirm",
			}),
		);
		send = () => false;

		act(() => current?.respondApproval({ confirmed: true }));
		expect(current?.pendingApproval?.id).toBe("approval-1");
		expect(current?.error).not.toBe("");
		expect(current?.running).toBe(true);
		expect(current?.messages).toHaveLength(1);

		send = () => {
			throw new Error("approval write failed");
		};
		act(() => current?.respondApproval({ confirmed: true }));
		expect(current?.pendingApproval?.id).toBe("approval-1");
		expect(current?.error).toContain("approval write failed");

		send = () => true;
		act(() => current?.respondApproval({ confirmed: true }));
		expect(current?.pendingApproval).toBeNull();
	});
});
