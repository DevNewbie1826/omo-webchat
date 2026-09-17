import { readFileSync } from "node:fs";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalRequest } from "./QuestionWindow";
import { QuestionWindow } from "./QuestionWindow";

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key, vars) =>
		vars === undefined
			? key
			: `${key} ${Object.entries(vars)
					.map(([name, value]) => `${name}=${String(value)}`)
					.join(" ")}`,
};

const REQUEST: ApprovalRequest = {
	id: "ask-viewport",
	method: "question",
	title: "Keyboard bound",
	questions: [
		{
			id: "q1",
			header: "Stack",
			question: "Which stack?",
			multiSelect: true,
			options: [{ label: "Go" }, { label: "TS" }],
		},
		{
			id: "q2",
			header: "Region",
			question: "Which region?",
			options: [{ label: "us-east" }, { label: "eu-west" }],
		},
	],
};

/** The geometry frames the reviewer's keyboard replay exercises: a
 *  visual-viewport-only shrink (iOS-style keyboard) that leaves the layout
 *  viewport at full height, plus the ordinary desktop frame. */
const REPLAYS = [
	{ name: "touch 390x844, visual 524", layoutHeightPx: 844, visualHeightPx: 524, vvWidthPx: 390, vvTopPx: 0, vvLeftPx: 0, keyboardOpen: true },
	{ name: "touch 360x740, visual 420", layoutHeightPx: 740, visualHeightPx: 420, vvWidthPx: 360, vvTopPx: 0, vvLeftPx: 0, keyboardOpen: true },
	{ name: "desktop 1440x900", layoutHeightPx: 900, visualHeightPx: 900, vvWidthPx: 1440, vvTopPx: 0, vvLeftPx: 0, keyboardOpen: false },
] as const;

const PUBLISHED_PROPERTIES = [
	"--th-vh-unit",
	"--th-vv-top",
	"--th-vv-left",
	"--th-vv-width",
] as const;

/** Emulates the parse-time boot script (index.html): it always publishes the
 *  current VISUAL viewport geometry on <html> and flags keyboard-open frames. */
function publishVisualViewport(replay: (typeof REPLAYS)[number]): void {
	const style = document.documentElement.style;
	style.setProperty("--th-vh-unit", `${replay.visualHeightPx * 0.01}px`);
	style.setProperty("--th-vv-top", `${replay.vvTopPx}px`);
	style.setProperty("--th-vv-left", `${replay.vvLeftPx}px`);
	style.setProperty("--th-vv-width", `${replay.vvWidthPx}px`);
	document.documentElement.toggleAttribute("data-th-keyboard-open", replay.keyboardOpen);
}

function clearPublishedViewport(): void {
	const style = document.documentElement.style;
	for (const name of PUBLISHED_PROPERTIES) style.removeProperty(name);
	document.documentElement.removeAttribute("data-th-keyboard-open");
}

/* Static wiring checks read the real stylesheet bytes (the same approach as
 * styleContracts.test.ts): the bound must come from the boot script's
 * published tokens, never from per-component viewport math. */
const modalCss = readFileSync("src/styles/modal-dialog.css", "utf8");
const tokensCss = readFileSync("src/styles/tokens.css", "utf8");

const ruleBody = (css: string, selector: string): string => {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Prose comments carry no declarations; stripping them keeps a leading
	// declaration (preceded by a comment, not a semicolon) visible to
	// declarationValue's (^|;) anchor.
	return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]?.replace(/\/\*[\s\S]*?\*\//g, "") ?? "";
};

