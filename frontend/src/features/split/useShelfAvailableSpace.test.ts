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
    const goalShelf = measured("th-goal-shelf", 0, "6px");
    const goalBar = measured("th-activity-bar-row", 30);
    const goalPanel = measured("th-goal-panel", 80, "3px");
    goalShelf.append(goalBar, goalPanel);
    const activityShelf = measured("th-activity-shelf", 0, "8px");
    const activityBar = measured("th-activity-bar-row", 30);
    const grip = measured("th-activity-resize", 10, "2px");
    const selfPanel = measured("th-activity-panel", 200, "4px");
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
