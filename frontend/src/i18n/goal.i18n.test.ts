import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import ko from "./locales/ko.json";

const KEYS = [
  "chat.goal.title",
  "chat.goal.statusActive",
  "chat.goal.statusComplete",
  "chat.goal.statusBlocked",
  "chat.goal.blockedReason",
  "chat.goal.expand",
  "chat.goal.collapse",
] as const;

describe("goal bar i18n keys", () => {
  it("en.json contains each goal key as a non-empty string", () => {
    const table = en as Record<string, string>;
    for (const key of KEYS) {
      expect(typeof table[key], `en ${key}`).toBe("string");
      expect(table[key]?.length ?? 0, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it("ko.json contains each goal key as a non-empty string", () => {
    const table = ko as Record<string, string>;
    for (const key of KEYS) {
      expect(typeof table[key], `ko ${key}`).toBe("string");
      expect(table[key]?.length ?? 0, `ko ${key}`).toBeGreaterThan(0);
    }
  });
});
