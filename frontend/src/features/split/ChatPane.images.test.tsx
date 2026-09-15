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

/** Manually-driven IntersectionObserver: tests decide when an element "enters
 * the viewport" by calling intersect(true) on the instances they care about. */
class MockIntersectionObserver {
	static instances: MockIntersectionObserver[] = [];

	readonly observed: Element[] = [];
	private readonly callback: IntersectionObserverCallback;

	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		MockIntersectionObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.push(target);
	}

	unobserve(target: Element): void {
		const index = this.observed.indexOf(target);
		if (index >= 0) this.observed.splice(index, 1);
	}

	disconnect(): void {
		this.observed.splice(0, this.observed.length);
	}

	intersect(isIntersecting: boolean): void {
		this.callback(
			this.observed.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
			this as unknown as IntersectionObserver,
		);
	}
}

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
		MockIntersectionObserver.instances.length = 0;
		vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
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
		// a collapsed card fetches nothing until its image enters the viewport.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-1']")).toHaveLength(1);
		expect(cardHead("call-1").getAttribute("aria-expanded")).toBe("false");
		expect(mediaUrls()).toEqual([]);
		expect(container.querySelector("img.th-chat-image")).toBeNull();

		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-1&contentIndex=0",
		]);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);

		await clickHead("call-1");
		expect(cardHead("call-1").getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-1']")).toHaveLength(1);
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(mediaUrls()).toHaveLength(1);

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
		// refetching — a remounted image re-enters the viewport and is served
		// from the cache.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-1']")).toHaveLength(1);
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(mediaUrls()).toHaveLength(1);
	});

	it("renders live media for an invocation anchored by an earlier assistant toolCall, through run.done", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
			// The reviewer counter-case: the assistant toolCall frame anchors the
			// invocation BEFORE the tool and toolResult frames, so the transcript
			// message owns the card and the live region excludes the anchored id.
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "assistant",
					blocks: [{ kind: "toolCall", id: "call-anchored", name: "screenshot", arguments: { target: "viewport" } }],
				},
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-anchored",
				toolName: "screenshot",
				phase: "start",
				args: { target: "viewport" },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-anchored",
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
					blocks: [{
						kind: "image_ref",
						mimeType: "image/png",
						byteLength: 12595,
						ref: { toolCallId: "call-anchored", contentIndex: 0 },
					}],
				},
			});
		});

		// One card for the logical call; untouched and completed it stays
		// collapsed and fetches nothing until the image is visible.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-anchored']")).toHaveLength(1);
		expect(cardHead("call-anchored").getAttribute("aria-expanded")).toBe("false");
		expect(mediaUrls()).toEqual([]);

		// The image entering the viewport issues the media request an unanchored
		// live card would have issued.
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-anchored&contentIndex=0",
		]);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");

		// Expanding keeps exactly one card and one image, without refetching.
		await clickHead("call-anchored");
		expect(cardHead("call-anchored").getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-anchored']")).toHaveLength(1);
		expect(mediaUrls()).toHaveLength(1);

		await act(async () => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "here is the shot" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});

		// Finalization keeps exactly one card for the logical call (the
			// anchored block is replaced in place, never duplicated), and the
			// image survives inside it without refetching.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-anchored']")).toHaveLength(1);
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
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

		// Collapsed: the inline image renders immediately from its bytes, and
		// nothing is ever fetched.
		expect(cardHead("call-inline").getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			`data:image/png;base64,${PNG_DATA}`,
		);
		expect(mediaUrls()).toEqual([]);

		await clickHead("call-inline");
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			`data:image/png;base64,${PNG_DATA}`,
		);
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
			// The result's first image plus two additional ones: all belong to
			// the invocation's disclosure, none may fetch while it is collapsed.
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
						{
							kind: "image_ref",
							mimeType: "image/webp",
							byteLength: 4096,
							ref: { toolCallId: "call-multi", contentIndex: 2 },
						},
					],
				},
			});
		});

		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-multi']")).toHaveLength(1);
		expect(cardHead("call-multi").getAttribute("aria-expanded")).toBe("false");
		// Collapsed: the inline image renders from its bytes, the two refs wait
		// as pending frames, and nothing has been fetched.
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(mediaUrls()).toEqual([]);

		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		const images = container.querySelectorAll<HTMLImageElement>("img.th-chat-image");
		expect(images).toHaveLength(3);
		expect(images[0]?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		expect(images[1]?.getAttribute("src")).toBe("blob:mock-media");
		expect(images[2]?.getAttribute("src")).toBe("blob:mock-media");
		// Each ref coordinate of the call fetches independently, exactly once.
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-multi&contentIndex=1",
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-multi&contentIndex=2",
		]);

		await clickHead("call-multi");
		expect(cardHead("call-multi").getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(3);

		// Collapsing the disclosure keeps every result image of the call in
		// place and never refetches; re-expanding changes nothing either.
		await clickHead("call-multi");
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(3);
		await clickHead("call-multi");
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(3);
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-multi&contentIndex=1",
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-multi&contentIndex=2",
		]);
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

		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-restored&contentIndex=0",
		]);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);

		// Expanding the card never refetches the already-visible image.
		await clickHead("call-restored");
		expect(mediaUrls()).toHaveLength(1);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);
	});

	it("renders a collapsed live card's result image and fetches it exactly once on viewport entry", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-collapsed",
				toolName: "read",
				phase: "start",
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-collapsed",
				toolName: "read",
				phase: "end",
				result: { content: [{ text: "read done" }] },
				isError: false,
			});
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: {
					role: "toolResult",
					blocks: [{
						kind: "image_ref",
						mimeType: "image/png",
						byteLength: 12595,
						ref: { toolCallId: "call-collapsed", contentIndex: 0 },
					}],
				},
			});
		});

		// Collapsed and untouched: the pending image is mounted and observes the
		// viewport, but nothing has been fetched yet.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-collapsed']")).toHaveLength(1);
		expect(cardHead("call-collapsed").getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector("img.th-chat-image")).toBeNull();
		expect(mediaUrls()).toEqual([]);

		// Entering the viewport fetches exactly once and materializes the image.
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(mediaUrls()).toEqual([
			"/api/workspaces/workspace-1/chats/chat-1/media?toolCallId=call-collapsed&contentIndex=0",
		]);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");

		// Expanding the card adds no second card, no duplicate image, no refetch.
		await clickHead("call-collapsed");
		expect(cardHead("call-collapsed").getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-collapsed']")).toHaveLength(1);
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(mediaUrls()).toHaveLength(1);

		// run.done finalization keeps one card and one image; remounts are served
		// from the cache once the image re-enters the viewport, never refetching.
		await act(async () => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "here is the shot" }] },
				});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='call-collapsed']")).toHaveLength(1);
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(mediaUrls()).toHaveLength(1);
	});

	it("restores focus to the image trigger when the zoom closes after the live row finalizes", async () => {
		const { deliver } = renderWithFakeConnect();
		act(() => {
			deliver({ type: "run.started", sessionId: "chat-1" });
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-zoom",
				toolName: "screenshot",
				phase: "start",
				args: { target: "viewport" },
			});
			deliver({
				type: "tool",
				sessionId: "chat-1",
				toolCallId: "call-zoom",
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
					blocks: [{
						kind: "image_ref",
						mimeType: "image/png",
						byteLength: 12595,
						ref: { toolCallId: "call-zoom", contentIndex: 0 },
					}],
				},
			});
		});
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		const trigger = container.querySelector<HTMLButtonElement>(".th-chat-image-button");
		expect(trigger).not.toBeNull();

		// Open the zoom from the live row's trigger, with focus on it like a
		// real keyboard/pointer interaction.
		await act(async () => {
			trigger?.focus();
			trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(document.querySelector(".th-modal")).not.toBeNull();

		// The run finalizes underneath the open zoom: the live row is replaced
		// by the history row, disconnecting the original trigger node.
		await act(async () => {
			deliver({
				type: "message",
				sessionId: "chat-1",
				message: { role: "assistant", blocks: [{ kind: "text", text: "here is the shot" }] },
			});
			deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" });
		});
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(trigger?.isConnected).toBe(false);
		const replacement = container.querySelector<HTMLButtonElement>(".th-chat-image-button");
		expect(replacement).not.toBeNull();

		// Escape closes the zoom: focus must land on the CURRENT trigger, never
		// fall through to <body> because the opener node was replaced.
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		expect(document.querySelector(".th-modal")).toBeNull();
		expect(document.activeElement).toBe(replacement);
	});
});
