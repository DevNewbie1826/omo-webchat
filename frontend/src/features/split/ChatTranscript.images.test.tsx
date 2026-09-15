import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import type { ContentBlock } from "../../lib/chatWs";
import { clearChatMediaCache, type ChatMediaSource } from "../../lib/chatMedia";
import { ChatTranscript } from "./ChatTranscript";
import type { ToolEntry } from "./chatSessionTypes";

const PNG_DATA = "iVBORw0KGgo=";

/** Manually-driven IntersectionObserver: tests decide when an element "enters
 * the viewport" by calling intersect(true) on the instance they care about. */
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

function lastObserver(): MockIntersectionObserver {
	const instance = MockIntersectionObserver.instances.at(-1);
	if (instance === undefined) throw new Error("no IntersectionObserver was created");
	return instance;
}

const baseProps = {
	streaming: "",
	thinking: "",
	toolCalls: {} as Readonly<Record<string, ToolEntry>>,
	doneReason: null,
	error: "",
	restoreVersion: 0,
	focused: false,
	historyLoaded: true,
	mediaSource: { wsId: "ws-1", chatId: "chat-1" },
};

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key, vars) => translate("en", key, vars),
};

function messageItem(blocks: readonly ContentBlock[]) {
	return { kind: "message" as const, message: { role: "assistant", blocks, ts: 0 } };
}

function okImageResponse() {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		blob: async () => new Blob(["png-bytes"], { type: "image/png" }),
	} as Response;
}

function errorResponse() {
	return {
		ok: false,
		status: 500,
		statusText: "Internal Server Error",
		json: async () => ({ error: "boom" }),
		text: async () => "{\"error\":\"boom\"}",
	} as Response;
}