const declarationValue = (body: string, property: string): string => {
	const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return body.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;}]*)`, "i"))?.[1]?.trim() ?? "";
};

const substituteVars = (value: string, vars: Record<string, string>): string =>
	value.replace(
		/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
		(_match, name: string, fallback: string | undefined) => vars[name] ?? fallback?.trim() ?? "",
	);

/** The panel bound also subtracts the overlay's spacing-token padding, so
 * resolve --th-space-* from the real tokens.css (the same source
 * styleContracts.test.ts uses). */
const spaceTokenValues = Object.fromEntries(
	Array.from(tokensCss.matchAll(/(--th-space-[\w-]+):\s*([^;]+);/g), (match) => [
		match[1] ?? "",
		(match[2] ?? "").trim(),
	]),
);

/** Evaluates the calc()/var() shapes these declarations use, with viewport
 *  units resolved against the layout viewport (jsdom does not resolve var()
 *  itself, so the test composes the published values with the declared
 *  wiring exactly as a browser's computed style would). */
const evaluateBound = (value: string, vars: Record<string, string>, layoutHeightPx: number): number =>
	Function(
		`"use strict"; return (${substituteVars(value, vars)
			.replace(/(\d+(?:\.\d+)?)d?vh\b/g, (_m, amount: string) => `(${amount} * ${layoutHeightPx} / 100)`)
			.replace(/calc|px/g, "")});`,
	)() as number;

describe("QuestionWindow visual-viewport bound (R1: keyboard-open window stays usable)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<QuestionWindow request={REQUEST} open onCollapse={vi.fn()} onRespond={vi.fn()} />
				</I18nContext.Provider>,
			);
		});
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		clearPublishedViewport();
		vi.unstubAllGlobals();
	});

	const overlay = (): HTMLElement => {
		const element = document.querySelector<HTMLElement>(".th-modal-overlay");
		expect(element, "the window renders through the ModalDialog portal").not.toBeNull();
		return element as HTMLElement;
	};
	const panel = (): HTMLElement => {
		const element = document.querySelector<HTMLElement>(".th-modal");
		expect(element, "the modal surface renders").not.toBeNull();
		return element as HTMLElement;
	};

	it("the portalled window inherits the visual-viewport geometry published on <html> and follows its updates", () => {
		publishVisualViewport(REPLAYS[0]);

		// The whole point of the wiring: the overlay and panel see the boot
		// script's values through pure CSS inheritance — the window carries no
		// viewport measurement code of its own.
		for (const element of [overlay(), panel()]) {
			const computed = getComputedStyle(element);
			expect(computed.getPropertyValue("--th-vv-top").trim()).toBe("0px");
			expect(computed.getPropertyValue("--th-vv-left").trim()).toBe("0px");
			expect(computed.getPropertyValue("--th-vv-width").trim()).toBe("390px");
			expect(computed.getPropertyValue("--th-vh-unit").trim()).toBe("5.24px");
		}

		// A keyboard pan (visual viewport offset) republishes --th-vv-top; the
		// window's subtree must follow the new value, not a mount-time copy.
		document.documentElement.style.setProperty("--th-vv-top", "130px");
		expect(getComputedStyle(overlay()).getPropertyValue("--th-vv-top").trim()).toBe("130px");
	});

	it("positions and sizes the modal surface against the visual viewport, not the layout viewport", () => {
		const overlayRule = ruleBody(modalCss, ".th-modal-overlay");
		expect(declarationValue(overlayRule, "top")).toBe("var(--th-vv-top, 0px)");
		expect(declarationValue(overlayRule, "left")).toBe("var(--th-vv-left, 0px)");
		expect(declarationValue(overlayRule, "width")).toBe("var(--th-vv-width, 100%)");
		expect(declarationValue(overlayRule, "height")).toBe("calc(var(--th-vh-unit, 1vh) * 100)");
		// No layout-viewport inset may remain: inset: 0 is exactly what parked
		// the answer input and the actions row under the keyboard.
		expect(declarationValue(overlayRule, "inset")).toBe("");
		expect(declarationValue(overlayRule, "bottom")).toBe("");
		expect(declarationValue(overlayRule, "right")).toBe("");

		const maxHeight = declarationValue(ruleBody(modalCss, ".th-modal"), "max-height");
		expect(maxHeight).toContain("var(--th-vh-unit");
		// No viewport unit may size the panel directly (the former 100dvh);
		// the 1dvh inside the var() fallback is only the no-boot-script
		// fallback, the same resilience pattern as chat-pane.css.
		expect(maxHeight.replace(/var\([^)]*\)/g, "")).not.toContain("vh");
	});

	it.each(REPLAYS.map((replay) => [replay.name, replay] as const))(
		"the computed bound stays inside the visible region at %s",
		(_name, replay) => {
			publishVisualViewport(replay);
			const vars = {
				...spaceTokenValues,
				...Object.fromEntries(
					PUBLISHED_PROPERTIES.map((name) => [
						name,
						getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
					]),
				),
			};

			const overlayRule = ruleBody(modalCss, ".th-modal-overlay");
			const heightDecl = declarationValue(overlayRule, "height");
			expect(heightDecl, "the overlay height must be wired to the published geometry").not.toBe("");
			const overlayHeight = evaluateBound(heightDecl, vars, replay.layoutHeightPx);
			expect(overlayHeight).toBe(replay.visualHeightPx);

			const topDecl = declarationValue(overlayRule, "top");
			const overlayTop = topDecl === "" ? 0 : evaluateBound(topDecl, vars, replay.layoutHeightPx);
			// The surface's bottom edge is its pan offset plus its height: it
			// must never extend past the visible bottom (524 / 420 / 900).
			expect(overlayTop + overlayHeight).toBeLessThanOrEqual(replay.visualHeightPx);

			const maxHeightDecl = declarationValue(ruleBody(modalCss, ".th-modal"), "max-height");
			expect(maxHeightDecl, "the panel max-height must be wired to the published geometry").not.toBe("");
			const panelMax = evaluateBound(maxHeightDecl, vars, replay.layoutHeightPx);
			expect(panelMax).toBeLessThanOrEqual(replay.visualHeightPx);
			// ...while remaining tall enough to be the answering surface (two
			// overlay padding steps below the visible height).
			expect(panelMax).toBeGreaterThan(replay.visualHeightPx / 2);
		},
	);

	it("the window's scroll contract is untouched: body scrolls internally, actions row pins inside", () => {
		// The bound change must not resurrect dock machinery: the body remains
		// the single internal scrollport and the panel a flex column, so the
		// sticky action row (approval-dock.css) still pins inside the bounded
		// panel instead of any viewport math returning.
		const questionWindow = readFileSync("src/styles/question-window.css", "utf8");
		const bodyRule = ruleBody(questionWindow, ".th-question-window-body");
		expect(declarationValue(bodyRule, "overflow-y")).toBe("auto");
		expect(declarationValue(bodyRule, "min-height")).toBe("0");
		const panelRule = ruleBody(modalCss, ".th-modal");
		expect(declarationValue(panelRule, "display")).toBe("flex");
		expect(declarationValue(panelRule, "flex-direction")).toBe("column");
	});
});
