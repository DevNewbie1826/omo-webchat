import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderedTexts: string[] = [];
vi.mock("react-markdown", () => ({
	default: ({ children }: { readonly children: string }) => {
		renderedTexts.push(children);
		return <div data-testid="md">{children}</div>;
	},
}));

import { ChatTranscript } from "./ChatTranscript";
import { mergeTranscriptItems } from "./useChatFrameState";
import type { UiMessage } from "./chatEntries";
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

describe("ChatTranscript streaming memoization", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		renderedTexts.length = 0;
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
		vi.clearAllMocks();
	});

	it("does not re-parse settled assistant markdown when only the streaming text changes", () => {
		const settled: UiMessage = { role: "assistant", blocks: [{ kind: "text", text: "# settled heading" }] };
		act(() =>
			root.render(<ChatTranscript {...baseProps} items={mergeTranscriptItems([settled], [])} streaming="" />),
		);
		expect(renderedTexts.filter((t) => t === "# settled heading")).toHaveLength(1);

		act(() =>
			root.render(<ChatTranscript {...baseProps} items={mergeTranscriptItems([settled], [])} streaming="incoming chunk" />),
		);
		expect(renderedTexts.filter((t) => t === "# settled heading")).toHaveLength(1);
		expect(renderedTexts).toContain("incoming chunk");
	});
});
