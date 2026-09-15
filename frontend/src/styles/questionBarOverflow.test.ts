import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Defect 3 contract: with three ordinary-length option labels the inline
// question row measured scrollWidth 497 against clientWidth 364 at 390px and
// 334 at 360px, pushing the enabled Send button past the viewport. The row
// must shrink: the option chips scroll inside their own lane while Send
// stays pinned and always visible.
const css = readFileSync("src/styles/question-bar.css", "utf8");

const ruleBody = (selector: string): string => {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

describe("question bar overflow contract", () => {
	it("the actions row is allowed to shrink below its content width", () => {
		const body = ruleBody(".th-question-bar-actions");
		expect(body).not.toBe("");
		// flex: none is what let the row overflow the pane.
		expect(body).not.toMatch(/flex\s*:\s*none/);
		expect(body).toMatch(/min-width\s*:\s*0/);
	});

	it("the option chips live in a horizontally scrollable lane", () => {
		const body = ruleBody(".th-question-bar-options");
		expect(body).not.toBe("");
		expect(body).toMatch(/overflow-x\s*:\s*auto/);
		expect(body).toMatch(/min-width\s*:\s*0/);
	});

	it("individual chips never shrink or truncate inside the lane", () => {
		const body = ruleBody(".th-question-bar-options .th-btn");
		expect(body).toMatch(/flex\s*:\s*none/);
	});

	it("the scrollable lane carries a visible scrollbar affordance", () => {
		expect(css).toMatch(/\.th-question-bar-options::-webkit-scrollbar/);
		expect(ruleBody(".th-question-bar-options")).toMatch(
			/scrollbar-width\s*:\s*thin/,
		);
	});

	it("Send is pinned: it can never be the control that leaves the row", () => {
		const body = ruleBody(".th-question-bar-send");
		expect(body).toMatch(/flex\s*:\s*none/);
	});
});
