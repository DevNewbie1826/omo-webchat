import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatPane } from "./chatPaneTestHarness";

// Hydrated history entries (observed engine behavior/contract): compaction
// summaries persist as session entries of type "compaction", branch summaries
// as type "branch_summary"; both resurface during history hydration.
describe("ChatPane hydrated summary entries", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

	it("renders a persisted compaction entry as the [compaction] summary box", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{ type: "message", id: "m1", message: { role: "user", content: "before" } },
					{
						type: "compaction",
						id: "c1",
						timestamp: "2026-01-02T03:04:05.000Z",
						summary: "Hydrated compaction summary.\nWith a second line.",
						tokensBefore: 48213,
					},
				],
				final: true,
			});
		});
		const box = container.querySelector(".th-chat-history .th-chat-notice.th-alert--info");
		expect(box).not.toBeNull();
		expect(box?.querySelector(".th-notice-title")?.textContent).toBe("[compaction]");
		expect(box?.textContent).toContain("48213");
		expect(box?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		const details = box?.querySelector("details");
		expect(details).not.toBeNull();
		expect(details?.hasAttribute("open")).toBe(false);
		expect(details?.querySelector(".th-notice-summary-full")?.textContent)
			.toBe("Hydrated compaction summary.\nWith a second line.");
	});

	it("renders a persisted branch_summary entry as a [branch] labeled box", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{ type: "branch_summary", id: "b1", timestamp: 1735689600000, summary: "Branch recap text" },
				],
				final: true,
			});
		});
		const box = container.querySelector(".th-chat-history .th-chat-notice.th-alert--info");
		expect(box).not.toBeNull();
		expect(box?.querySelector(".th-notice-title")?.textContent).toBe("[branch]");
		expect(box?.textContent).toContain("Branch recap text");
		expect(box?.querySelector("details")).not.toBeNull();
		// No token count is documented for branch summaries: no tokens line.
		expect(box?.textContent).not.toContain("Tokens before");
	});

	it("does not route a hydrated summary entry through the HookCard path", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [{ type: "compaction", id: "c1", summary: "text" }],
				final: true,
			});
		});
		expect(container.querySelector(".th-hook")).toBeNull();
	});
});
