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
 * shrinks. A squeezed shelf must additionally clip itself (overflow:
 * hidden) so its content cannot paint over the status strip and composer,
 * and the user-sized activity panel must stay viewport-bounded (max-height
 * as a vh fraction, never none) so a stale stored height from a taller
 * window cannot dominate a short one. Rules are read straight from disk
 * (same readFileSync+regex approach as styleContracts.test.ts) so removing
 * or weakening any of them fails here.
 */

const chatPane = readFileSync("src/styles/chat-pane.css", "utf8");
const activityShelf = readFileSync("src/styles/activity-shelf.css", "utf8");

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

  it("keeps .th-goal-shelf shrinkable (min-height: 0) AND clips it with overflow: hidden", () => {
    const shelf = ruleBody(chatPane, ".th-goal-shelf");
    const violations: string[] = [];
    // Shrink participation: without min-height: 0 the shelf pushes the
    // status strip and composer past the pane bottom at short viewports.
    if (declarationValue(shelf, "min-height") !== "0") {
      violations.push(
        `chat-pane.css .th-goal-shelf min-height is ` +
          `"${declarationValue(shelf, "min-height") || "missing"}"; expected 0`,
      );
    }
    // Clipping: once the shelf yields height, its bar and panel content
    // would otherwise render outside the box over later column siblings.
    if (declarationValue(shelf, "overflow").toLowerCase() !== "hidden") {
      violations.push(
        `chat-pane.css .th-goal-shelf overflow is ` +
          `"${declarationValue(shelf, "overflow") || "missing"}"; ` +
          "a squeezed shelf must clip (overflow: hidden) instead of painting over the status strip and composer",
      );
    }
    expect(violations).toEqual([]);
  });

  it("bounds the user-sized activity panel by the viewport instead of max-height: none", () => {
    const sized = ruleBody(activityShelf, ".th-activity-panel--sized");
    const base = ruleBody(activityShelf, ".th-activity-panel");
    const violations: string[] = [];
    // The sized panel carries an inline persisted px height; its cap must
    // stay a viewport fraction so a stored height from a taller window can
    // never dominate a shorter one (the panel scrolls inside the ceiling).
    const sizedMax = declarationValue(sized, "max-height").toLowerCase();
    if (!/^\d+vh$/.test(sizedMax)) {
      violations.push(
        `activity-shelf.css .th-activity-panel--sized max-height is ` +
          `"${sizedMax || "missing"}"; ` +
          "it must be a viewport fraction (e.g. 60vh), never none or a bare px value",
      );
    }
    // The content-sized default stays a fixed 280px cap.
    if (declarationValue(base, "max-height") !== "280px") {
      violations.push(
        `activity-shelf.css .th-activity-panel max-height is ` +
          `"${declarationValue(base, "max-height") || "missing"}"; ` +
          "the 280px default cap must stay intact",
      );
    }
    expect(violations).toEqual([]);
  });
});
