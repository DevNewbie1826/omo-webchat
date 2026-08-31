import { createContext, useContext, useEffect } from "react";
import { FONT_SIZE_DEFAULT } from "../lib/font";
import type { FontId } from "../lib/font";
import en from "./locales/en.json";
import ko from "./locales/ko.json";

export type Lang = "en" | "ko";

/** Translate a key; `{name}` placeholders are filled from vars. */
export type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

export interface I18nValue {
  readonly lang: Lang;
  readonly setLang: (lang: Lang) => void;
  readonly font: FontId;
  readonly setFont: (font: FontId) => void;
  readonly fontSize: number;
  readonly setFontSize: (size: number) => void;
  readonly t: Translate;
}

const tables: Readonly<Record<Lang, Readonly<Record<string, string>>>> = { en, ko };

export const I18nContext = createContext<I18nValue>({
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: FONT_SIZE_DEFAULT,
  setFontSize: () => undefined,
  t: (key) => key,
});

export function useT(): I18nValue {
  return useContext(I18nContext);
}

/**
 * Keeps `<html lang>` in sync with the active locale so assistive technology,
 * font fallback, and text shaping see the right language after hydration.
 * (index.html applies the same precedence before hydration.)
 */
export function useDocumentLang(lang: Lang): void {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
}

const STORAGE_KEY = "th-lang";

export function detectLang(): Lang {
  const fallback = navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "en" || stored === "ko" ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function persistLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Private modes may throw; the choice simply will not persist.
  }
}

export function translate(
  lang: Lang,
  key: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const template = tables[lang][key] ?? tables.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
