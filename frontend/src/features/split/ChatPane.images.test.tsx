import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import { clearChatMediaCache } from "../../lib/chatMedia";
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

const PNG_DATA = "iVBORw0KGgo=";

describe("ChatPane tool result images (production media wiring)", () => {
	let container: HTMLDivElement;
	let root: Root;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		clearChatMediaCache();
		fetchMock = vi.fn(async () =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				blob: async () => new Blob(["png-bytes"], { type: "image/png" }),
			}) as Response,
		);
		vi.stubGlobal("fetch", fetchMock);
		URL.createObjectURL = vi.fn(() => "blob:mock-media");
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

	// The pane itself issues unrelated fetches (goal, activity): track only
	// media requests.
	function mediaUrls(): readonly string[] {
		return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes("/media"));
	}

	function cardHead(toolCallId: string): HTMLButtonElement {
		const head = container.querySelector<HTMLButtonElement>(
			`.th-tool[data-tool-call-id='${toolCallId}'] .th-tool-head`,
		);
		if (head === null) throw new Error(`missing tool card head for ${toolCallId}`);
		return head;
	}

	function clickHead(toolCallId: string): Promise<void> {
		return act(async () => {
			cardHead(toolCallId).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	it("carries a live tool result image through run.done as one disclosure-gated card", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
			// Live tool start/end frames: the engine's own result content is
			// text-only; the image travels in the role "toolResult" message.
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "screenshot",
				phase: "start",
				args: { target: "viewport" },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-1",
				toolName: "screenshot",
				phase: "end",
				result: { content: [{ text: "captured viewport" }] },
				isError: false,
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "toolResult",
					blocks: [
						{
							kind: "image_ref",
							mimeType: "image/png",
							byteLength: 12595,
							ref: { toolCallId: "call-1", contentIndex: 0 },
						},
					],
				},
			});
		});

		// The live card exists; untouched and completed it stays collapsed, and
		// a collapsed card must not fetch the referenced media.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-1']")).toHaveLength(1);
		expect(cardHead("call-1").getAttribute("aria-expanded")).toBe("false");
		expect(mediaUrls()).toEqual([]);
		expect(container.querySelector("img.th-chat-image")).toBeNull();

		await clickHead("call-1");
		expect(cardHead("call-1").getAttribute("aria-expanded")).toBe("true");
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-1&contentIndex=0",
		]);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);

		await act(async () => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "here is the shot" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		// Finalization keeps exactly one card for the logical call (no duplicate
		// from the live region), and the image survives inside it without
		// refetching.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-1']")).toHaveLength(1);
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(mediaUrls()).toHaveLength(1);
	});

	it("renders a live inline result image inside its disclosure without fetching", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-inline",
				toolName: "render",
				phase: "start",
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-inline",
				toolName: "render",
				phase: "end",
				result: { content: [{ text: "rendered" }] },
				isError: false,
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "toolResult",
					blocks: [{ kind: "image", data: PNG_DATA, mimeType: "image/png" }],
				},
			});
		});

		// Collapsed: no image rendered, nothing fetched.
		expect(cardHead("call-inline").getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector("img.th-chat-image")).toBeNull();
		expect(mediaUrls()).toEqual([]);

		await clickHead("call-inline");
		const img = container.querySelector<HTMLImageElement>("img.th-chat-image");
		expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		expect(mediaUrls()).toEqual([]);
	});

	it("keeps additional result images inside their tool disclosure", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-multi",
				toolName: "gallery",
				phase: "start",
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-multi",
				toolName: "gallery",
				phase: "end",
				result: { content: [{ text: "two images" }] },
				isError: false,
			});
			// The result's first image plus an additional one: both belong to the
			// invocation's disclosure, neither may fetch while it is collapsed.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "toolResult",
					blocks: [
						{ kind: "image", data: PNG_DATA, mimeType: "image/png" },
						{
							kind: "image_ref",
							mimeType: "image/jpeg",
							byteLength: 2048,
							ref: { toolCallId: "call-multi", contentIndex: 1 },
						},
					],
				},
			});
		});

		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-multi']")).toHaveLength(1);
		expect(cardHead("call-multi").getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector("img.th-chat-image")).toBeNull();
		expect(mediaUrls()).toEqual([]);

		await clickHead("call-multi");
		const images = container.querySelectorAll<HTMLImageElement>("img.th-chat-image");
		expect(images).toHaveLength(2);
		expect(images[0]?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		expect(images[1]?.getAttribute("src")).toBe("blob:mock-media");
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-multi&contentIndex=1",
		]);

		// Collapsing the disclosure unmounts every result image of the call.
		await clickHead("call-multi");
		expect(container.querySelector("img.th-chat-image")).toBeNull();
	});

	it("fetches a restored tool result image through the pane's media source", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "call-restored", name: "screenshot" }],
						},
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: "call-restored",
							toolName: "screenshot",
							content: [
								{ type: "text", text: "captured" },
								{
									type: "image_ref",
									mimeType: "image/png",
									byteLength: 12595,
									ref: { toolCallId: "call-restored", contentIndex: 0 },
								},
							],
							isError: false,
						},
					},
				],
				leafId: "leaf-1",
			});
		});

		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-restored']")).toHaveLength(1);
		expect(mediaUrls()).toEqual([]);

		await clickHead("call-restored");
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-restored&contentIndex=0",
		]);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);
	});
});
