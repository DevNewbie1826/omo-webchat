import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatPane } from "./ChatPane";
import { chatSession, i18n, renderChatPane } from "./chatPaneTestHarness";

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
					// Observed persisted branch_summary envelope shape
					// (r-contract-notes.md): ISO timestamp, fromId, no tokensBefore.
					{
						type: "branch_summary",
						id: "b1",
						parentId: "b0",
						timestamp: "2026-01-02T03:05:12.000Z",
						fromId: "a9",
						summary: "Branch recap text",
						details: { readFiles: [], modifiedFiles: [] },
						fromHook: false,
					},
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

	it("keeps display:true custom messages named compaction or branch_summary on the HookCard path", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [
					{ type: "custom_message", id: "x1", customType: "compaction", display: true, content: "CUSTOM_COMPACTION_SENTINEL" },
					{ type: "custom_message", id: "x2", customType: "branch_summary", display: true, content: "CUSTOM_BRANCH_SENTINEL" },
				],
				final: true,
			});
		});
		const hooks = container.querySelectorAll(".th-chat-history .th-hook");
		expect(hooks).toHaveLength(2);
		expect(container.querySelector(".th-chat-history .th-chat-notice")).toBeNull();
		expect(container.textContent).toContain("CUSTOM_COMPACTION_SENTINEL");
		expect(container.textContent).toContain("CUSTOM_BRANCH_SENTINEL");
	});

	it("keeps a stable time on a summary box with a valid epoch-zero timestamp", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [{ type: "compaction", id: "zero", timestamp: 0, summary: "ZERO_TIMESTAMP_SENTINEL" }],
				final: true,
			});
		});
		const box = container.querySelector(".th-chat-history .th-chat-notice");
		expect(box).not.toBeNull();
		expect(box?.querySelector(".th-notice-time")?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	it("renders valid stable fallback times for finite out-of-Date-range numeric timestamps", () => {
		vi.useFakeTimers();
		try {
			const receipt = 1_800_000_000_000;
			vi.setSystemTime(receipt);
			let deliver: ((frame: ChatServerFrame) => void) | undefined;
			const connect: ChatConnector = (handlers) => {
				deliver = handlers.onFrame;
				handlers.onOpen?.();
				return { send: () => true, close: () => undefined };
			};
			const element = (
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
				</I18nContext.Provider>
			);
			act(() => {
				root.render(element);
			});
			act(() => {
				deliver?.({
					type: "entries",
					sessionId: "chat-1",
					entries: [
						{ type: "compaction", id: "over", timestamp: 8640000000000001, summary: "OVERFLOW_POS_SENTINEL" },
						{ type: "branch_summary", id: "under", timestamp: -8640000000000001, summary: "OVERFLOW_NEG_SENTINEL" },
					],
					final: true,
				});
			});
			const readTimes = () =>
				[...container.querySelectorAll(".th-chat-history .th-chat-notice")].map(
					(box) => box.querySelector(".th-notice-time")?.textContent,
				);
			const pad = (value: number): string => String(value).padStart(2, "0");
			const receiptDate = new Date(receipt);
			const expected = `${pad(receiptDate.getHours())}:${pad(receiptDate.getMinutes())}:${pad(receiptDate.getSeconds())}`;
			const first = readTimes();
			expect(first).toEqual([expected, expected]);
			// Advance the controlled clock and re-render the same hydrated state:
			// the frozen receipt times must not move.
			vi.setSystemTime(receipt + 91_000);
			act(() => {
				root.render(element);
			});
			expect(readTimes()).toEqual(first);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a stable hydration receipt time on a summary box whose entry has no timestamp", () => {
		const { deliver } = renderChatPane(root);
		act(() => {
			deliver({
				type: "entries",
				sessionId: "chat-1",
				entries: [{ type: "branch_summary", id: "missing", summary: "MISSING_TIMESTAMP_SENTINEL" }],
				final: true,
			});
		});
		const box = container.querySelector(".th-chat-history .th-chat-notice");
		expect(box).not.toBeNull();
		const time = box?.querySelector(".th-notice-time")?.textContent;
		expect(time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});
});
