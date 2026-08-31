import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { ChatDraft } from "./chatSessionTypes";
import { ChatComposer } from "./ChatComposer";
import { i18n, requireElement, setTextareaValue } from "./chatPaneTestHarness";

function enter(textarea: HTMLTextAreaElement, init: KeyboardEventInit): void {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("ChatComposer queue / steer / stop", () => {
	let root: Root;
	let container: HTMLDivElement;
	let submitted: ChatDraft[];
	let steered: string[];
	let stopped: boolean[];

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		submitted = [];
		steered = [];
		stopped = [];
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	function render(running: boolean, isCompacting = false): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatComposer
						commands={[]}
						running={running}
						isCompacting={isCompacting}
						retryDraft={null}
						onSubmit={(draft) => {
							submitted.push(draft);
							return true;
						}}
						onSteer={(text) => steered.push(text)}
						onStop={() => stopped.push(true)}
						provider="omo"
						cwd="/tmp"
					/>
				</I18nContext.Provider>,
			);
		});
	}

	it("queues a message while running and flushes it when the run ends", () => {
		render(true);
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => setTextareaValue(textarea, "follow up"));
		act(() => enter(textarea, { key: "Enter" }));

		expect(submitted).toEqual([]);
		expect(container.querySelector(".th-chat-queued")?.textContent).toContain("follow up");
		expect(textarea.value).toBe("");

		render(false);
		expect(submitted).toEqual([{ text: "follow up", image: null }]);
		expect(container.querySelector(".th-chat-queued")).toBeNull();
	});

	it("steers on Cmd+Enter while running and does not submit", () => {
		render(true);
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => setTextareaValue(textarea, "also do X"));
		act(() => enter(textarea, { key: "Enter", metaKey: true }));

		expect(steered).toEqual(["also do X"]);
		expect(submitted).toEqual([]);
	});

	it("stops the run on Escape when the palette is closed", () => {
		render(true);
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => enter(textarea, { key: "Escape" }));
		expect(stopped).toEqual([true]);
	});

	it("holds a queued draft through compaction and flushes it afterward", () => {
		render(true);
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("missing textarea");
		act(() => setTextareaValue(textarea, "after compact"));
		act(() => enter(textarea, { key: "Enter" }));

		render(false, true);
		expect(submitted).toEqual([]);
		expect(container.querySelector(".th-chat-queued")?.textContent).toContain("after compact");

		render(false, false);
		expect(submitted).toEqual([{ text: "after compact", image: null }]);
		expect(container.querySelector(".th-chat-queued")).toBeNull();
	});

	it("disables and gates the composer during compaction", () => {
		render(false, true);
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		const send = container.querySelector<HTMLButtonElement>(".th-chat-send-btn");
		const form = container.querySelector<HTMLFormElement>("form");
		if (!textarea || !send || !form) throw new Error("missing composer controls");
		expect(textarea.disabled).toBe(true);
		expect(send.disabled).toBe(true);
		act(() => setTextareaValue(textarea, "blocked"));
		act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		expect(submitted).toEqual([]);
		expect(container.querySelector(".th-chat-queued")).toBeNull();
		expect(textarea.value).toBe("blocked");
	});

	it("keeps one stable action slot: the same slot becomes Stop while running and Send otherwise", () => {
		render(true);
		// One slot, one button: Send must not coexist with a second Stop button.
		expect(container.querySelectorAll(".th-chat-input-inner > button.th-btn")).toHaveLength(1);
		const stop = requireElement(
			container.querySelector<HTMLButtonElement>(".th-chat-send-btn"),
			"missing slot button while running",
		);
		expect(stop.type).toBe("button");
		expect(stop.classList.contains("th-btn--danger")).toBe(true);
		expect(stop.textContent).toBe("chat.stop");
		act(() => {
			stop.click();
		});
		expect(stopped).toEqual([true]);
		expect(submitted).toEqual([]);

		render(false);
		expect(container.querySelectorAll(".th-chat-input-inner > button.th-btn")).toHaveLength(1);
		const send = requireElement(
			container.querySelector<HTMLButtonElement>(".th-chat-send-btn"),
			"missing slot button while idle",
		);
		expect(send.type).toBe("submit");
		expect(send.classList.contains("th-btn--danger")).toBe(false);
		expect(send.textContent).toBe("chat.send");
	});
});
