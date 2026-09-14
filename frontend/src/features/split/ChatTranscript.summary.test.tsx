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
