import { describe, expect, it, vi } from "vitest";
import { estimateRowHeight, readRowMetrics, type RowMetrics } from "./chatRowEstimate";
import type { TranscriptItem } from "./useChatFrameState";

const PARAGRAPH =
	"Assistant output wraps across the message lane and must not use a constant height. ";
const THREE_PARAGRAPHS = [PARAGRAPH.repeat(4), PARAGRAPH.repeat(4), PARAGRAPH.repeat(3)].join("\n\n");

function userRow(text: string): TranscriptItem {
	return { kind: "message", message: { role: "user", blocks: [{ kind: "text", text }] } };
}

function assistantRow(text: string): TranscriptItem {
	return { kind: "message", message: { role: "assistant", blocks: [{ kind: "text", text }] } };
}

function scaleMetrics(metrics: RowMetrics, factor: number): RowMetrics {
	return {
		laneWidth: metrics.laneWidth,
		bodyLineHeight: metrics.bodyLineHeight * factor,
		secondaryLineHeight: metrics.secondaryLineHeight * factor,
		charWidth: metrics.charWidth * factor,
		monoCharWidth: metrics.monoCharWidth * factor,
	};
}

/** Lane used by the layout mock when a probe stretches instead of sizing to glyphs. */
const STRETCH_LANE = 800;
const ADVANCE_RATIO = 0.6;

function sizesToContent(el: HTMLElement): boolean {
	if (el.style.width === "max-content" || el.style.width === "fit-content") return true;
	if (el.style.display === "inline-block" || el.style.display === "inline") return true;
	if (el.style.alignSelf === "flex-start" || el.style.alignSelf === "start") return true;
	return false;
}

function inheritedFontSize(el: HTMLElement): number {
	let node: HTMLElement | null = el;
	while (node) {
		const raw = node.style.fontSize || getComputedStyle(node).fontSize;
		const px = Number.parseFloat(raw);
		if (Number.isFinite(px) && px > 0) return px;
		node = node.parentElement;
	}
	return 0;
}

function isGlyphSample(el: HTMLElement): boolean {
	const text = el.textContent ?? "";
	return el.childNodes.length === 1 && el.childNodes[0]?.nodeType === Node.TEXT_NODE && text.length > 1;
}

function isStretchedFlexItem(el: HTMLElement): boolean {
	if (sizesToContent(el)) return false;
	const parent = el.parentElement;
	// .th-chat-msg--assistant { display: flex; flex-direction: column } — default align-items: stretch
	return parent !== null && parent.classList.contains("th-chat-msg--assistant");
}

/**
 * jsdom reports 0×0 for every rect, so readRowMetrics takes the documented
 * fallback path (asserted below). This mock is the layout a browser would
 * give the probe: a flex-column child stretches to the lane unless it sizes
 * to its glyphs, in which case width tracks font-size.
 */
function installGlyphLayout(): () => void {
	const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
		if (isGlyphSample(this)) {
			const fontSize = inheritedFontSize(this);
			const text = this.textContent ?? "";
			const width = isStretchedFlexItem(this) ? STRETCH_LANE : text.length * fontSize * ADVANCE_RATIO;
			return new DOMRect(0, 0, width, fontSize);
		}
		const forced =
			this.style.width === "100%" || this.style.left === "0" || this.style.left === "0px" || this.style.right === "0" || this.style.right === "0px";
		const rowWidth = forced ? STRETCH_LANE : Math.min(760, STRETCH_LANE + 6 + 6 - 24 - 24);
		return new DOMRect(0, 0, rowWidth, 20);
	});
	return () => {
		spy.mockRestore();
	};
}

