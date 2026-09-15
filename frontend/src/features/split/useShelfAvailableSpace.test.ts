import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateShelfSpace, computeShelfAvailableSpace, TRANSCRIPT_MIN_BAND_PX } from "./useShelfAvailableSpace";

function mockHeight(element: Element, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    height,
    width: 600,
    top: 0,
    bottom: height,
    left: 0,
    right: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function measured(className: string, height: number, margin = "0"): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.style.marginTop = margin;
  mockHeight(element, height);
  return element;
}

describe("computeShelfAvailableSpace", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("budgets fixed bands and margins without reading either rendered allocation", () => {
    const column = measured("th-chat-main", 800);
    const composer = measured("th-chat-input", 100, "5px");
    const status = measured("th-chat-status", 20);
    const goalShelf = measured("th-goal-shelf", 0, "9px");
    const goalBar = measured("th-activity-bar-row", 30);
    const goalPanel = measured("th-goal-panel", 80);
    goalShelf.append(goalBar, goalPanel);
    const activityShelf = measured("th-activity-shelf", 0, "8px");
    const activityBar = measured("th-activity-bar-row", 30);
    const grip = measured("th-activity-resize", 10, "2px");
    grip.style.marginBottom = "4px";
    const selfPanel = measured("th-activity-panel", 200);
    activityShelf.append(activityBar, grip, selfPanel);
    column.append(composer, status, goalShelf, activityShelf);
    document.body.appendChild(column);

    expect(TRANSCRIPT_MIN_BAND_PX).toBe(120);
    expect(computeShelfAvailableSpace(column, selfPanel)).toBe(462);
    mockHeight(goalPanel, 140);
    mockHeight(selfPanel, 320);
    expect(computeShelfAvailableSpace(column, selfPanel)).toBe(462);
    const banner = measured("th-send-error-banner", 45);
    column.prepend(banner);
    expect(computeShelfAvailableSpace(column, selfPanel)).toBe(417);
    banner.remove();
    expect(computeShelfAvailableSpace(column, selfPanel)).toBe(462);
  });

  it("counts the approval dock as a fixed band above the composer", () => {
    const column = measured("th-chat-main", 800);
    const content = measured("th-chat-main-content", 0);
    const scrollport = measured("th-chat-scrollport", 400);
    content.append(scrollport);
    const controls = measured("th-chat-controls", 24);
    const dock = measured("th-approval-dock", 60);
    const composer = measured("th-chat-input", 100);
    column.append(content, controls, dock, composer);
    document.body.appendChild(column);

    // 800 − 24 controls − 60 dock − 100 composer − 120 transcript reserve;
    // the scrollport itself is the measured output, never a fixed band.
    expect(computeShelfAvailableSpace(column, null)).toBe(496);
    // Growing the dock shrinks the budget by exactly its outer height.
    mockHeight(dock, 90);
    expect(computeShelfAvailableSpace(column, null)).toBe(466);
    // Removing the dock returns the budget, still reserving the transcript
    // minimum band for the scrollport.
    dock.remove();
    expect(computeShelfAvailableSpace(column, null)).toBe(800 - 24 - 100 - TRANSCRIPT_MIN_BAND_PX);
  });

	it("counts the measured panel's own margins against its budget", () => {
		const column = measured("th-chat-main", 800);
		const composer = measured("th-chat-input", 100);
		const dock = measured("th-approval-dock", 60, "4px");
		dock.style.marginBottom = "2px";
		column.append(dock, composer);
		document.body.appendChild(column);

		// 800 − 100 composer − 120 reserve − 6 dock margins: the panel's own
		// gutters come out of its budget, never out of the transcript reserve.
		expect(computeShelfAvailableSpace(column, dock)).toBe(574);
	});

	it("yields the transcript reserve to the measured panel's minimum when the column is tight", () => {
		const column = measured("th-chat-main", 300);
		const controls = measured("th-chat-controls", 24);
		const composer = measured("th-chat-input", 100);
		const dock = measured("th-approval-dock", 60);
		column.append(controls, dock, composer);
		document.body.appendChild(column);

		// Without a minimum the full reserve holds: 300 − 24 − 100 − 120 = 56.
		expect(computeShelfAvailableSpace(column, dock)).toBe(56);
		// A 74px panel minimum (header + borders + body floor) yields the
		// reserve down to what is left: 300 − 24 − 100 − 102 = 74.
		expect(computeShelfAvailableSpace(column, dock, { minSelfPx: 74 })).toBe(74);
		// Below the minimum the reserve is gone entirely and the panel takes
		// what remains — the composer band is the only hard floor.
		mockHeight(column, 160);
		expect(computeShelfAvailableSpace(column, dock, { minSelfPx: 74 })).toBe(36);
		// Space permits again: the reserve is intact — 800 − 24 − 100 − 120.
		mockHeight(column, 800);
		expect(computeShelfAvailableSpace(column, dock, { minSelfPx: 74 })).toBe(556);
	});

	it("excludes the panel under measurement from the fixed bands", () => {
		const column = measured("th-chat-main", 800);
		const composer = measured("th-chat-input", 100);
		const dock = measured("th-approval-dock", 60);
		column.append(composer, dock);
		document.body.appendChild(column);

		// A band measuring itself must not see its own box: 800 − 100 − 120.
		expect(computeShelfAvailableSpace(column, dock)).toBe(580);
		// Growing or shrinking the measured band cannot move its own budget —
		// otherwise the measurement oscillates with the panel it clamps.
		mockHeight(dock, 200);
		expect(computeShelfAvailableSpace(column, dock)).toBe(580);
		mockHeight(dock, 20);
		expect(computeShelfAvailableSpace(column, dock)).toBe(580);
	});

	it("subtracts the queue slot as a fixed band, collapsed or expanded", () => {
    const column = measured("th-chat-main", 800);
    const composer = measured("th-chat-input", 120);
    const status = measured("th-chat-status", 24);
    const queue = measured("th-queue", 28);
    column.append(composer, status, queue);
    document.body.appendChild(column);

    // Collapsed queue: 800 − 120 composer − 24 status − 28 queue − 120 reserve.
    expect(computeShelfAvailableSpace(column, null)).toBe(508);
    // Expanded queue grows the slot; the same band shrinks the shelf budget.
    mockHeight(queue, 200);
    expect(computeShelfAvailableSpace(column, null)).toBe(336);
  });
});


describe("allocateShelfSpace", () => {
  it("allocates saved preferences together without exceeding the budget", () => {
    expect(allocateShelfSpace(454, 174.5, 480)).toEqual({ goal: 174.5, activity: 279.5 });
    expect(allocateShelfSpace(514, 174.5, 480)).toEqual({ goal: 174.5, activity: 339.5 });
    expect(allocateShelfSpace(454, 174.5, 480)).toEqual({ goal: 174.5, activity: 279.5 });
    expect(allocateShelfSpace(454, 0, 480)).toEqual({ goal: 0, activity: 454 });
    expect(allocateShelfSpace(454, 174.5, 0)).toEqual({ goal: 174.5, activity: 0 });
  });
  it("collapses an unreadable goal and never assigns negative space", () => {
    expect(allocateShelfSpace(80, 174.5, 480)).toEqual({ goal: 0, activity: 80 });
    expect(allocateShelfSpace(-20, 174.5, 480)).toEqual({ goal: 0, activity: 0 });
    expect(allocateShelfSpace(96, 174.5, 480)).toEqual({ goal: 48, activity: 48 });
  });
});
