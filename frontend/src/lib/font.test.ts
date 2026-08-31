import { describe, expect, it, vi } from "vitest";
import {
  detectFont,
  detectFontSize,
  FONT_SIZE_DEFAULT,
  persistFont,
  persistFontSize,
} from "./font";

describe("font preference storage", () => {
  it("returns defaults when storage reads throw", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      expect(detectFont()).toBe("system");
      expect(detectFontSize()).toBe(FONT_SIZE_DEFAULT);
    } finally {
      getItem.mockRestore();
    }
  });

  it("treats throwing storage writes as non-persistent choices", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    try {
      expect(() => persistFont("fira")).not.toThrow();
      expect(() => persistFontSize(16)).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});
