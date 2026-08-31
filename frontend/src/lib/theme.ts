/**
 * Three-way color theme plumbing: the stored preference, resolution of
 * "system" against the OS, and application to the document element. The
 * actual light/dark token values live in styles/tokens.css, scoped to the
 * data-theme attribute applied here.
 */

export type ThemeId = "light" | "dark" | "system";

/** Concrete theme after resolving "system" against the OS preference. */
export type ResolvedTheme = "light" | "dark";

export interface ThemeOption {
  readonly id: ThemeId;
  readonly labelKey: string;
}

/** Fixed localStorage key for the theme preference (mirrored in index.html). */
export const THEME_STORAGE_KEY = "th-theme";

/** Media query the "system" choice follows. */
export const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: "light", labelKey: "settings.themeLight" },
  { id: "dark", labelKey: "settings.themeDark" },
  { id: "system", labelKey: "settings.themeSystem" },
];

function isThemeId(value: string | null): value is ThemeId {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Stored preference; "system" when the value is missing or corrupt.
 * Tolerates localStorage throwing (private browsing) the same way.
 */
export function detectTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function persistTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Private modes may throw; the choice simply will not persist.
  }
}

/**
 * The OS-level preference. Falls back to dark — the historical default of
 * this app — when matchMedia is unavailable.
 */
export function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia(PREFERS_DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

export function resolveTheme(id: ThemeId): ResolvedTheme {
  return id === "system" ? systemTheme() : id;
}

/**
 * Browser/PWA chrome per resolved theme: the theme-colour meta mirrors
 * --th-bg in styles/tokens.css (pinned to it by the theme tests), and the
 * iOS status-bar style keeps its foreground legible over each canvas. The
 * pre-paint inline script in index.html carries the same values.
 */
export const THEME_CHROME_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  dark: "#0a0a0a",
  light: "#eeedeb",
};

export const APPLE_STATUS_BAR_STYLES: Readonly<Record<ResolvedTheme, string>> = {
  dark: "black-translucent",
  light: "default",
};

const setMetaContent = (name: string, content: string): void => {
  document.querySelector(`meta[name="${name}"]`)?.setAttribute("content", content);
};

/**
 * Scopes token overrides to the resolved theme via data-theme, aligns native
 * controls (scrollbars, form controls, caret) via color-scheme, and moves
 * the browser/PWA chrome metadata (theme-colour, iOS status bar) with it.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.setProperty("color-scheme", resolved);
  setMetaContent("theme-color", THEME_CHROME_COLORS[resolved]);
  setMetaContent("apple-mobile-web-app-status-bar-style", APPLE_STATUS_BAR_STYLES[resolved]);
}

/**
 * Invokes onChange with the newly resolved theme whenever the OS preference
 * flips. Returns the cleanup that unregisters the media-query listener.
 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  const mql = window.matchMedia(PREFERS_DARK_QUERY);
  const handler = (): void => onChange(mql.matches ? "dark" : "light");
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
