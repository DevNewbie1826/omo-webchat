import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import type { ChatConnector } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

function i18nFor(lang: "en" | "ko"): I18nValue {
	return {
		lang,
		setLang: () => undefined,
		font: "system",
		setFont: () => undefined,
		fontSize: 13,
		setFontSize: () => undefined,
		t: (key) => translate(lang, key),
	};
}

interface SocketHandlers {
	onOpen: (() => void) | undefined;
	onClose: ((code: number) => void) | undefined;
	onParseError: ((raw: string) => void) | undefined;
}

describe("useChatSession parse-error surfacing", () => {
	let root: Root;
	let container: HTMLDivElement;
	let socket: SocketHandlers | undefined;
	let current: ReturnType<typeof useChatSession> | undefined;
	let sendSucceeds: boolean;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		socket = undefined;
		current = undefined;
		sendSucceeds = true;
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
		vi.restoreAllMocks();
	});

	const connect: ChatConnector = (handlers) => {
		socket = {
			onOpen: handlers.onOpen,
			onClose: handlers.onClose,
			onParseError: handlers.onParseError,
		};
		handlers.onOpen?.();
		return { send: () => sendSucceeds, close: () => undefined };
	};

	function Probe() {
		current = useChatSession(session, connect);
		return null;
	}

	// The connect effect captures the translator once per mount, so each case
	// mounts under the locale it asserts.
	const mount = (lang: "en" | "ko"): void => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18nFor(lang)}>
					<Probe />
				</I18nContext.Provider>,
			);
		});
	};

	it("maps a malformed inbound frame to the session error state", () => {
		mount("en");
		expect(socket?.onParseError).toBeDefined();
		act(() => socket?.onParseError?.("{bad"));
		expect(current?.error).toBe("Received a malformed server frame.");
	});

	it("sets the banner to the active translator's chat.malformedFrame value", () => {
		mount("ko");
		act(() => socket?.onParseError?.("{bad"));
		expect(current?.error).toBe(translate("ko", "chat.malformedFrame"));
		expect(current?.error).not.toBe(translate("en", "chat.malformedFrame"));
	});

	it("logs the dropped frame once with the payload truncated to 500 chars", () => {
		mount("en");
		act(() => socket?.onParseError?.(`{${"x".repeat(600)}`));
		const dropped = vi.mocked(console.warn).mock.calls
			.filter((call) => call[0] === "[chatWs] non-JSON frame dropped");
		expect(dropped).toHaveLength(1);
		expect(dropped[0]?.[1]).toBe(`{${"x".repeat(499)}`);
	});

	it("clears the malformed-frame banner when the socket closes", () => {
		mount("en");
		act(() => socket?.onParseError?.("{bad"));
		expect(current?.error).toBe(translate("en", "chat.malformedFrame"));
		act(() => socket?.onClose?.(1006));
		expect(current?.error).toBe("");
	});

	it("keeps the malformed-frame banner while the socket stays open", () => {
		mount("en");
		act(() => socket?.onParseError?.("{bad"));
		expect(current?.error).toBe(translate("en", "chat.malformedFrame"));
		act(() => {
			root.render(
				<I18nContext.Provider value={i18nFor("en")}>
					<Probe />
				</I18nContext.Provider>,
			);
		});
		expect(current?.error).toBe(translate("en", "chat.malformedFrame"));
	});

	it("keeps the banner clear after the socket closes and reopens", () => {
		mount("en");
		act(() => socket?.onParseError?.("{bad"));
		act(() => socket?.onClose?.(1006));
		expect(current?.error).toBe("");
		act(() => socket?.onOpen?.());
		expect(current?.error).toBe("");
	});

	it("does not clear an unrelated error when the socket closes", () => {
		mount("en");
		sendSucceeds = false;
		act(() => {
			current?.disconnect();
		});
		expect(current?.error).toBe("Failed to disconnect the session.");
		act(() => socket?.onClose?.(1006));
		expect(current?.error).toBe("Failed to disconnect the session.");
	});
});
