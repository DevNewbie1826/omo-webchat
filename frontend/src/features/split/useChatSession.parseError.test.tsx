import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

describe("useChatSession parse-error surfacing", () => {
	let root: Root;
	let container: HTMLDivElement;
	let onParseError: ((raw: string) => void) | undefined;
	let current: ReturnType<typeof useChatSession> | undefined;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const connect: ChatConnector = (handlers) => {
			onParseError = handlers.onParseError;
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

	it("maps a malformed inbound frame to the session error state", () => {
		expect(onParseError).toBeDefined();
		act(() => onParseError?.("{bad"));
		expect(current?.error).toBe("Received a malformed server frame.");
	});
});
