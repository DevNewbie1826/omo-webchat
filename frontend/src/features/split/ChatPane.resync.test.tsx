import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledResizeObserver, renderChatPane, requireElement } from "./chatPaneTestHarness";

function resyncButton(root: { container: HTMLElement }): HTMLButtonElement {
	return requireElement(
		root.container.querySelector<HTMLButtonElement>(".th-chat-resync-btn"),
		"resync control",
	);
}

describe("ChatPane resync", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		ControlledResizeObserver.instances = [];
		vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		ControlledResizeObserver.instances = [];
		container.remove();
		vi.unstubAllGlobals();
	});

	it("sends chat.close then chat.create with the same binding and stays busy until ready", () => {
		const { deliver, sent } = renderChatPane(root);

		act(() => resyncButton({ container }).click());

		expect(sent.slice(-2)).toEqual([
			{ type: "chat.close", sessionId: "chat-1" },
			{ type: "chat.create", wsId: "workspace-1", chatId: "chat-1" },
		]);
		expect(resyncButton({ container }).disabled).toBe(true);
		expect(resyncButton({ container }).getAttribute("aria-busy")).toBe("true");
		expect(container.textContent).toContain("chat.resyncBusy");

		act(() => deliver({ type: "ready", sessionId: "chat-1", piSessionId: "pi-1", resumed: true }));

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(resyncButton({ container }).getAttribute("aria-busy")).toBe("false");
		expect(container.textContent).not.toContain("chat.resyncBusy");
	});

	it("is disabled while a run is streaming or compaction is in flight", () => {
		const { deliver } = renderChatPane(root);

		act(() => deliver({ type: "run.started", sessionId: "chat-1" }));
		expect(resyncButton({ container }).disabled).toBe(true);

		act(() => deliver({ type: "run.done", sessionId: "chat-1", reason: "stop" }));
		expect(resyncButton({ container }).disabled).toBe(false);

		act(() => deliver({ type: "compaction.started", sessionId: "chat-1" }));
		expect(resyncButton({ container }).disabled).toBe(true);

		act(() => deliver({ type: "compaction.done", sessionId: "chat-1" }));
		expect(resyncButton({ container }).disabled).toBe(false);
	});

	it("clears the busy state and surfaces the error when history hydration fails terminally", () => {
		const { deliver } = renderChatPane(root);

		act(() => resyncButton({ container }).click());
		expect(resyncButton({ container }).disabled).toBe(true);

		act(() =>
			deliver({
				type: "error",
				sessionId: "chat-1",
				code: "initialize_failed",
				message: "resync failed",
			}),
		);

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(container.textContent).not.toContain("chat.resyncBusy");
		const error = requireElement(
			container.querySelector(".th-chat-error"),
			"surfaced resync failure",
		);
		expect(error.textContent).toBe("resync failed");
	});

	it("falls back to clearing the busy state on the terminal entries frame", () => {
		const { deliver } = renderChatPane(root);

		act(() => resyncButton({ container }).click());
		expect(resyncButton({ container }).disabled).toBe(true);

		act(() =>
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{ type: "message", message: { role: "user", content: "from server", timestamp: 1 } },
				],
				final: true,
			}),
		);

		expect(resyncButton({ container }).disabled).toBe(false);
		expect(container.textContent).not.toContain("chat.resyncBusy");
	});
});
