import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
} from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

export const session = {
	id: "chat-1",
	name: "Chat",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

/** Mutable reconnect probe — mutation is the fixture purpose. */
export type ReconnectHarness = {
	readonly root: Root;
	readonly container: HTMLDivElement;
	current: ReturnType<typeof useChatSession> | undefined;
	deliver: (frame: ChatServerFrame) => void;
	disconnect: () => void;
	reconnect: () => void;
	sent: ChatClientFrame[];
};

export function mountReconnectHarness(): ReconnectHarness {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const harness: ReconnectHarness = {
		root,
		container,
		current: undefined,
		deliver: () => undefined,
		disconnect: () => undefined,
		reconnect: () => undefined,
		sent: [],
	};
	const connect: ChatConnector = (handlers) => {
		harness.deliver = handlers.onFrame;
		harness.disconnect = () => handlers.onClose?.(1006);
		harness.reconnect = () => handlers.onOpen?.();
		handlers.onOpen?.();
		return {
			send: (frame) => {
				harness.sent.push(frame);
				return true;
			},
			close: () => undefined,
		};
	};
	function Probe() {
		harness.current = useChatSession(session, connect);
		return null;
	}
	act(() => root.render(<Probe />));
	return harness;
}

export async function unmountReconnectHarness(
	harness: ReconnectHarness,
): Promise<void> {
	await act(async () => {
		harness.root.unmount();
	});
	harness.container.remove();
	vi.unstubAllGlobals();
}
