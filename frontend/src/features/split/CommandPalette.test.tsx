import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate } from "../../i18n";
import type { I18nValue, Lang } from "../../i18n";
import type { CommandEntry } from "../../lib/chatWs";
import { COMPACT_COMMAND } from "./curatedCommands";
import { CommandPalette } from "./CommandPalette";
import { requireElement } from "./chatPaneTestHarness";

const PROVIDER_COMMAND: CommandEntry = {
	name: "fix-tests",
	description: "Fix failing tests",
	source: "extension",
	syntax: "slash",
};

function localized(lang: Lang): I18nValue {
	return {
		lang,
		setLang: () => undefined,
		font: "system",
		setFont: () => undefined,
		fontSize: 13,
		setFontSize: () => undefined,
		t: (key, vars) => translate(lang, key, vars),
	};
}

function optionText(container: HTMLElement, rendered: string): string {
	const option = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
		(el) => el.querySelector("strong")?.textContent === rendered,
	);
	if (!option) throw new Error(`missing option ${rendered}`);
	return option.textContent ?? "";
}

describe("CommandPalette curated description localization", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	function render(lang: Lang): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={localized(lang)}>
					<CommandPalette
						id="test-listbox"
						optionIdPrefix="test-option"
						commands={[PROVIDER_COMMAND, COMPACT_COMMAND]}
						activeIndex={-1}
						onActiveIndex={() => undefined}
					onSelect={() => undefined}
						hintNavigate={translate(lang, "chat.composer.paletteHintNavigate")}
						hintSelect={translate(lang, "chat.composer.paletteHintSelect")}
						hintClose={translate(lang, "chat.composer.paletteHintClose")}
					/>
				</I18nContext.Provider>,
			);
		});
	}

	it("renders the curated compact description from the en locale table", () => {
		render("en");
		expect(optionText(container, "/compact")).toContain(translate("en", "chat.compactDescription"));
	});

	it("renders the curated compact description from the ko locale table", () => {
		render("ko");
		expect(optionText(container, "/compact")).toContain(translate("ko", "chat.compactDescription"));
	});

	it("never translates provider-advertised descriptions", () => {
		render("ko");
		expect(optionText(container, "/fix-tests")).toContain("Fix failing tests");
	});

	it("renders the keyboard hint row with styled key chips before the options", () => {
		render("en");
		const listbox = requireElement(
			container.querySelector<HTMLElement>('[role="listbox"]'),
			"missing listbox",
		);
		const hints = requireElement(
			listbox.querySelector<HTMLElement>(":scope > .th-chat-slash-hints"),
			"missing palette hint row",
		);
		// The hint row leads the panel, ahead of every option.
		expect(hints.nextElementSibling?.getAttribute("role")).toBe("option");
		const keys = Array.from(hints.querySelectorAll("kbd"), (kbd: HTMLElement) => kbd.textContent);
		expect(keys).toEqual(["↑", "↓", "↵", "esc"]);
		expect(hints.textContent).toContain(translate("en", "chat.composer.paletteHintNavigate"));
		expect(hints.textContent).toContain(translate("en", "chat.composer.paletteHintSelect"));
		expect(hints.textContent).toContain(translate("en", "chat.composer.paletteHintClose"));
	});

	it("localizes the keyboard hint row copy", () => {
		render("ko");
		const hints = requireElement(
			container.querySelector<HTMLElement>(".th-chat-slash-hints"),
			"missing palette hint row",
		);
		expect(hints.textContent).toContain(translate("ko", "chat.composer.paletteHintNavigate"));
		expect(hints.textContent).toContain(translate("ko", "chat.composer.paletteHintSelect"));
		expect(hints.textContent).toContain(translate("ko", "chat.composer.paletteHintClose"));
	});
});
