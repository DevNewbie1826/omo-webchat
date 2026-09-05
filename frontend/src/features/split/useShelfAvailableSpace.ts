import { useEffect, useState } from "react";

/** Vertical transcript scrollport retained whenever space permits. */
export const TRANSCRIPT_MIN_BAND_PX = 120;

function verticalMargins(element: Element): number {
  const style = window.getComputedStyle(element);
  return (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
}

function outerHeight(element: Element): number {
  return element.getBoundingClientRect().height + verticalMargins(element);
}

/** Both panel boxes are outputs, never fixed-band inputs. */
export function computeShelfAvailableSpace(column: HTMLElement, _selfPanel?: Element | null): number {
  let fixed = 0;
  const content = column.querySelector(":scope > .th-chat-main-content");
  const bands = [...column.children, ...(content?.children ?? [])];
  for (const child of bands) {
    if (child === content || child.matches(".th-chat-scrollport, .th-goal-shelf, .th-activity-shelf, .th-goal-panel, .th-activity-panel")) continue;
    // A nested shelf mount is structural, not a fixed band.
    if (child.querySelector(".th-goal-shelf, .th-activity-shelf")) continue;
    fixed += outerHeight(child);
  }
  for (const shelf of column.querySelectorAll(".th-goal-shelf, .th-activity-shelf")) {
    fixed += verticalMargins(shelf);
    for (const band of shelf.querySelectorAll(".th-activity-bar-row, .th-activity-resize")) fixed += outerHeight(band);
  }
  return column.getBoundingClientRect().height - fixed - TRANSCRIPT_MIN_BAND_PX;
}

/** Deterministic goal-first allocation, retaining one usable activity row. */
export function allocateShelfSpace(budget: number, goal: number, activity: number): { goal: number; activity: number } {
  const available = Math.max(0, budget);
  const goalHeight = Math.min(goal, Math.max(0, available - Math.min(activity, 48)));
  const usableGoal = goalHeight >= 48 ? goalHeight : 0;
  return { goal: usableGoal, activity: Math.min(activity, available - usableGoal) };
}

interface ShelfAvailableSpace {
  readonly availableSpacePx: number | null;
  readonly selfPanelHeightPx: number | null;
}
interface Registration {
  readonly shelf: HTMLElement;
  readonly panel: HTMLElement | null;
  readonly preferred: number | null;
  readonly update: (value: ShelfAvailableSpace) => void;
}

/** One measurement/allocation owner per column, shared by both subscribers. */
const columns = new WeakMap<HTMLElement, ReturnType<typeof createColumnAllocator>>();
function createColumnAllocator(column: HTMLElement) {
  const registrations = new Map<HTMLElement, Registration>();
  const observed = new Set<Element>();
  let goalPreference = Math.round(window.innerHeight * 0.4);
  const measure = (entries: readonly ResizeObserverEntry[] = []): void => {
    let goal: Registration | undefined;
    let activity: Registration | undefined;
    // A hidden/unlaid-out column has no usable measurement yet.
    if (column.getBoundingClientRect().height === 0) return;
    for (const item of registrations.values()) {
      if (item.shelf.matches(".th-goal-shelf")) goal = item;
      else activity = item;
    }
    const intrinsic = goal?.panel?.querySelector(".th-goal-content");
    if (intrinsic && goal?.panel) {
      const style = getComputedStyle(goal.panel);
      const natural = intrinsic.getBoundingClientRect().height;
      if (natural > 0) goalPreference = Math.max(48, natural + (parseFloat(style.paddingTop) || 0)
        + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0));
    }
    const allocation = allocateShelfSpace(computeShelfAvailableSpace(column),
      goal ? Math.min(goalPreference, Math.round(window.innerHeight * 0.4)) : 0,
      activity ? Math.min(activity.preferred ?? 280, Math.round(window.innerHeight * 0.6)) : 0);
    for (const item of registrations.values()) {
      const entry = entries.find((entry) => entry.target === item.panel);
      item.update({ availableSpacePx: item === goal ? allocation.goal : allocation.activity,
        selfPanelHeightPx: entry?.contentRect.height ?? null });
    }
  };
  const resize = new ResizeObserver((entries) => measure(entries));
  const refresh = (): void => {
    const next = new Set<Element>([column, ...column.children,
      ...column.querySelectorAll(".th-chat-main-content > *, .th-activity-bar-row, .th-activity-resize, .th-goal-content, .th-goal-panel, .th-activity-panel, .th-goal-shelf, .th-activity-shelf")]);
    for (const item of observed) if (!next.has(item)) { resize.unobserve(item); observed.delete(item); }
    for (const item of next) if (!observed.has(item)) { resize.observe(item); observed.add(item); }
  };
  const mutation = new MutationObserver(() => { refresh(); measure(); });
  mutation.observe(column, { childList: true, subtree: true });
  window.addEventListener("resize", measureViewport);
  function measureViewport(): void { measure(); }
  return {
    // Replace preferences in place: never allocate against a temporarily
    // unregistered peer just because its panel ref or requested size changed.
    add(item: Registration): void { registrations.set(item.shelf, item); refresh(); measure(); },
    remove(shelf: HTMLElement): void {
      registrations.delete(shelf);
      if (registrations.size) { refresh(); measure(); }
      else { resize.disconnect(); mutation.disconnect(); window.removeEventListener("resize", measureViewport); columns.delete(column); }
    },
  };
}

export function useShelfAvailableSpace(
  active: boolean,
  shelf: HTMLElement | null,
  selfPanel: HTMLElement | null,
  preferred: number | null = null,
): ShelfAvailableSpace {
  const [value, setValue] = useState<ShelfAvailableSpace>({ availableSpacePx: null, selfPanelHeightPx: null });
  useEffect(() => {
    const column = shelf?.closest<HTMLElement>(".th-chat-main");
    return () => { if (column && shelf) columns.get(column)?.remove(shelf); };
  }, [active, shelf]);
  useEffect(() => {
    const column = shelf?.closest<HTMLElement>(".th-chat-main");
    if (!active || !shelf || typeof ResizeObserver === "undefined") {
      setValue({ availableSpacePx: null, selfPanelHeightPx: null });
      return;
    }
    if (!column) {
      setValue({ availableSpacePx: null, selfPanelHeightPx: null });
      const observer = new ResizeObserver((entries) => {
        const entry = entries.find((entry) => entry.target === selfPanel);
        if (entry) setValue({ availableSpacePx: null, selfPanelHeightPx: entry.contentRect.height });
      });
      if (selfPanel) observer.observe(selfPanel);
      return () => observer.disconnect();
    }
    let owner = columns.get(column);
    if (!owner) { owner = createColumnAllocator(column); columns.set(column, owner); }
    const registration: Registration = { shelf, panel: selfPanel, preferred, update: (next) => setValue((previous) => {
      const height = next.selfPanelHeightPx ?? previous.selfPanelHeightPx;
      return previous.availableSpacePx === next.availableSpacePx && previous.selfPanelHeightPx === height
        ? previous : { ...next, selfPanelHeightPx: height };
    }) };
    owner.add(registration);
  }, [active, shelf, selfPanel, preferred]);
  return value;
}
