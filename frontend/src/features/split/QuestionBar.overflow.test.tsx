import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import type { ApprovalFrame } from "../../lib/contract/types_gen";
import { QuestionBar } from "./QuestionBar";

// Defect 3 structure: the option chips must sit in their own scrollable lane
// (.th-question-bar-options) so the row can shrink on phone widths, while the
// multi-select Send button stays a pinned direct child of the actions row —
// never inside the scroll lane, so it can never scroll off-screen.
const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

const LABELS = ["React + TypeScript", "SvelteKit + TypeScript", "Vue + TypeScript"];

const FRAME = {
	type: "approval",
	id: "ask-overflow",
	method: "question",
	nonBlocking: true,
	questions: [
		{
			id: "q1",
			question: "Which stack should the scaffold use?",
			multiSelect: true,
			options: LABELS.map((label) => ({ label })),
		},
	],
} as unknown as ApprovalFrame;

describe("QuestionBar overflow structure", () => {
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
					<QuestionBar request={FRAME} onAnswer={() => undefined} />
				</I18nContext.Provider>,
			);
		});
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	it("wraps the option chips in a dedicated scroll lane", () => {
		const lane = container.querySelector(".th-question-bar-options");
		expect(lane).not.toBeNull();
		const chips = Array.from(
			lane?.querySelectorAll<HTMLButtonElement>("button") ?? [],
		).map((button) => button.textContent);
		expect(chips).toEqual(LABELS);
	});

	it("keeps Send pinned in the actions row, outside the scroll lane", () => {
		const actions = container.querySelector(".th-question-bar-actions");
		const lane = container.querySelector(".th-question-bar-options");
		expect(actions).not.toBeNull();
		expect(lane).not.toBeNull();
		const send = Array.from(
			actions?.querySelectorAll<HTMLButtonElement>("button") ?? [],
		).find((button) => button.textContent === "question.submit");
		expect(send).toBeDefined();
		expect(send?.classList.contains("th-question-bar-send")).toBe(true);
		// Pinned means: a direct child of the actions row, not inside the lane.
		expect(send?.parentElement).toBe(actions);
		expect(lane?.contains(send ?? null)).toBe(false);
	});
});
