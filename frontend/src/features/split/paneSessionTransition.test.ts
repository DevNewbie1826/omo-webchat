import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPaneSessionTransition, PANE_SESSION_TRANSITION_CLASS } from "./paneSessionTransition";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches: reduced && query === REDUCED_MOTION_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function resolvedTransition(): ViewTransition {
  return {
    ready: Promise.resolve(),
    finished: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    skipTransition: () => undefined,
    types: new Set<string>() as unknown as ViewTransitionTypeSet,
  };
}

function pendingTransition(): ViewTransition {
  const never = new Promise<void>(() => undefined);
  return {
    ready: never,
    finished: never,
    updateCallbackDone: never,
    skipTransition: () => undefined,
    types: new Set<string>() as unknown as ViewTransitionTypeSet,
  };
}

function installStart(impl: (update: () => unknown) => ViewTransition): ReturnType<typeof vi.fn> {
  const start = vi.fn((callback: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
    const update = typeof callback === "function" ? callback : callback.update;
    return impl(() => (typeof update === "function" ? update() : undefined));
  });
  document.startViewTransition = start as unknown as typeof document.startViewTransition;
  return start;
}

function mountPanes(): void {
  document.body.innerHTML = `
    <div class="th-pane-wrap" data-pane-id="p1"><div class="th-chat-scrollport">session-a</div></div>
    <div class="th-pane-wrap" data-pane-id="p2"><div class="th-chat-scrollport">session-b</div></div>`;
}

function paneEl(paneId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
  if (!el) throw new Error(`pane ${paneId} missing`);
  return el;
}

