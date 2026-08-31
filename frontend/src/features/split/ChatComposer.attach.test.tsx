import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ChatComposer } from "./ChatComposer";
import { i18n, requireElement } from "./chatPaneTestHarness";

describe("ChatComposer unified capsule controls", () => {
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

	function renderComposer(running: boolean): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
				<ChatComposer
					commands={[]}
					running={running}
					isCompacting={false}
					retryDraft={null}
					onSubmit={() => true}
					onSteer={() => undefined}
					onStop={() => undefined}
					provider="omo"
					cwd="/tmp"
				/>
				</I18nContext.Provider>,
			);
		});
	}

	it("opens attachment picking through an icon-only plus action", () => {
		renderComposer(false);
		const attach = requireElement(
			container.querySelector<HTMLButtonElement>(".th-chat-attach-btn"),
			"missing attach action",
		);
		expect(attach.getAttribute("aria-label")).toBe("chat.attach");
		const input = requireElement(
			container.querySelector<HTMLInputElement>('input[type="file"]'),
			"missing file input",
		);
		const openPicker = vi.spyOn(input, "click");
		act(() => attach.click());
		expect(openPicker).toHaveBeenCalledOnce();
		const glyph = requireElement(
			attach.querySelector<SVGPathElement>("svg path"),
			"missing plus glyph",
		);
		expect(glyph.getAttribute("d")).toBe("M12 5v14M5 12h14");
	});

	it("keeps the send slot icon-only: arrow glyph plus a screen-reader label", () => {
		renderComposer(false);
		const send = requireElement(
			container.querySelector<HTMLButtonElement>(".th-chat-send-btn"),
			"missing send button",
		);
		const glyphs = Array.from(
			send.querySelectorAll("path"),
			(path) => path.getAttribute("d"),
		);
		expect(glyphs).toEqual(["m5 12 7-7 7 7", "M12 19V5"]);
		const label = requireElement(
			send.querySelector<HTMLElement>(".th-chat-send-label"),
			"missing screen-reader label",
		);
		expect(label.textContent).toBe("chat.send");
		expect(send.textContent).toBe("chat.send");
	});

	it("swaps the same slot to a stop glyph while running", () => {
		renderComposer(true);
		const stop = requireElement(
			container.querySelector<HTMLButtonElement>(".th-chat-send-btn"),
			"missing stop button",
		);
		const glyphs = Array.from(
			stop.querySelectorAll("path"),
			(path) => path.getAttribute("d"),
		);
		expect(glyphs).toEqual(["M18 6 6 18M6 6l12 12"]);
		expect(stop.textContent).toBe("chat.stop");
		expect(stop.className).toContain("th-btn--danger");
	});
});

describe("ChatComposer attachment chip", () => {
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

	it("places a picked attachment chip outside the input inner", async () => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatComposer
						commands={[]}
						running={false}
						isCompacting={false}
						retryDraft={null}
						onSubmit={() => true}
						onSteer={() => undefined}
						onStop={() => undefined}
						provider="omo"
						cwd="/tmp"
					/>
				</I18nContext.Provider>,
			);
		});

		const input = requireElement(
			container.querySelector<HTMLInputElement>('input[type="file"]'),
			"missing file input",
		);
		const chipInserted = new Promise<void>((resolve) => {
			const observer = new MutationObserver(() => {
				if (container.querySelector(".th-chat-attach-chip")) {
					observer.disconnect();
					resolve();
				}
			});
			observer.observe(container, { childList: true, subtree: true });
		});
		const file = new File(["image data"], "picked.png", { type: "image/png" });
		Object.defineProperty(input, "files", { configurable: true, value: [file] });
		act(() => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await chipInserted;

		const chip = requireElement(
			container.querySelector<HTMLElement>(".th-chat-attach-chip"),
			"missing attachment chip",
		);
		const inner = requireElement(
			container.querySelector<HTMLElement>(".th-chat-input-inner"),
			"missing input inner",
		);
		expect(inner.contains(chip)).toBe(false);
	});

	it("renders a thumbnail chip for a restored image and removes it", () => {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<ChatComposer
						commands={[]}
						running={false}
						isCompacting={false}
						retryDraft={{
							version: 1,
							text: "",
							image: {
								data: "YWJj",
								mimeType: "image/png",
								name: "photo.png",
							},
						}}
						onSubmit={() => true}
						onSteer={() => undefined}
						onStop={() => undefined}
						provider="omo"
						cwd="/tmp"
					/>
				</I18nContext.Provider>,
			);
		});

		const chip = requireElement(
			container.querySelector<HTMLElement>(".th-chat-attach-chip"),
			"missing attachment chip",
		);
		const thumbnail = requireElement(
			chip.querySelector<HTMLImageElement>("img"),
			"missing attachment thumbnail",
		);
		expect(thumbnail.src).toBe("data:image/png;base64,YWJj");
		expect(chip.textContent).toContain("photo.png");

		const remove = requireElement(
			chip.querySelector<HTMLButtonElement>(
				'button[aria-label="chat.removeAttach"]',
			),
			"missing remove attachment button",
		);
		act(() => remove.click());
		expect(container.querySelector(".th-chat-attach-chip")).toBeNull();
	});
});
