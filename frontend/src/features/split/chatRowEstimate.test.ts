import { describe, expect, it } from "vitest";
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
});

describe("estimateRowHeight", () => {
	it("estimates a short user row away from the old constant 80", () => {
		const height = estimateRowHeight(userRow("Hi"), readRowMetrics(null));
		expect(height).toBeGreaterThan(40);
		expect(height).toBeLessThan(80);
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
});