describe("readRowMetrics", () => {
	it("returns usable fallbacks when the scroll element is null", () => {
		const metrics = readRowMetrics(null);
		expect(metrics.laneWidth).toBeGreaterThan(0);
		expect(metrics.bodyLineHeight).toBeGreaterThan(0);
		expect(metrics.secondaryLineHeight).toBeGreaterThan(0);
		expect(metrics.charWidth).toBeGreaterThan(0);
		expect(metrics.monoCharWidth).toBeGreaterThan(0);
	});

	it("returns usable fallbacks when measurement yields 0 and leaves no probe", () => {
		const scrollElement = document.createElement("div");
		document.body.append(scrollElement);
		const metrics = readRowMetrics(scrollElement);
		expect(metrics.laneWidth).toBeGreaterThan(0);
		expect(metrics.bodyLineHeight).toBeGreaterThan(0);
		expect(metrics.charWidth).toBeGreaterThan(0);
		expect(scrollElement.querySelector(".th-chat-row")).toBeNull();
		scrollElement.remove();
	});

	it("returns the null-element fallbacks when jsdom layout is 0 even at a 24px font", () => {
		const scrollElement = document.createElement("div");
		scrollElement.style.fontSize = "24px";
		document.body.append(scrollElement);
		const fromDom = readRowMetrics(scrollElement);
		const fromNull = readRowMetrics(null);
		expect(fromDom).toEqual(fromNull);
		expect(scrollElement.querySelector(".th-chat-row")).toBeNull();
		scrollElement.remove();
	});

	it("measures a glyph advance that tracks font size instead of container width", () => {
		const restore = installGlyphLayout();
		const scrollElement = document.createElement("div");
		document.body.append(scrollElement);
		try {
			scrollElement.style.fontSize = "10px";
			const small = readRowMetrics(scrollElement);
			scrollElement.style.fontSize = "24px";
			const large = readRowMetrics(scrollElement);
			expect(small.charWidth).toBeGreaterThan(0);
			expect(large.charWidth).toBeGreaterThan(small.charWidth);
			expect(large.charWidth / small.charWidth).toBeCloseTo(24 / 10, 1);
			expect(small.charWidth).not.toBeCloseTo(STRETCH_LANE / 252, 3);
			expect(large.charWidth).not.toBeCloseTo(STRETCH_LANE / 252, 3);
		} finally {
			scrollElement.remove();
			restore();
		}
	});

	it("measures the probe against .th-chat-history, the same containing block a rendered row uses", () => {
		// Rendered rows are position:absolute inside .th-chat-history (position:relative).
		// Their percentage width therefore resolves against history, which is already
		// narrower than .th-chat-body by the stable both-edges scrollbar gutter (12px).
		// Appending the probe to the scroll element overstates the lane: 378 vs 366 at
		// viewport 390, 564 vs 552 at viewport 600.
		const SCROLL_WIDTH = 390;
		const HISTORY_WIDTH = 378;
		const GUTTER = 12;
		const SCROLLBAR = 6;
		const laneFrom = (containing: number): number =>
			Math.min(760, containing + SCROLLBAR + SCROLLBAR - GUTTER - GUTTER);

		const scrollElement = document.createElement("div");
		scrollElement.className = "th-chat-body";
		scrollElement.style.fontSize = "13px";
		scrollElement.style.fontFamily = "ContainingBlockPin, sans-serif";
		Object.defineProperty(scrollElement, "clientWidth", { configurable: true, value: SCROLL_WIDTH });

		const content = document.createElement("div");
		content.className = "th-chat-content";

		const history = document.createElement("div");
		history.className = "th-chat-history";
		history.style.position = "relative";
		Object.defineProperty(history, "clientWidth", { configurable: true, value: HISTORY_WIDTH });

		content.append(history);
		scrollElement.append(content);
		document.body.append(scrollElement);

		let probeParent: Element | null = null;
		const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
			if (this.classList.contains("th-chat-row")) {
				probeParent = this.parentElement;
				const containing = this.parentElement?.clientWidth ?? 0;
				return new DOMRect(0, 0, laneFrom(containing), 20);
			}
			if (isGlyphSample(this)) {
				const fontSize = inheritedFontSize(this);
				const text = this.textContent ?? "";
				const width = isStretchedFlexItem(this) ? STRETCH_LANE : text.length * fontSize * ADVANCE_RATIO;
				return new DOMRect(0, 0, width, fontSize);
			}
			return new DOMRect(0, 0, 20, 20);
		});

		try {
			const metrics = readRowMetrics(scrollElement);
			expect(probeParent).toBe(history);
			expect(metrics.laneWidth).toBe(366);
			expect(metrics.laneWidth).not.toBe(378);
			expect(laneFrom(SCROLL_WIDTH)).toBe(378);
			expect(laneFrom(HISTORY_WIDTH)).toBe(366);
		} finally {
			scrollElement.remove();
			spy.mockRestore();
		}
	});

	it("does not reuse cached metrics when font family changes at the same size and width", () => {
		const restore = installGlyphLayout();
		const scrollElement = document.createElement("div");
		scrollElement.style.fontSize = "13px";
		scrollElement.style.fontFamily = "ui-monospace";
		Object.defineProperty(scrollElement, "clientWidth", { configurable: true, value: 390 });
		document.body.append(scrollElement);
		try {
			const first = readRowMetrics(scrollElement);
			expect(readRowMetrics(scrollElement)).toBe(first);
			scrollElement.style.fontFamily = '"JetBrains Mono", monospace';
			expect(readRowMetrics(scrollElement)).not.toBe(first);
		} finally {
			scrollElement.remove();
			restore();
		}
	});
});

