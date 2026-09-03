import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Layout contract for the goal shelf's shrink behaviour inside .th-chat-main.
 *
 * .th-chat-main is a clipped (overflow: hidden) flex column. A child that
 * refuses to shrink pushes the status strip and composer past the pane
 * bottom at short viewports - with both shelves expanded, Chrome measured
 * the composer entirely below the container edge at 1280x720. The shelf
 * must therefore yield height (the panel scrolls) while the bar never
 * shrinks. Rules are read straight from disk (same readFileSync+regex
 * approach as styleContracts.test.ts) so removing or weakening any of them
 * fails here.
 */

const chatPane = readFileSync("src/styles/chat-pane.css", "utf8");

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

const declarationValue = (body: string, property: string): string => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;}]*)`, "i"))?.[1]?.trim() ?? "";
};

describe("goal shelf shrink contract", () => {
  it("makes .th-goal-shelf a shrinkable min-height: 0 flex column (never flex: none)", () => {
    const shelf = ruleBody(chatPane, ".th-goal-shelf");
    const violations: string[] = [];
    if (declarationValue(shelf, "display").toLowerCase() !== "flex") {
      violations.push("chat-pane.css .th-goal-shelf is not display: flex");
    }
    if (declarationValue(shelf, "flex-direction").toLowerCase() !== "column") {
      violations.push("chat-pane.css .th-goal-shelf is not flex-direction: column");
    }
    if (declarationValue(shelf, "min-height") !== "0") {
      violations.push(
        `chat-pane.css .th-goal-shelf min-height is ` +
          `"${declarationValue(shelf, "min-height") || "missing"}"; expected 0`,
      );
    }
    // Shrinkability: the flex shorthand must declare shrink 1 (flex: 0 1
    // auto). flex: none - or any shrink-0 form - re-creates the
    // composer-overflow blocker under .th-chat-main's clipping.
    if (declarationValue(shelf, "flex") !== "0 1 auto") {
      violations.push(
        `chat-pane.css .th-goal-shelf flex is ` +
          `"${declarationValue(shelf, "flex") || "missing"}"; ` +
          "it must stay shrinkable (flex: 0 1 auto), never flex: none",
      );
    }
    expect(violations).toEqual([]);
  });

  it("keeps the goal bar row non-shrinking with flex: none", () => {
    const row = ruleBody(chatPane, ".th-goal-shelf .th-activity-bar-row");
    const violations: string[] = [];
    if (declarationValue(row, "flex") !== "none") {
      violations.push(
        `chat-pane.css .th-goal-shelf .th-activity-bar-row flex is ` +
          `"${declarationValue(row, "flex") || "missing"}"; the bar must keep flex: none`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("keeps .th-goal-panel scrollable at a 40vh cap while allowing it to shrink", () => {
    const panel = ruleBody(chatPane, ".th-goal-panel");
    const violations: string[] = [];
    if (declarationValue(panel, "overflow-y").toLowerCase() !== "auto") {
      violations.push(
        `chat-pane.css .th-goal-panel overflow-y is ` +
          `"${declarationValue(panel, "overflow-y") || "missing"}"; expected auto`,
      );
    }
    if (declarationValue(panel, "max-height") !== "40vh") {
      violations.push(
        `chat-pane.css .th-goal-panel max-height is ` +
          `"${declarationValue(panel, "max-height") || "missing"}"; expected 40vh`,
      );
    }
    if (declarationValue(panel, "min-height") !== "0") {
      violations.push(
        `chat-pane.css .th-goal-panel min-height is ` +
          `"${declarationValue(panel, "min-height") || "missing"}"; expected 0`,
      );
    }
    expect(violations).toEqual([]);
  });
});
