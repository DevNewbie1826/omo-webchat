import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type {
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
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

/**
 * C3 DOM surface: each recovery phase renders as a distinct status item, and
 * recovery-incomplete is always a warning carrying the reason — never a
 * normal or success treatment.
 */
describe("ChatPane recovery states", () => {
	let container: HTMLDivElement;
	let root: Root;
	let deliver: (frame: ChatServerFrame) => void;
	let disconnect: () => void;
	let reconnect: () => void;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const sent: ChatClientFrame[] = [];
		const connect: ChatConnector = (handlers) => {
			deliver = handlers.onFrame;
			disconnect = () => handlers.onClose?.(1006);
			reconnect = () => handlers.onOpen?.();
			handlers.onOpen?.();
			return {
				send: (frame) => {
					sent.push(frame);
					return true;
				},
				close: vi.fn(),
			};
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
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	const ready = (resumed = true) =>
		deliver({
			type: "ready",
			sessionId: "chat-1",
			piSessionId: "pi-1",
			resumed,
		});
	const recoveryItem = () =>
		container.querySelector<HTMLElement>("[data-recovery-phase]");

	it("renders no recovery item while the initial attachment is healthy", () => {
		act(() => ready(false));
		expect(recoveryItem()).toBeNull();
	});

	it("renders reconnecting while the socket is down", () => {
		act(() => disconnect());
		expect(
			container.querySelector('[data-chat-run-state="reconnecting"]'),
		).not.toBeNull();
		expect(recoveryItem()?.dataset["recoveryPhase"]).toBe("reconnecting");
	});

	it("renders session-resuming once the transport is back but the replay is pending", () => {
		act(() => disconnect());
		act(() => reconnect());
		const item = recoveryItem();
		expect(item?.dataset["recoveryPhase"]).toBe("resuming");
		expect(item?.textContent).toContain("chat.recoveryResuming");
	});

	it("renders recovered after the rebinding replay's ready frame", () => {
		act(() => disconnect());
		act(() => reconnect());
		act(() => ready(true));
		const item = recoveryItem();
		expect(item?.dataset["recoveryPhase"]).toBe("recovered");
		expect(item?.textContent).toContain("chat.recoveryRecovered");
	});

	it("renders recovery-incomplete as a warning with the reason, never as success", () => {
		act(() => disconnect());
		act(() => reconnect());
		act(() =>
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "resume_failed",
				message: "session is active in another process",
			}),
		);
		const item = recoveryItem();
		expect(item?.dataset["recoveryPhase"]).toBe("incomplete");
		expect(item?.className).toContain("th-chat-status-item--warn");
		expect(item?.className).not.toContain("th-chat-status-item--live");
		expect(item?.textContent).toContain("chat.recoveryIncomplete");
		expect(item?.textContent).toContain(
			"session is active in another process",
		);

		// A later ready must not flip the warning into a success report.
		act(() => ready(false));
		expect(recoveryItem()?.dataset["recoveryPhase"]).toBe("incomplete");
		expect(recoveryItem()?.className).toContain("th-chat-status-item--warn");
	});
});