describe("ChatTranscript preserved image blocks", () => {
	let root: Root;
	let container: HTMLDivElement;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		clearChatMediaCache();
		fetchMock = vi.fn(async () => okImageResponse());
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

	it("renders an inline data image block as an <img> with a data URI and never fetches", () => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript
						{...baseProps}
						items={[messageItem([{ kind: "image", data: PNG_DATA, mimeType: "image/png" }])]}
					/>
				</I18nContext.Provider>,
			);
		});
		const img = container.querySelector<HTMLImageElement>("img.th-chat-image");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches a collapsed card's image_ref on viewport entry and caches it across collapse, expand, and remount", async () => {
		const block: ContentBlock = {
			kind: "tool",
			id: "t1",
			name: "screenshot",
			text: "captured",
			mimeType: "image/png",
			byteLength: 12595,
			ref: { toolCallId: "t1", contentIndex: 0 },
		};
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem([block])]} />
				</I18nContext.Provider>,
			);
		});
		// Collapsed card: the image element mounts (pending frame) and observes
		// the viewport, but an unentered element requests nothing.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(container.querySelector("img.th-chat-image")).toBeNull();
		expect(MockIntersectionObserver.instances).toHaveLength(1);

		await act(async () => {
			lastObserver().intersect(true);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t1&contentIndex=0",
		);
		const img = container.querySelector<HTMLImageElement>("img.th-chat-image");
		expect(img?.getAttribute("src")).toBe("blob:mock-media");

		// Re-render and remount of the row must not refetch: the cache is keyed
		// per (toolCallId, contentIndex).
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem([block])]} restoreVersion={1} />
				</I18nContext.Provider>,
			);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(container.querySelector("img.th-chat-image")).not.toBeNull();

		// A committed collapse keeps the image visible; re-expanding never
		// refetches — the disclosure no longer gates the media DOM.
		const collapsedHead = container.querySelector<HTMLButtonElement>(".th-tool-head");
		await act(async () => {
			collapsedHead?.click();
		});
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");
		const reopenedHead = container.querySelector<HTMLButtonElement>(".th-tool-head");
		await act(async () => {
			reopenedHead?.click();
		});
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// A full unmount/remount into a fresh root is also served from the
		// page-lifetime cache once the remounted image enters the viewport.
		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem([block])]} />
				</I18nContext.Provider>,
			);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");
	});

	it("fetches each distinct workspace, chat, or ref coordinate independently", async () => {
		const block: ContentBlock = {
			kind: "tool",
			id: "t-coord",
			name: "screenshot",
			text: "captured",
			ref: { toolCallId: "t-coord", contentIndex: 0 },
		};
		const renderWith = (mediaSource: ChatMediaSource) => {
			act(() => {
				root.render(
					<I18nContext.Provider value={i18n}>
						<ChatTranscript {...baseProps} mediaSource={mediaSource} items={[messageItem([block])]} />
					</I18nContext.Provider>,
				);
			});
		};
		renderWith({ wsId: "ws-1", chatId: "chat-1" });
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t-coord&contentIndex=0",
		);

		// The same ref under another workspace or chat is a different cache
		// coordinate: each fetches independently of the cached promise.
		renderWith({ wsId: "ws-2", chatId: "chat-1" });
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"/api/workspaces/ws-2/chats/chat-1/media?toolCallId=t-coord&contentIndex=0",
		);
		renderWith({ wsId: "ws-2", chatId: "chat-2" });
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"/api/workspaces/ws-2/chats/chat-2/media?toolCallId=t-coord&contentIndex=0",
		);

		// A second result image of the same call — a different ref coordinate
		// (contentIndex) — fetches on its own when it becomes visible too.
		const nextBlock: ContentBlock = {
			kind: "image_ref",
			mimeType: "image/png",
			ref: { toolCallId: "t-coord", contentIndex: 1 },
		};
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript
						{...baseProps}
						mediaSource={{ wsId: "ws-2", chatId: "chat-2" }}
						items={[messageItem([block, nextBlock])]}
					/>
				</I18nContext.Provider>,
			);
		});
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(
			"/api/workspaces/ws-2/chats/chat-2/media?toolCallId=t-coord&contentIndex=1",
		);
	});

	it("shows the mimeType + byteLength fallback when the media fetch fails", async () => {
		fetchMock.mockImplementation(async () => errorResponse());
		const block: ContentBlock = {
			kind: "tool",
			id: "t2",
			name: "screenshot",
			text: "captured",
			mimeType: "image/png",
			byteLength: 12595,
			ref: { toolCallId: "t2", contentIndex: 1 },
		};
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem([block])]} />
				</I18nContext.Provider>,
			);
		});
		await act(async () => {
			lastObserver().intersect(true);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const fallback = container.querySelector(".th-chat-image-unavailable");
		expect(fallback).not.toBeNull();
		expect(fallback?.textContent).toContain("image/png");
		expect(fallback?.textContent).toContain("12.3 KB");
		expect(fallback?.textContent).toContain(translate("en", "chat.imageUnavailable"));
		expect(container.querySelector("img.th-chat-image")).toBeNull();
	});

	it("fetches a standalone image_ref block when it enters the viewport (it is the visible content)", async () => {
		const block: ContentBlock = {
			kind: "image_ref",
			mimeType: "image/jpeg",
			byteLength: 2048,
			ref: { toolCallId: "t9", contentIndex: 0 },
		};
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem([block])]} />
				</I18nContext.Provider>,
			);
		});
		expect(fetchMock).not.toHaveBeenCalled();
		await act(async () => {
			lastObserver().intersect(true);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t9&contentIndex=0",
		);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);
	});

	it("renders live media inside the existing disclosure of a transcript-anchored invocation", async () => {
		// The engine can anchor the invocation first: the assistant toolCall
		// block lands in the transcript before the tool/result frames. The
		// live entry then carries the result media; the anchored card's own
		// disclosure must surface it (the live region excludes anchored ids),
		// or expanding the single card issues zero media requests.
		const block: ContentBlock = {
			kind: "toolCall",
			id: "t-anchored",
			name: "screenshot",
			arguments: { target: "viewport" },
		};
		const liveEntry: ToolEntry = {
			toolName: "screenshot",
			phase: "end",
			text: "captured",
			isError: false,
			media: [{ ref: { toolCallId: "t-anchored", contentIndex: 0 } }],
		};
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript
						{...baseProps}
						toolCalls={{ "t-anchored": liveEntry }}
						items={[messageItem([block])]}
					/>
				</I18nContext.Provider>,
			);
		});
		// Exactly one card for the logical call; untouched and completed it
		// stays collapsed and fetches nothing until the image is visible.
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='t-anchored']")).toHaveLength(1);
		expect(container.querySelector<HTMLButtonElement>(".th-tool-head")?.getAttribute("aria-expanded")).toBe("false");
		expect(fetchMock).not.toHaveBeenCalled();

		await act(async () => {
			lastObserver().intersect(true);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t-anchored&contentIndex=0",
		);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");

		// Expanding the card adds no second card and no refetch.
		const head = container.querySelector<HTMLButtonElement>(".th-tool-head");
		await act(async () => {
			head?.click();
		});
		expect(container.querySelectorAll(".th-tool[data-tool-call-id='t-anchored']")).toHaveLength(1);
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps additional result images inside their tool disclosure, visible while collapsed", async () => {
		// The restored form of a multi-image result: the first image folds onto
		// the tool block, additional images are stored as standalone blocks
		// after it. All render while the disclosure is collapsed; only the ref
		// image waits for the viewport to request its bytes.
		const blocks: readonly ContentBlock[] = [
			{
				kind: "tool",
				id: "t-multi",
				name: "gallery",
				text: "two images",
				data: PNG_DATA,
				mimeType: "image/png",
			},
			{
				kind: "image_ref",
				mimeType: "image/jpeg",
				byteLength: 2048,
				ref: { toolCallId: "t-multi", contentIndex: 1 },
			},
		];
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem(blocks)]} />
				</I18nContext.Provider>,
			);
		});
		const collapsedImages = container.querySelectorAll<HTMLImageElement>("img.th-chat-image");
		expect(collapsedImages).toHaveLength(1);
		expect(collapsedImages[0]?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		expect(fetchMock).not.toHaveBeenCalled();

		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		const images = container.querySelectorAll<HTMLImageElement>("img.th-chat-image");
		expect(images).toHaveLength(2);
		expect(images[0]?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		expect(images[1]?.getAttribute("src")).toBe("blob:mock-media");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t-multi&contentIndex=1",
		);
	});
});

