import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import type { ContentBlock } from "../../lib/chatWs";
import { clearChatMediaCache } from "../../lib/chatMedia";
import { ChatTranscript } from "./ChatTranscript";
import type { ToolEntry } from "./chatSessionTypes";

const PNG_DATA = "iVBORw0KGgo=";

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

	it("fetches an image_ref only once its tool disclosure is expanded, and caches it", async () => {
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
		// Collapsed disclosure: no request, no image.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(container.querySelector("img.th-chat-image")).toBeNull();

		const head = container.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(head).not.toBeNull();
		await act(async () => {
			head?.click();
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
		const head = container.querySelector<HTMLButtonElement>(".th-tool-head");
		await act(async () => {
			head?.click();
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const fallback = container.querySelector(".th-chat-image-unavailable");
		expect(fallback).not.toBeNull();
		expect(fallback?.textContent).toContain("image/png");
		expect(fallback?.textContent).toContain("12.3 KB");
		expect(fallback?.textContent).toContain(translate("en", "chat.imageUnavailable"));
		expect(container.querySelector("img.th-chat-image")).toBeNull();
	});

	it("fetches a standalone image_ref block on mount (it is already visible)", async () => {
		const block: ContentBlock = {
			kind: "image_ref",
			mimeType: "image/jpeg",
			byteLength: 2048,
			ref: { toolCallId: "t9", contentIndex: 0 },
		};
		await act(async () => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatTranscript {...baseProps} items={[messageItem([block])]} />
				</I18nContext.Provider>,
			);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/workspaces/ws-1/chats/chat-1/media?toolCallId=t9&contentIndex=0",
		);
		expect(container.querySelector<HTMLImageElement>("img.th-chat-image")?.getAttribute("src")).toBe(
			"blob:mock-media",
		);
	});

	it("keeps additional result images inside their tool disclosure, gated on expansion", async () => {
		// The restored form of a multi-image result: the first image folds onto
		// the tool block, additional images are stored as standalone blocks
		// after it. Neither may fetch or render while the disclosure is
		// collapsed.
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
		expect(container.querySelector("img.th-chat-image")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();

		const head = container.querySelector<HTMLButtonElement>(".th-tool-head");
		await act(async () => {
			head?.click();
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
