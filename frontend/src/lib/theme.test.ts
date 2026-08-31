import { readFileSync } from "node:fs";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  APPLE_STATUS_BAR_STYLES,
  applyTheme,
  detectTheme,
  persistTheme,
  PREFERS_DARK_QUERY,
  resolveTheme,
  THEME_CHROME_COLORS,
  THEME_STORAGE_KEY,
  watchSystemTheme,
} from "./theme";
import type { ResolvedTheme } from "./theme";
import { parseThemeScopes } from "../styles/contrast";

import pageHtml from "../../index.html?raw";

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

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  for (const meta of document.querySelectorAll(
    'meta[name="theme-color"], meta[name="apple-mobile-web-app-status-bar-style"]',
  )) {
    meta.remove();
  }
});

describe("detectTheme", () => {
  it("falls back to system when nothing is stored", () => {
    expect(detectTheme()).toBe("system");
  });

  it("reads a stored choice", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(detectTheme()).toBe("light");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(detectTheme()).toBe("dark");
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(detectTheme()).toBe("system");
  });

  it("treats a corrupt stored value as system instead of throwing", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "blue");
    expect(detectTheme()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "");
    expect(detectTheme()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "DARK");
    expect(detectTheme()).toBe("system");
  });

  it("survives localStorage access throwing (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(detectTheme()).toBe("system");
  });
});

describe("persistTheme", () => {
  it("writes the choice under the fixed key", () => {
    persistTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    persistTheme("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("does not throw when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => persistTheme("light")).not.toThrow();
  });
});

describe("resolveTheme", () => {
  it("keeps explicit themes as-is regardless of the OS preference", () => {
    const stub = stubSystemTheme(true);
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    stub.setDark(false);
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves system through prefers-color-scheme", () => {
    const stub = stubSystemTheme(true);
    expect(resolveTheme("system")).toBe("dark");
    stub.setDark(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("falls back to dark when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("no matchMedia");
    });
    expect(resolveTheme("system")).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("sets the data attribute and color-scheme to the resolved theme", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");

    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");
  });
});

describe("theme-aware browser chrome", () => {
  const addMeta = (name: string, content: string): void => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", name);
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
  };
  const metaContent = (name: string): string =>
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";

  it("moves the theme-colour and iOS status-bar metas with the applied theme", () => {
    addMeta("theme-color", "#0a0a0a");
    addMeta("apple-mobile-web-app-status-bar-style", "black-translucent");

    applyTheme("light");
    expect(metaContent("theme-color")).toBe(THEME_CHROME_COLORS.light);
    expect(metaContent("apple-mobile-web-app-status-bar-style")).toBe(APPLE_STATUS_BAR_STYLES.light);

    applyTheme("dark");
    expect(metaContent("theme-color")).toBe(THEME_CHROME_COLORS.dark);
    expect(metaContent("apple-mobile-web-app-status-bar-style")).toBe(APPLE_STATUS_BAR_STYLES.dark);
  });

  it("mirrors the tokens.css canvas of each theme scope", () => {
    const scopes = parseThemeScopes(readFileSync("src/styles/tokens.css", "utf8"));
    const canvas = (selector: string): string =>
      scopes.find((scope) => scope.selector === selector)?.tokens["--th-bg"] ?? "";
    expect(canvas(":root")).not.toBe("");
    expect(THEME_CHROME_COLORS.dark).toBe(canvas(":root"));
    expect(THEME_CHROME_COLORS.light).toBe(canvas('[data-theme="light"]'));
    expect(canvas(":root")).not.toBe(canvas('[data-theme="light"]'));
  });

  it("sets the chrome metas pre-paint from the real index.html inline script", () => {
    const script = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .find((body) => body?.includes('"th-theme"'));
    assert(script, "index.html must carry an inline pre-hydration theme script");

    const run = (stored: string): { readonly themeColor: string; readonly statusBar: string } => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      assert(frame.contentWindow);
      assert(frame.contentDocument);
      const scope = frame.contentWindow as typeof window;
      const frameDocument = frame.contentDocument;
      // The real page carries both metas in <head>; reproduce that so the
      // script has the same targets it updates in production.
      for (const [name, content] of [
        ["theme-color", "#0a0a0a"],
        ["apple-mobile-web-app-status-bar-style", "black-translucent"],
      ] as const) {
        const meta = frameDocument.createElement("meta");
        meta.setAttribute("name", name);
        meta.setAttribute("content", content);
        frameDocument.head.appendChild(meta);
      }
      try {
        // Same-origin storage is shared across iframes in jsdom: start clean.
        scope.localStorage.removeItem("th-theme");
        scope.localStorage.setItem("th-theme", stored);
        scope.eval(script);
        return {
          themeColor: frameDocument.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "",
          statusBar:
            frameDocument
              .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
              ?.getAttribute("content") ?? "",
        };
      } finally {
        scope.localStorage.removeItem("th-theme");
        frame.remove();
      }
    };

    expect(run("light")).toEqual({ themeColor: THEME_CHROME_COLORS.light, statusBar: APPLE_STATUS_BAR_STYLES.light });
    expect(run("dark")).toEqual({ themeColor: THEME_CHROME_COLORS.dark, statusBar: APPLE_STATUS_BAR_STYLES.dark });
  });
});

describe("PWA manifest", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as {
    readonly name?: string;
    readonly short_name?: string;
    readonly theme_color?: string;
    readonly background_color?: string;
  };
  const productName = (JSON.parse(readFileSync("src/i18n/locales/en.json", "utf8")) as Record<string, string>)[
    "app.title"
  ];

  it("names the installed app with the real product name, never a terminal", () => {
    expect(productName).toBe("omo-webchat");
    expect(manifest.name).toBe(productName);
    expect(manifest.short_name).toBe(productName);
  });

  it("uses the default theme's canvas as the static install-time chrome", () => {
    // A manifest is fetched once at install time and cannot follow the active
    // theme - the runtime theme-colour meta above does that. What the
    // manifest can do is match the app's default (dark) theme exactly.
    expect(manifest.theme_color).toBe(THEME_CHROME_COLORS.dark);
    expect(manifest.background_color).toBe(THEME_CHROME_COLORS.dark);
  });
});

describe("watchSystemTheme", () => {
  it("reports live OS changes until the cleanup runs", () => {
    const stub = stubSystemTheme(true);
    const seen: ResolvedTheme[] = [];
    const stop = watchSystemTheme((resolved) => seen.push(resolved));
    expect(stub.listenerCount()).toBe(1);

    stub.setDark(false);
    expect(seen).toEqual(["light"]);
    stub.setDark(true);
    expect(seen).toEqual(["light", "dark"]);

    stop();
    expect(stub.listenerCount()).toBe(0);
    stub.setDark(false);
    expect(seen).toEqual(["light", "dark"]);
  });
});