describe("ChatTranscript collapsed-card result images", () => {
	let root: Root;
	let container: HTMLDivElement;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		clearChatMediaCache();
		fetchMock = vi.fn(async () => okImageResponse());
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

	function renderBlocks(blocks: readonly ContentBlock[]): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem(blocks)]} />
				</I18nContext.Provider>,
			);
		});
	}

	it("renders an inline result image while its tool card is collapsed", () => {
		renderBlocks([
			{
				kind: "tool",
				id: "t-collapsed-inline",
				name: "read",
				text: "read 완료 · Read image file [image/png]",
				data: PNG_DATA,
				mimeType: "image/png",
			},
		]);
		// Default state is collapsed; the image must still be in the DOM.
		expect(container.querySelector<HTMLButtonElement>(".th-tool-head")?.getAttribute("aria-expanded")).toBe("false");
		const img = container.querySelector<HTMLImageElement>("img.th-chat-image");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_DATA}`);
		// Inline bytes need no fetch.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches a collapsed card's image_ref zero times until the image enters the viewport, then exactly once", async () => {
		renderBlocks([
			{
				kind: "tool",
				id: "t-collapsed-ref",
				name: "read",
				text: "Read image file",
				mimeType: "image/png",
				byteLength: 12595,
				ref: { toolCallId: "t-collapsed-ref", contentIndex: 0 },
			},
		]);
		// The collapsed card mounts the image element and it observes the
		// viewport, but an unentered element must never issue a request.
		expect(MockIntersectionObserver.instances).toHaveLength(1);
		expect(lastObserver().observed).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();

		await act(async () => {
			lastObserver().intersect(true);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t-collapsed-ref&contentIndex=0",
		);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");
	});

	it("keeps a collapsed-fetched image_ref cached across re-expand and remount", async () => {
		const block: ContentBlock = {
			kind: "tool",
			id: "t-collapsed-cache",
			name: "read",
			text: "Read image file",
			ref: { toolCallId: "t-collapsed-cache", contentIndex: 0 },
		};
		renderBlocks([block]);
		await act(async () => {
			lastObserver().intersect(true);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Re-expanding and re-collapsing the card never duplicates the image or
		// refetches: the card's disclosure no longer gates the media DOM.
		const head = () => container.querySelector<HTMLButtonElement>(".th-tool-head");
		await act(async () => {
			head()?.click();
		});
		await act(async () => {
			head()?.click();
		});
		expect(container.querySelectorAll(".th-tool")).toHaveLength(1);
		expect(container.querySelectorAll("img.th-chat-image")).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// A full unmount/remount into a fresh root is served from the cache once
		// the remounted image enters the viewport: still exactly one request.
		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);
		renderBlocks([block]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await act(async () => {
			MockIntersectionObserver.instances.forEach((observer) => observer.intersect(true));
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe("blob:mock-media");
	});
});