describe("estimateRowHeight", () => {
	it("estimates a short user row away from the old constant 80", () => {
		const height = estimateRowHeight(userRow("Hi"), readRowMetrics(null));
		expect(height).toBeGreaterThan(40);
		expect(height).toBeLessThan(80);
	});

	it("estimates a 51-character user row at bubble width, not the full lane", () => {
		const metrics: RowMetrics = {
			laneWidth: 390,
			bodyLineHeight: 22.4,
			secondaryLineHeight: 22.4,
			charWidth: 6.29,
			monoCharWidth: 6.29,
		};
		const height = estimateRowHeight(userRow("x".repeat(51)), metrics);
		expect(height).toBeGreaterThanOrEqual(85);
		expect(height).toBeLessThanOrEqual(95);
	});

	it("estimates a 3-paragraph assistant row between 250px and 700px", () => {
		const height = estimateRowHeight(assistantRow(THREE_PARAGRAPHS), readRowMetrics(null));
		expect(height).toBeGreaterThan(250);
		expect(height).toBeLessThan(700);
	});

	it("estimates a fenced code block taller than the old constant 80", () => {
		const fenced = ["```", "const alpha = 1;", "const beta = 2;", "const gamma = 3;", "const delta = 4;", "```"].join("\n");
		const height = estimateRowHeight(assistantRow(fenced), readRowMetrics(null));
		expect(height).toBeGreaterThan(90);
		expect(height).toBeLessThan(400);
	});

	it("estimates a row with an image block near the CSS max-height plus chrome", () => {
		const item: TranscriptItem = {
			kind: "message",
			message: {
				role: "assistant",
				blocks: [{ kind: "image", data: "aaaa", mimeType: "image/png" }],
			},
		};
		const height = estimateRowHeight(item, readRowMetrics(null));
		expect(height).toBeGreaterThan(320);
		expect(height).toBeLessThan(450);
	});

	it("estimates a notice row as a short system line, not 80px", () => {
		const item: TranscriptItem = {
			kind: "notice",
			notice: { id: 1, kind: "engine_notify", payload: { message: "ok" }, at: 0 },
		};
		const height = estimateRowHeight(item, readRowMetrics(null));
		expect(height).toBeGreaterThan(20);
		expect(height).toBeLessThan(80);
	});

	it("estimates an empty blocks-less row as one line of chrome, not 80px", () => {
		const item: TranscriptItem = { kind: "message", message: { role: "assistant", blocks: [] } };
		const height = estimateRowHeight(item, readRowMetrics(null));
		expect(height).toBeGreaterThan(16);
		expect(height).toBeLessThan(80);
	});

	it("produces a proportionally larger estimate at a larger font size", () => {
		const base = readRowMetrics(null);
		const larger = scaleMetrics(base, 24 / 13);
		const item = assistantRow(THREE_PARAGRAPHS);
		const small = estimateRowHeight(item, base);
		const big = estimateRowHeight(item, larger);
		expect(big).toBeGreaterThan(small);
		expect(big / small).toBeGreaterThan(1.2);
	});

	it("estimates a 252-character assistant paragraph within 10% of 126px when charWidth reflects prose", () => {
		const paragraph =
			"The transcript keeps a complete record of the discussion. Each message has a stable identity, and the browser measures its rendered height as it enters the visible region. This example includes enough detail to wrap naturally on a narrow mobile screen.";
		expect(paragraph.length).toBe(252);
		const metrics: RowMetrics = {
			laneWidth: 378,
			bodyLineHeight: 22.4,
			secondaryLineHeight: 18.85058,
			charWidth: 6.4,
			monoCharWidth: 8.036542338709678,
		};
		const height = estimateRowHeight(assistantRow(paragraph), metrics);
		expect(Math.abs(height - 126) / 126).toBeLessThanOrEqual(0.1);
	});
});
