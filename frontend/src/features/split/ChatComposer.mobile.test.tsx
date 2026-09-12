import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ChatComposer } from "./ChatComposer";
import { i18n, setTextareaValue } from "./chatPaneTestHarness";

const NARROW_QUERY = "(max-width: 768px)";
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

function mockMatchMedia(matching: readonly string[]): void {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: matching.includes(query),
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	}));
}

describe("ChatComposer mobile Enter behavior", () => {
	let root: Root;
	let container: HTMLDivElement;
	let submitted: number;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		submitted = 0;
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	function render(): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatComposer
						commands={[]}
						running={false}
						isCompacting={false}
						retryDraft={null}
						onSubmit={() => {
							submitted += 1;
							return true;
						}}
						onSteer={() => true}
						onStop={() => undefined}
						provider="omo"
						cwd="/tmp"
					/>
				</I18nContext.Provider>,
			);
		});
	}

	it("does not submit on Enter on a touch device (Enter becomes a newline)", () => {
		mockMatchMedia([NARROW_QUERY, TOUCH_QUERY]);
		render();
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => setTextareaValue(textarea, "line one"));
		act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(submitted).toBe(0);
	});

	it("submits on Enter in a narrow desktop window (viewport width is not a keyboard signal)", () => {
		mockMatchMedia([NARROW_QUERY]);
		render();
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => setTextareaValue(textarea, "line one"));
		act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(submitted).toBe(1);
	});

	it("submits on Enter on desktop", () => {
		mockMatchMedia([]);
		render();
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => setTextareaValue(textarea, "line one"));
		act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(submitted).toBe(1);
	});
});

describe("ChatComposer capsule geometry contracts", () => {
	// Strip comments so anchored rule matching is robust to explanatory prose.
	const stripComments = (raw: string): string => raw.replace(/\/\*[\s\S]*?\*\//g, "");
	const css = stripComments(readFileSync("src/styles/chat-composer.css", "utf8"));
	const tokens = stripComments(readFileSync("src/styles/tokens.css", "utf8"));

	it("builds the composer as a bounded 26px-radius capsule", () => {
		const capsule = css.match(/(?:^|\})\s*\.th-chat-input-inner\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(capsule).toMatch(/border:\s*1px solid var\(--th-border\)/);
		expect(capsule).toMatch(/border-radius:\s*26px/);
		expect(capsule).toMatch(/background:\s*var\(--th-surface-composer\)/);
	});

	it("keeps send/stop one fixed circular slot driven by send tokens", () => {
		const send = css.match(/(?:^|\})\s*\.th-chat-input \.th-chat-send-btn\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(send).toMatch(/width:\s*36px/);
		expect(send).toMatch(/height:\s*36px/);
		expect(send).toMatch(/border-radius:\s*50%/);
		expect(send).toMatch(/background:\s*var\(--th-send\)/);
		expect(send).toMatch(/color:\s*var\(--th-send-fg\)/);
		expect(tokens).toMatch(/--th-send:/);
		expect(tokens).toMatch(/--th-send-hover:/);
		// The send fill lives only in tokens, never in component CSS.
		expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	it("keeps the icon-only label visible to screen readers only", () => {
		const label = css.match(/(?:^|\})\s*\.th-chat-send-label\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(label).toMatch(/position:\s*absolute/);
		expect(label).toMatch(/clip-path:\s*inset\(50%\)/);
	});

	it("guarantees 44px touch targets for plus and send on narrow panes", () => {
		const narrow = css.match(/@container chat-pane \(max-width: 420px\) \{([\s\S]+)\}\s*$/)?.[1] ?? "";
		expect(narrow).toMatch(
			/\.th-chat-attach-btn,\s*\.th-chat-input \.th-chat-send-btn\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/,
		);
		expect(narrow).toMatch(/\.th-chat-input textarea\s*\{[^}]*min-height:\s*44px/);
	});

	it("keeps textarea multiline growth capped at 160px inside the capsule", () => {
		const textarea = css.match(/(?:^|\})\s*\.th-chat-input textarea\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(textarea).toMatch(/min-height:\s*36px/);
		expect(textarea).toMatch(/max-height:\s*min\(160px,\s*max\(44px,\s*calc\(100cqh - 200px\)\)\)/);
	});
});
