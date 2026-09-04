import { afterEach, describe, expect, it, vi } from "vitest";
import { computeShelfAvailableSpace, TRANSCRIPT_MIN_BAND_PX } from "./useShelfAvailableSpace";

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

  it("subtracts every fixed band, panel lifecycle peer, grip, margin, and transcript reserve", () => {
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
    expect(computeShelfAvailableSpace(column, selfPanel)).toBe(382);
  });
});
