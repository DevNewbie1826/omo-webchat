import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import en from "../../i18n/locales/en.json";
import ko from "../../i18n/locales/ko.json";
import { ChatTranscript } from "./ChatTranscript";
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

const user: UiMessage = { role: "user", blocks: [{ kind: "text", text: "fix the flake" }], ts: 0 };
const assistant: UiMessage = { role: "assistant", blocks: [{ kind: "text", text: "on it" }], ts: 1 };

/**
 * Authorship between user and assistant messages must never flatten back into
 * two identical rows of text. The channels pinned here:
 * - the DOM hook `.th-chat-msg--user` that the transcript CSS keys on;
 * - the Raised fill triple in chat-transcript.css: the user bubble separates
 *   from the canvas by its own surface, not by an accent bar or bold text
 *   (the full elevation triple is separately pinned by styleContracts);
 * - the localized accessible group label, declared in BOTH locales.
 */
describe("ChatTranscript authorship distinction", () => {
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

	it("renders user messages on the th-chat-msg--user hook the stylesheet keys on", () => {
		act(() => root.render(<ChatTranscript {...baseProps} messages={[user, assistant]} streaming="" />));
		const userMsg = container.querySelector(".th-chat-msg--user");
		expect(userMsg).not.toBeNull();
		expect(userMsg?.className).toBe("th-chat-msg th-chat-msg--user");
		expect(container.querySelector(".th-chat-msg--assistant")).not.toBeNull();
	});

	it("announces authorship to assistive tech on user messages only", () => {
		act(() => root.render(<ChatTranscript {...baseProps} messages={[user, assistant]} streaming="" />));
		const userMsg = container.querySelector(".th-chat-msg--user");
		expect(userMsg?.getAttribute("role")).toBe("group");
		expect(userMsg?.getAttribute("aria-label")).toBe("chat.fromUser");
		expect(container.querySelector(".th-chat-msg--assistant")?.hasAttribute("aria-label")).toBe(false);
		expect(container.querySelector(".th-chat-sr-author")).toBeNull();
	});

	it("separates the user bubble by its Raised surface, without accent bar or emphasized prose", () => {
		const css = readFileSync("src/styles/chat-transcript.css", "utf8");
		const body = css.match(/\.th-chat-msg--user\s*\{([^}]*)\}/)?.[1] ?? "";
		// Authorship is carried by the bubble's own elevated fill, right
		// alignment, and the accessible label — not by decoration.
		expect(body).not.toContain("border-inline-start");
		expect(body).not.toContain("font-weight");
		expect(body).toContain("background: var(--th-surface-user)");
		expect(body).toContain("var(--th-border-user)");
		// Message prose is declared at the read weight so the user and assistant
	// rows share one reading rhythm.
		const base = css.match(/\.th-chat-msg\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(base).toContain("font-weight: var(--th-weight-read)");
	});

	it("keeps the copyable user text free of the authorship label", () => {
		act(() => root.render(<ChatTranscript {...baseProps} messages={[user]} streaming="" />));
		expect(container.querySelector(".th-chat-msg--user")?.textContent).toBe("fix the flake");
	});

	it("declares the author label in both locales", () => {
		expect(en["chat.fromUser"].length).toBeGreaterThan(0);
		expect(ko["chat.fromUser"].length).toBeGreaterThan(0);
	});
});
