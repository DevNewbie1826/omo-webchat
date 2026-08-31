import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles/sidebar-toggle.css", "utf8");

const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

/**
 * The collapse toggle's chevron must point toward where the sidebar is about
 * to move (IconChevron's natural direction is RIGHT):
 * - expanded: rotate(180deg) → points LEFT, the collapse affordance;
 * - collapsed: no rotation → points RIGHT, the expand affordance.
 * The shipped CSS had this inverted, which read as a stuck/lying toggle.
 */
describe("sidebar toggle chevron direction", () => {
  it("points left while expanded and right while collapsed", () => {
    const base = ruleBody(".th-sidebar-toggle svg");
    expect(base).toContain("rotate(180deg)");

    const collapsed = ruleBody(".th-sidebar--collapsed .th-sidebar-toggle svg");
    expect(collapsed).toMatch(/rotate\(0deg\)\s*;?\s*$/);
    expect(collapsed).not.toContain("rotate(180deg)");
  });
});
