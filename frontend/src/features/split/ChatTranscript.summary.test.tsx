import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ChatTranscript } from "./ChatTranscript";
import { parseEntries } from "./chatEntries";
import { mergeTranscriptItems } from "./useChatFrameState";
import type { ToolEntry } from "./chatSessionTypes";

const baseProps = {
	thinking: "",
	toolCalls: {} as Readonly<Record<string, ToolEntry>>,
	doneReason: null,
	error: "",
	restoreVersion: 0,
	focused: true,
	historyLoaded: true,
};

/**
 * Hydrated branch/compaction summary entries must reach the same SummaryBox
 * presentation as the live notice variant: a bold bracket label, the summary
 * folded to its first line behind an expand toggle, and the compaction token
 * count visible in both states. These tests mount the real ChatTranscript
 * (real parser, real merge, real virtualizer) so parser-only coverage cannot
 * mask a missing renderer branch.
 */
describe("ChatTranscript hydrated summary boxes", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.clearAllMocks();
	});

	function renderEntries(entries: readonly unknown[]) {
		const items = mergeTranscriptItems(parseEntries(entries), []);
		act(() => root.render(<ChatTranscript {...baseProps} items={items} streaming="" />));
	}

	it("renders a hydrated branch summary as a labeled [branch] box with an expand toggle", () => {
		renderEntries([
			{ type: "message", id: "b1", message: { role: "branchSummary", content: { summary: "Branched context\nSecond line of the branch summary" }, timestamp: 5000 } },
		]);
		const box = container.querySelector(".th-chat-notice");
		expect(box).not.toBeNull();
		expect(box?.getAttribute("role")).toBe("status");
		expect(box?.querySelector(".th-notice-title")?.textContent).toBe("[branch]");
		// Collapsed: first line visible, remainder folded behind the toggle.
		const toggle = box?.querySelector<HTMLButtonElement>(".th-notice-summary-toggle");
		expect(toggle).not.toBeNull();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(toggle?.textContent).toContain("Branched context");
		expect(box?.textContent).not.toContain("Second line of the branch summary");
		act(() => toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(box?.querySelector(".th-notice-summary-full")?.textContent).toBe("Branched context\nSecond line of the branch summary");
	});

	it("renders a hydrated compaction summary as a [compaction] box with tokens always visible", () => {
		renderEntries([
			{ type: "message", id: "c1", message: { role: "compactionSummary", content: { tokens: 42100, summary: "Kept the plan.\nFull payload line two" }, timestamp: 7000 } },
		]);
		const box = container.querySelector(".th-chat-notice");
		expect(box).not.toBeNull();
		expect(box?.querySelector(".th-notice-title")?.textContent).toBe("[compaction]");
		// Tokens are their own always-visible line, not folded into the summary.
		expect(box?.querySelector(".th-notice-summary-tokens")?.textContent).toBe("42100 tokens");
		const toggle = box?.querySelector<HTMLButtonElement>(".th-notice-summary-toggle");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(box?.textContent).not.toContain("Full payload line two");
		act(() => toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(box?.querySelector(".th-notice-summary-full")?.textContent).toBe("Kept the plan.\nFull payload line two");
		expect(box?.querySelector(".th-notice-summary-tokens")?.textContent).toBe("42100 tokens");
	});

	it("renders persisted compaction and branch_summary entries as labeled boxes through the real parser", () => {
		// Observed engine behavior/contract: persisted summary entries arrive
		// in hydrated history with their own entry types, not as messages.
		renderEntries([
			{ type: "branch_summary", id: "branch-entry", parentId: null, timestamp: "2026-09-14T12:00:00.000Z", summary: "RAW_BRANCH_FIRST\nRAW_BRANCH_REST" },
			{ type: "compaction", id: "compaction-entry", parentId: "branch-entry", timestamp: "2026-09-14T12:00:01.000Z", tokensBefore: 42100, summary: "RAW_COMPACT_FIRST\nRAW_COMPACT_REST" },
			{ type: "message", id: "control", parentId: "compaction-entry", message: { role: "user", content: "VISIBLE_CONTROL", timestamp: 1789387202000 } },
		]);
		const titles = [...container.querySelectorAll(".th-notice-title")].map((el) => el.textContent);
		expect(titles).toEqual(["[branch]", "[compaction]"]);
		expect(container.textContent).toContain("VISIBLE_CONTROL");
		const boxes = [...container.querySelectorAll(".th-chat-notice")];
		expect(boxes).toHaveLength(2);
		expect(boxes.every((box) => box.getAttribute("role") === "status")).toBe(true);
		// Observed engine behavior/contract: transcript rows carry no timestamps.
		expect(container.querySelector(".th-notice-time")).toBeNull();
		expect(container.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);

		// Branch box: collapsed to the first line, expands to the exact text.
		const branchToggle = boxes[0]?.querySelector<HTMLButtonElement>(".th-notice-summary-toggle");
		expect(branchToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(branchToggle?.textContent).toContain("RAW_BRANCH_FIRST");
		expect(boxes[0]?.textContent).not.toContain("RAW_BRANCH_REST");
		act(() => branchToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(boxes[0]?.querySelector(".th-notice-summary-full")?.textContent).toBe("RAW_BRANCH_FIRST\nRAW_BRANCH_REST");

		// Compaction box: tokens visible in both states, exact text on expand.
		expect(boxes[1]?.querySelector(".th-notice-summary-tokens")?.textContent).toBe("42100 tokens");
		const compactToggle = boxes[1]?.querySelector<HTMLButtonElement>(".th-notice-summary-toggle");
		expect(compactToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(boxes[1]?.textContent).not.toContain("RAW_COMPACT_REST");
		act(() => compactToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(boxes[1]?.querySelector(".th-notice-summary-full")?.textContent).toBe("RAW_COMPACT_FIRST\nRAW_COMPACT_REST");
		expect(boxes[1]?.querySelector(".th-notice-summary-tokens")?.textContent).toBe("42100 tokens");
		// Summary rows never divert into the HookCard branch.
		expect(container.querySelector(".th-hook")).toBeNull();
	});

	it("shows a zero token count on a persisted compaction entry in both states", () => {
		renderEntries([
			{ type: "compaction", id: "comp-zero", timestamp: "2026-09-14T12:00:01.000Z", tokensBefore: 0, summary: "Nothing dropped.\nSecond line" },
		]);
		const box = container.querySelector(".th-chat-notice");
		expect(box?.querySelector(".th-notice-summary-tokens")?.textContent).toBe("0 tokens");
		const toggle = box?.querySelector<HTMLButtonElement>(".th-notice-summary-toggle");
		act(() => toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(box?.querySelector(".th-notice-summary-full")?.textContent).toBe("Nothing dropped.\nSecond line");
		expect(box?.querySelector(".th-notice-summary-tokens")?.textContent).toBe("0 tokens");
	});

	it("renders hydrated custom_message summary entries as the same labeled boxes", () => {
		renderEntries([
			{ type: "custom_message", id: "b2", customType: "branchSummary", content: "Branched from earlier session" },
			{ type: "custom_message", id: "c2", customType: "compaction_summary", content: "Compacted the earlier turns." },
		]);
		const titles = [...container.querySelectorAll(".th-notice-title")].map((el) => el.textContent);
		expect(titles).toEqual(["[branch]", "[compaction]"]);
		// Single-line summaries render without a toggle, text fully visible.
		const boxes = [...container.querySelectorAll(".th-chat-notice")];
		expect(boxes[0]?.textContent).toContain("Branched from earlier session");
		expect(boxes[1]?.textContent).toContain("Compacted the earlier turns.");
		// Summary rows never divert into the HookCard branch.
		expect(container.querySelector(".th-hook")).toBeNull();
	});
});