function regionOf(paneId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] .th-chat-scrollport`);
  if (!el) throw new Error(`transcript region of ${paneId} missing`);
  return el;
}

/** Mimics the React remount: a session change replaces the transcript node. */
function swapRegion(paneId: string, content: string): void {
  paneEl(paneId).innerHTML = `<div class="th-chat-scrollport">${content}</div>`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "startViewTransition");
  document.body.innerHTML = "";
});

describe("applyPaneSessionTransition", () => {
  it("applies the update exactly once when the transition API is missing", () => {
    mountPanes();
    const update = vi.fn(() => swapRegion("p1", "session-a2"));

    applyPaneSessionTransition("p1", update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(paneEl("p1").textContent).toContain("session-a2");
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toBe("");
  });

  it("names only the switching pane's transcript region across the remount", () => {
    mountPanes();
    const callbacks: Array<() => unknown> = [];
    const start = installStart((update) => {
      callbacks.push(update);
      return pendingTransition();
    });
    const update = vi.fn(() => swapRegion("p1", "session-a2"));

    applyPaneSessionTransition("p1", update);

    expect(start).toHaveBeenCalledTimes(1);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toMatch(/^th-pane-session-\d+$/);
    expect(regionOf("p2").style.getPropertyValue("view-transition-name")).toBe("");
    expect(update).not.toHaveBeenCalled();

    for (const callback of callbacks) callback();

    expect(update).toHaveBeenCalledTimes(1);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toMatch(/^th-pane-session-\d+$/);
    expect(paneEl("p1").textContent).toContain("session-a2");
    expect(regionOf("p2").style.getPropertyValue("view-transition-name")).toBe("");
    expect(regionOf("p2").style.getPropertyValue("view-transition-class")).toBe("");
  });

  it("tags the region with the pane-session class when the platform supports view-transition-class", () => {
    mountPanes();
    vi.stubGlobal("CSS", { supports: (property: string) => property === "view-transition-class" });
    installStart((update) => {
      update();
      return resolvedTransition();
    });

    applyPaneSessionTransition("p1", () => swapRegion("p1", "session-a2"));

    expect(regionOf("p1").style.getPropertyValue("view-transition-class")).toBe(PANE_SESSION_TRANSITION_CLASS);
    expect(regionOf("p2").style.getPropertyValue("view-transition-class")).toBe("");
  });

  it("ends rapid session switches on the last session with the DOM update applied once", () => {
    mountPanes();
    const applied: string[] = [];
    const captured: Array<() => unknown> = [];
    const start = installStart((update) => {
      captured.push(update);
      return pendingTransition();
    });
    const switchTo = (label: string) => () => {
      applied.push(label);
      swapRegion("p1", `content-${label}`);
    };

    applyPaneSessionTransition("p1", switchTo("one"));
    applyPaneSessionTransition("p1", switchTo("two"));
    applyPaneSessionTransition("p1", switchTo("three"));

    expect(applied).toEqual([]);
    for (const callback of captured) callback();

    expect(start).toHaveBeenCalledTimes(3);
    expect(applied).toEqual(["three"]);
    expect(paneEl("p1").textContent).toContain("content-three");
    expect(paneEl("p1").textContent).not.toContain("content-one");
    expect(paneEl("p1").textContent).not.toContain("content-two");
  });

  it("keeps two panes' pending transcript switches independent", () => {
    mountPanes();
    const callbacks: Array<() => unknown> = [];
    installStart((update) => {
      callbacks.push(update);
      return pendingTransition();
    });
    const first = vi.fn(() => swapRegion("p1", "content-a"));
    const second = vi.fn(() => swapRegion("p2", "content-b"));

    applyPaneSessionTransition("p1", first);
    applyPaneSessionTransition("p2", second);
    for (const callback of callbacks) callback();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(regionOf("p1").textContent).toBe("content-a");
    expect(regionOf("p2").textContent).toBe("content-b");
  });

  it("starts no transition under reduced motion and applies the update once", () => {
    mountPanes();
    stubReducedMotion(true);
    const start = installStart((update) => {
      update();
      return resolvedTransition();
    });
    const update = vi.fn(() => swapRegion("p1", "session-a2"));

    applyPaneSessionTransition("p1", update);

    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toBe("");
  });

  it("applies the update once when the pane has no transcript region yet", () => {
    document.body.innerHTML = `<div class="th-pane-wrap" data-pane-id="p1"><div class="th-session-picker">picker</div></div>`;
    const start = installStart((update) => {
      update();
      return resolvedTransition();
    });
    const update = vi.fn(() => {
      paneEl("p1").innerHTML = `<div class="th-chat-scrollport">session-a</div>`;
    });

    applyPaneSessionTransition("p1", update);

    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toMatch(/^th-pane-session-\d+$/);
  });

  it("releases the region name after the crossfade clock", () => {
    vi.useFakeTimers();
    mountPanes();
    installStart((update) => {
      update();
      return resolvedTransition();
    });

    applyPaneSessionTransition("p1", () => swapRegion("p1", "session-a2"));

    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).not.toBe("");
    vi.advanceTimersByTime(300);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toBe("");
    expect(regionOf("p1").style.getPropertyValue("view-transition-class")).toBe("");
  });

  it("never lets a stale cleanup timer un-name a newer switch", () => {
    vi.useFakeTimers();
    mountPanes();
    installStart((update) => {
      update();
      return resolvedTransition();
    });

    applyPaneSessionTransition("p1", () => swapRegion("p1", "session-a2"));
    const firstName = regionOf("p1").style.getPropertyValue("view-transition-name");

    vi.advanceTimersByTime(100);
    applyPaneSessionTransition("p1", () => swapRegion("p1", "session-a3"));

    vi.advanceTimersByTime(200);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).not.toBe("");
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).not.toBe(firstName);

    vi.advanceTimersByTime(100);
    expect(regionOf("p1").style.getPropertyValue("view-transition-name")).toBe("");
  });
});

describe("view-transitions.css clock", () => {
  const css = readFileSync("src/styles/view-transitions.css", "utf8");

  it("times the pane-session crossfade with the state-change motion tokens", () => {
    const block =
      css.match(/::view-transition-old\(\.th-pane-session\),\s*::view-transition-new\(\.th-pane-session\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toContain("animation-duration: var(--th-dur)");
    expect(block).toContain("animation-timing-function: var(--th-ease-out)");
  });

  it("collapses the pane-session crossfade under reduced motion", () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*$/)?.[1] ?? "";
    expect(reduced).toContain("::view-transition-old(.th-pane-session)");
    expect(reduced).toContain("::view-transition-new(.th-pane-session)");
    expect(reduced).toContain("animation-duration: 0s !important");
  });
});
