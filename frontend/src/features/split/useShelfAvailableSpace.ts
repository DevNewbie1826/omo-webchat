import { useEffect, useState } from "react";

/** Vertical transcript scrollport retained whenever an expanded shelf is clamped. */
export const TRANSCRIPT_MIN_BAND_PX = 120;

const MEASURED_INPUT_SELECTOR = [
  ".th-chat-input",
  ".th-chat-status",
  ".th-queue",
  ".th-activity-bar-row",
  ".th-goal-panel",
  ".th-activity-panel",
  ".th-activity-resize",
  ".th-goal-shelf",
  ".th-activity-shelf",
].join(", ");

function verticalMargins(element: Element): number {
  const style = window.getComputedStyle(element);
  return (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
}

function outerHeight(element: Element | null): number {
  return element === null ? 0 : element.getBoundingClientRect().height + verticalMargins(element);
}

/**
 * Available panel height in the chat column after every non-transcript band.
 * Shelf margins are counted separately from their children, while the current
 * panel contributes only its margin because its content box is the result.
 */
export function computeShelfAvailableSpace(column: HTMLElement, selfPanel: Element | null): number {
  let fixed = outerHeight(column.querySelector(".th-chat-input"))
    + outerHeight(column.querySelector(".th-chat-status"))
    + outerHeight(column.querySelector(".th-queue"));

  for (const bar of column.querySelectorAll(".th-activity-bar-row")) {
    fixed += outerHeight(bar);
  }
  for (const panel of column.querySelectorAll(".th-goal-panel, .th-activity-panel")) {
    fixed += panel === selfPanel ? verticalMargins(panel) : outerHeight(panel);
  }
  for (const grip of column.querySelectorAll(".th-activity-resize")) {
    fixed += outerHeight(grip);
  }
  for (const shelf of column.querySelectorAll(".th-goal-shelf, .th-activity-shelf")) {
    fixed += verticalMargins(shelf);
  }

  return column.getBoundingClientRect().height - fixed - TRANSCRIPT_MIN_BAND_PX;
}

interface ShelfAvailableSpace {
  readonly availableSpacePx: number | null;
  readonly selfPanelHeightPx: number | null;
}

/**
 * Shared live measurement path for both shelves. Callback-ref element state
 * makes panel replacement part of the effect lifecycle; ResizeObserver tracks
 * every arithmetic input, and MutationObserver refreshes that observed set
 * when sibling bars or panels appear or disappear without resizing the column.
 */
export function useShelfAvailableSpace(
  active: boolean,
  shelf: HTMLElement | null,
  selfPanel: HTMLElement | null,
): ShelfAvailableSpace {
  const [availableSpacePx, setAvailableSpacePx] = useState<number | null>(null);
  const [selfPanelHeightPx, setSelfPanelHeightPx] = useState<number | null>(null);

  useEffect(() => {
    if (!active || shelf === null || typeof ResizeObserver === "undefined") {
      setAvailableSpacePx(null);
      setSelfPanelHeightPx(null);
      return undefined;
    }

    setSelfPanelHeightPx(null);
    const column = shelf.closest<HTMLElement>(".th-chat-main");
    const observed = new Set<Element>();
    const measureAvailable = (): void => {
      if (column !== null) setAvailableSpacePx(computeShelfAvailableSpace(column, selfPanel));
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const selfEntry = entries.find((entry) => entry.target === selfPanel);
      if (selfEntry !== undefined) setSelfPanelHeightPx(selfEntry.contentRect.height);
      measureAvailable();
    });

    const refreshObservedInputs = (): void => {
      const next = new Set<Element>();
      if (selfPanel !== null) next.add(selfPanel);
      if (column !== null) {
        next.add(column);
        for (const input of column.querySelectorAll(MEASURED_INPUT_SELECTOR)) next.add(input);
      }
      for (const input of observed) {
        if (!next.has(input)) {
          resizeObserver.unobserve(input);
          observed.delete(input);
        }
      }
      for (const input of next) {
        if (!observed.has(input)) {
          observed.add(input);
          resizeObserver.observe(input);
        }
      }
    };

    refreshObservedInputs();
    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined" && column !== null) {
      mutationObserver = new MutationObserver(() => {
        refreshObservedInputs();
        measureAvailable();
      });
      mutationObserver.observe(column, { childList: true, subtree: true });
    }

    return () => {
      mutationObserver?.disconnect();
      resizeObserver.disconnect();
    };
  }, [active, selfPanel, shelf]);

  return { availableSpacePx, selfPanelHeightPx };
}
