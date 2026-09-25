import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runViewTransition } from "./viewTransition";
import type { ViewTransitionUpdate } from "./viewTransition";

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

interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((_, rej) => {
    reject = rej;
  });
  return { promise, reject };
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

function installStart(impl: (update: () => unknown) => ViewTransition): void {
  document.startViewTransition = ((callback?: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
    const update = typeof callback === "function" ? callback : callback?.update;
    return impl(() => {
      if (typeof update === "function") return update();
    });
  }) as typeof document.startViewTransition;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "startViewTransition");
});

describe("runViewTransition", () => {
  it("runs the update once on the supported path", () => {
    stubReducedMotion(false);
    const update = vi.fn();
    const start = vi.fn((callback: () => unknown) => {
      callback();
      return resolvedTransition();
    });
    installStart(start);

    runViewTransition(update);

    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("runs the update once when the API is missing", () => {
    stubReducedMotion(false);
    const start = vi.fn();
    document.startViewTransition = start as typeof document.startViewTransition;
    Reflect.deleteProperty(document, "startViewTransition");
    const update = vi.fn();

    runViewTransition(update);

    expect("startViewTransition" in document).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("skips the API under reduced motion and runs the update once", () => {
    stubReducedMotion(true);
    const start = vi.fn((callback: () => unknown) => {
      callback();
      return resolvedTransition();
    });
    installStart(start);
    const update = vi.fn();

    runViewTransition(update);

    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("applies the update once when ready and finished reject before the callback", async () => {
    stubReducedMotion(false);
    const ready = deferred();
    const finished = deferred();
    const updateCallbackDone = deferred();
    const start = vi.fn(() => ({
      ready: ready.promise,
      finished: finished.promise,
      updateCallbackDone: updateCallbackDone.promise,
      skipTransition: () => undefined,
      types: new Set<string>() as unknown as ViewTransitionTypeSet,
    }));
    installStart(start);
    const update = vi.fn();

    runViewTransition(update);
    expect(update).not.toHaveBeenCalled();

    const reason = new DOMException("skipped", "AbortError");
    ready.reject(reason);
    finished.reject(reason);
    updateCallbackDone.reject(reason);
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not apply the update twice when the callback ran and the transition then rejects", async () => {
    stubReducedMotion(false);
    const ready = deferred();
    const finished = deferred();
    const updateCallbackDone = deferred();
    installStart((callback) => {
      callback();
      return {
        ready: ready.promise,
        finished: finished.promise,
        updateCallbackDone: updateCallbackDone.promise,
        skipTransition: () => undefined,
        types: new Set<string>() as unknown as ViewTransitionTypeSet,
      };
    });
    const update = vi.fn();

    runViewTransition(update);
    const reason = new DOMException("skipped", "AbortError");
    ready.reject(reason);
    finished.reject(reason);
    updateCallbackDone.reject(reason);
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("runs the update once when startViewTransition throws before the callback", () => {
    stubReducedMotion(false);
    installStart(() => {
      throw new Error("view transition failed");
    });
    const update = vi.fn();

    runViewTransition(update);

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an update that already threw", () => {
    stubReducedMotion(false);
    installStart((callback) => {
      callback();
      throw new Error("after update");
    });
    let calls = 0;
    const update: ViewTransitionUpdate = () => {
      calls += 1;
      throw new Error("update failed");
    };

    expect(() => runViewTransition(update)).toThrow("update failed");
    expect(calls).toBe(1);
  });

  it("ends rapid latest-wins calls on the last update", () => {
    stubReducedMotion(false);
    const applied: string[] = [];
    const callbacks: Array<() => unknown> = [];
    installStart((callback) => {
      callbacks.push(callback);
      return {
        ready: new Promise<void>(() => undefined),
        finished: new Promise<void>(() => undefined),
        updateCallbackDone: new Promise<void>(() => undefined),
        skipTransition: () => undefined,
        types: new Set<string>() as unknown as ViewTransitionTypeSet,
      };
    });

    runViewTransition(() => {
      applied.push("a");
    }, { latestWins: true });
    runViewTransition(() => {
      applied.push("b");
    }, { latestWins: true });
    runViewTransition(() => {
      applied.push("c");
    }, { latestWins: true });
    for (const callback of callbacks) callback();

    expect(applied).toEqual(["c"]);
  });

  it("ends rapid latest-wins calls on the last update when earlier transitions reject", async () => {
    stubReducedMotion(false);
    const applied: string[] = [];
    const gates: Deferred[] = [];
    installStart(() => {
      const ready = deferred();
      const finished = deferred();
      const updateCallbackDone = deferred();
      gates.push(ready, finished, updateCallbackDone);
      return {
        ready: ready.promise,
        finished: finished.promise,
        updateCallbackDone: updateCallbackDone.promise,
        skipTransition: () => undefined,
        types: new Set<string>() as unknown as ViewTransitionTypeSet,
      };
    });

    runViewTransition(() => {
      applied.push("a");
    }, { latestWins: true });
    runViewTransition(() => {
      applied.push("b");
    }, { latestWins: true });
    runViewTransition(() => {
      applied.push("c");
    }, { latestWins: true });
    const reason = new DOMException("skipped", "AbortError");
    for (const gate of gates) gate.reject(reason);
    await Promise.resolve();

    expect(applied).toEqual(["c"]);
  });

  it("applies every non-coalesced update once, including ones overlapped by the lane", () => {
    stubReducedMotion(false);
    const applied: string[] = [];
    const callbacks: Array<() => unknown> = [];
    installStart((callback) => {
      callbacks.push(callback);
      return {
        ready: new Promise<void>(() => undefined),
        finished: new Promise<void>(() => undefined),
        updateCallbackDone: new Promise<void>(() => undefined),
        skipTransition: () => undefined,
        types: new Set<string>() as unknown as ViewTransitionTypeSet,
      };
    });

    runViewTransition(() => {
      applied.push("plain");
    });
    runViewTransition(() => {
      applied.push("lane");
    }, { latestWins: true });
    runViewTransition(() => {
      applied.push("plain-after");
    });
    for (const callback of callbacks) callback();

    expect(applied).toEqual(["plain", "lane", "plain-after"]);
  });
});

describe("root view-transition timing", () => {
  const css = readFileSync("src/styles/global.css", "utf8");

  it("times the root old and new pseudos with the state-change tokens", () => {
    const body = css.match(/::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body).toContain("animation-duration: var(--th-dur)");
    expect(body).toContain("animation-timing-function: var(--th-ease-out)");
  });

  it("keeps the universal reduced-motion policy and zeroes the root pseudos", () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]+)\}\s*$/)?.[1] ?? "";
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain("::view-transition-old(root)");
    expect(reduced).toContain("::view-transition-new(root)");
    expect(reduced).toMatch(/animation-duration:\s*0s\s*!important/);
  });
});
