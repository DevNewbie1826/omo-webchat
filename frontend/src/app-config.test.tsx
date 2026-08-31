import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppConfig } from "./app-config";

// Pin the fixed storage contract shared with index.html (see AGENTS.md:
// localStorage keys are fixed). The query string pins the resolution path.
const THEME_STORAGE_KEY = "th-theme";
const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

interface SystemThemeStub {
  readonly setDark: (dark: boolean) => void;
  readonly listenerCount: () => number;
}

/** Controllable matchMedia stub: only the dark query is stateful. */
function stubSystemTheme(initialDark: boolean): SystemThemeStub {
  let dark = initialDark;
  const listeners = new Set<EventListener>();
  const mql: MediaQueryList = {
    get matches() {
      return dark;
    },
    media: PREFERS_DARK_QUERY,
    onchange: null,
    addEventListener: (_type: string, cb: EventListener) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: EventListener) => {
      listeners.delete(cb);
    },
    addListener: (cb: EventListener) => {
      listeners.add(cb);
    },
    removeListener: (cb: EventListener) => {
      listeners.delete(cb);
    },
    dispatchEvent: () => false,
  };
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => {
    if (query === PREFERS_DARK_QUERY) return mql;
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
  return {
    setDark(next: boolean): void {
      dark = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe("useAppConfig theme", () => {
  let container: HTMLDivElement;
  let root: Root;
  let exposed!: ReturnType<typeof useAppConfig>;

  function Probe() {
    exposed = useAppConfig();
    return null;
  }

  async function renderProbe(): Promise<void> {
    await act(async () => {
      root.render(<Probe />);
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.setItem("th-lang", "en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("applies a stored choice on load, with matching color-scheme", async () => {
    stubSystemTheme(true); // OS is dark; a stored light must still win.
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    await renderProbe();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("resolves system through prefers-color-scheme and follows live OS changes", async () => {
    const stub = stubSystemTheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    await renderProbe();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");

    act(() => stub.setDark(false));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");

    act(() => stub.setDark(true));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("stops following the OS once an explicit theme is chosen, and persists it", async () => {
    const stub = stubSystemTheme(true);
    await renderProbe(); // default choice is "system"
    expect(stub.listenerCount()).toBe(1);

    act(() => {
      exposed.setTheme("dark");
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // The media-query listener was cleaned up with the mode switch.
    expect(stub.listenerCount()).toBe(0);

    act(() => stub.setDark(false));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("unregisters the OS listener on unmount", async () => {
    const stub = stubSystemTheme(false);
    await renderProbe();
    expect(stub.listenerCount()).toBe(1);
    await act(async () => {
      root.unmount();
    });
    expect(stub.listenerCount()).toBe(0);
    // Remount so the shared afterEach can unmount cleanly.
    root = createRoot(container);
  });

  it("falls back to the system preference when the stored value is corrupt", async () => {
    stubSystemTheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    await renderProbe();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("falls back to the system preference when nothing is stored", async () => {
    stubSystemTheme(false);
    await renderProbe();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
