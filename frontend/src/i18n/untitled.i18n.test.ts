import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import ko from "./locales/ko.json";

const KEYS = [
  "sidebar.tm.untitled",
] as const;

function localeTable(table: typeof en): Record<string, string> {
  return table as Record<string, string>;
}

describe("untitled-session i18n keys", () => {
  it("en.json contains each untitled-session key as a non-empty string", () => {
    const table = localeTable(en);
    for (const key of KEYS) {
      expect(typeof table[key], `en ${key}`).toBe("string");
      expect(table[key]?.length ?? 0, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it("ko.json contains each untitled-session key as a non-empty string", () => {
    const table = localeTable(ko);
    for (const key of KEYS) {
      expect(typeof table[key], `ko ${key}`).toBe("string");
      expect(table[key]?.length ?? 0, `ko ${key}`).toBeGreaterThan(0);
    }
  });
});
