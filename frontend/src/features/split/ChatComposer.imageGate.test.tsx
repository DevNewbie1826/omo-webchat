import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ChatComposer } from "./ChatComposer";
import { i18n } from "./chatPaneTestHarness";

function render(root: Root, imageSupported: boolean, retryImage = false): void {
	act(() => {
		root.render(
			<I18nContext.Provider value={i18n}>
				<ChatComposer
					commands={[]}
					running={false}
					isCompacting={false}
					retryDraft={retryImage ? { version: 1, text: "", image: { data: "YWJj", mimeType: "image/png", name: "p.png" } } : null}
					onSubmit={() => true}
					onSteer={() => undefined}
					onStop={() => undefined}
					provider="omo"
					cwd="/tmp"
					imageSupported={imageSupported}
				/>
			</I18nContext.Provider>,
		);
	});
}

describe("ChatComposer image gating by model capability", () => {
	let root: Root;
	let container: HTMLDivElement;

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

	it("disables the attach button and labels it when the model lacks image support", () => {
		render(root, false);
		const attach = container.querySelector<HTMLButtonElement>(".th-chat-attach-btn");
		if (!attach) throw new Error("missing attach button");
		expect(attach.disabled).toBe(true);
		expect(attach.getAttribute("aria-label")).toBe("chat.attachUnsupported");
		expect(container.querySelector(".th-chat-attach-wrap")?.getAttribute("title")).toBe("chat.attachUnsupported");
	});

	it("keeps the attach button enabled for an image-capable model", () => {
		render(root, true);
		const attach = container.querySelector<HTMLButtonElement>(".th-chat-attach-btn");
		if (!attach) throw new Error("missing attach button");
		expect(attach.disabled).toBe(false);
		expect(attach.getAttribute("aria-label")).toBe("chat.attach");
	});

	it("drops a restored image when the model does not support images", () => {
		render(root, false, true);
		expect(container.querySelector(".th-chat-attach-chip")).toBeNull();
	});
});
