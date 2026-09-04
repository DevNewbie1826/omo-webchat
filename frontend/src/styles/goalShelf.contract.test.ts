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
 * shrinks: an explicit min-height floor at the bar-row height (collapsed
 * and expanded) keeps overflow: hidden from zeroing the automatic minimum.
 * A squeezed shelf must additionally clip itself (overflow: hidden) so its
 * content cannot paint over the status strip and composer.
 * Because that clipping also cuts off the global outside focus outline, the
 * goal button must pull its focus treatment inside its own bounds in both
 * collapsed and expanded states. The activity shelf is the other shrinkable
 * sibling: flex: 0 1 auto (never flex: none) with the same bar-row min-height
 * floor so its 60vh panel cannot shove the composer past the clipped pane
 * once the transcript has already gone to zero. When the activity shelf is
 * expanded, that floor also reserves the resize grip and a minimal panel
 * box (borders intact) so overflow: hidden cannot clip the interaction
 * band in half; collapsed stays the plain bar floor. The activity button
 * uses the same inward focus outline as the goal button. The user-sized
 * activity panel must stay viewport-bounded (max-height as a vh fraction,
 * never none) so a stale stored height from a taller window cannot dominate
 * a short one. Rules are read straight from disk
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

const compactCss = (value: string): string => value.replace(/\s+/g, "");

/** .th-activity-bar: secondary line box + vertical padding + 1px borders. */
const BAR_ROW_HEIGHT_FLOOR = compactCss(
  "calc(var(--th-type-secondary-size) * var(--th-type-secondary-line) + var(--th-space-1) + var(--th-space-1) + 2px)",
);

/** Expanded activity shelf: bar floor + 10px grip + grip margin-top +
 *  panel margin-top + vertical padding + 1px borders. */
const ACTIVITY_EXPANDED_HEIGHT_FLOOR = compactCss(
  "calc(var(--th-type-secondary-size) * var(--th-type-secondary-line) + var(--th-space-1) + var(--th-space-1) + 2px + 10px + var(--th-space-0-5) + var(--th-space-1) + var(--th-space-2) + var(--th-space-2) + 2px)",
);

const shelfMinHeightFloorViolations = (shelf: string): string[] => {
  const minHeight = declarationValue(shelf, "min-height");
  if (compactCss(minHeight) !== BAR_ROW_HEIGHT_FLOOR) {
    return [
      `chat-pane.css .th-goal-shelf min-height is "${minHeight || "missing"}"; ` +
        "expected the bar-row height floor (secondary size * line-height + " +
        "space-1 + space-1 + 2px borders) so the bar never collapses",
    ];
  }
  return [];
};

describe("goal shelf shrink contract", () => {
  it("makes .th-goal-shelf a shrinkable flex column floored at the bar-row height (never flex: none)", () => {
    const shelf = ruleBody(chatPane, ".th-goal-shelf");
    const violations: string[] = [];
    if (declarationValue(shelf, "display").toLowerCase() !== "flex") {
      violations.push("chat-pane.css .th-goal-shelf is not display: flex");
    }
    if (declarationValue(shelf, "flex-direction").toLowerCase() !== "column") {
      violations.push("chat-pane.css .th-goal-shelf is not flex-direction: column");
    }
    violations.push(...shelfMinHeightFloorViolations(shelf));
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

  it("floors .th-goal-shelf min-height at the bar row (collapsed and expanded) AND clips with overflow: hidden", () => {
    const shelf = ruleBody(chatPane, ".th-goal-shelf");
    const violations: string[] = [];
    // Floor applies on the shelf itself, so both collapsed (bar only) and
    // expanded (bar + panel) keep the bar row; only the panel yields.
    violations.push(...shelfMinHeightFloorViolations(shelf));
    if (/\.th-goal-(?:shelf|bar)\[aria-expanded[^\]]*\][^{]*\{[^}]*min-height/i.test(chatPane)) {
      violations.push(
        "chat-pane.css must not override .th-goal-shelf min-height by aria-expanded; " +
          "the bar-row floor applies in collapsed and expanded states",
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

  it("draws the goal button focus outline inside the clipped shelf in either aria-expanded state", () => {
    const focus = ruleBody(chatPane, ".th-goal-bar:focus-visible");
    const violations: string[] = [];
    if (declarationValue(focus, "outline-offset") !== "-2px") {
      violations.push(
        `chat-pane.css .th-goal-bar:focus-visible outline-offset is ` +
          `"${declarationValue(focus, "outline-offset") || "missing"}"; expected -2px`,
      );
    }
    // The selector must not depend on aria-expanded, otherwise one shelf state
    // can silently lose its visible keyboard focus treatment.
    if (chatPane.includes('.th-goal-bar[aria-expanded="true"]:focus-visible') ||
        chatPane.includes('.th-goal-bar[aria-expanded="false"]:focus-visible')) {
      violations.push("goal focus treatment must apply regardless of aria-expanded state");
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
    if (sizedMax !== "60vh") {
      violations.push(
        `activity-shelf.css .th-activity-panel--sized max-height is ` +
          `"${sizedMax || "missing"}"; expected exactly 60vh`,
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

  it("makes .th-activity-shelf a shrinkable flex column floored at the bar-row height (never flex: none)", () => {
    const shelf = ruleBody(activityShelf, ".th-activity-shelf");
    const violations: string[] = [];
    if (declarationValue(shelf, "display").toLowerCase() !== "flex") {
      violations.push("activity-shelf.css .th-activity-shelf is not display: flex");
    }
    if (declarationValue(shelf, "flex-direction").toLowerCase() !== "column") {
      violations.push("activity-shelf.css .th-activity-shelf is not flex-direction: column");
    }
    const minHeight = declarationValue(shelf, "min-height");
    if (compactCss(minHeight) !== BAR_ROW_HEIGHT_FLOOR) {
      violations.push(
        `activity-shelf.css .th-activity-shelf min-height is "${minHeight || "missing"}"; ` +
          "expected the bar-row height floor (secondary size * line-height + " +
          "space-1 + space-1 + 2px borders) so the bar never collapses",
      );
    }
    // Shrinkability: the flex shorthand must declare shrink 1 (flex: 0 1
    // auto). flex: none - or any shrink-0 form - re-creates the
    // composer-overflow blocker under .th-chat-main's clipping.
    if (declarationValue(shelf, "flex") !== "0 1 auto") {
      violations.push(
        `activity-shelf.css .th-activity-shelf flex is ` +
          `"${declarationValue(shelf, "flex") || "missing"}"; ` +
          "it must stay shrinkable (flex: 0 1 auto), never flex: none",
      );
    }
    // Clipping: once the shelf yields height, grip and panel content would
    // otherwise render outside the box over later column siblings.
    if (declarationValue(shelf, "overflow").toLowerCase() !== "hidden") {
      violations.push(
        `activity-shelf.css .th-activity-shelf overflow is ` +
          `"${declarationValue(shelf, "overflow") || "missing"}"; ` +
          "a squeezed shelf must clip (overflow: hidden) instead of painting over the status strip and composer",
      );
    }
    expect(violations).toEqual([]);
  });

  it("keeps the activity bar row non-shrinking with flex: none", () => {
    const row = ruleBody(activityShelf, ".th-activity-shelf .th-activity-bar-row");
    const violations: string[] = [];
    if (declarationValue(row, "flex") !== "none") {
      violations.push(
        `activity-shelf.css .th-activity-shelf .th-activity-bar-row flex is ` +
          `"${declarationValue(row, "flex") || "missing"}"; the bar must keep flex: none`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("reserves the grip and a minimal panel box in the expanded activity-shelf floor", () => {
    const expanded = ruleBody(
      activityShelf,
      '.th-activity-shelf:has(.th-activity-bar[aria-expanded="true"])',
    );
    const panel = ruleBody(activityShelf, ".th-activity-panel");
    const grip = ruleBody(activityShelf, ".th-activity-resize");
    const violations: string[] = [];
    const minHeight = declarationValue(expanded, "min-height");
    if (compactCss(minHeight) !== ACTIVITY_EXPANDED_HEIGHT_FLOOR) {
      violations.push(
        `activity-shelf.css expanded .th-activity-shelf min-height is "${minHeight || "missing"}"; ` +
          "expected bar floor + 10px grip + space-0-5 grip margin + space-1 panel margin + " +
          "space-2 + space-2 padding + 2px borders so the interaction band stays inside the clip",
      );
    }
    // Collapsed must stay the plain bar floor: the expanded calc belongs on
    // the :has(aria-expanded) rule, not the base shelf.
    const collapsed = declarationValue(ruleBody(activityShelf, ".th-activity-shelf"), "min-height");
    if (compactCss(collapsed) !== BAR_ROW_HEIGHT_FLOOR) {
      violations.push(
        `activity-shelf.css collapsed .th-activity-shelf min-height is "${collapsed || "missing"}"; ` +
          "collapsed must keep the bar-row floor (no blank space below the bar)",
      );
    }
    if (declarationValue(expanded, "flex") === "none") {
      violations.push(
        "activity-shelf.css expanded .th-activity-shelf must stay shrinkable; do not set flex: none",
      );
    }
    // Equivalent structure to .th-goal-panel: the panel yields and scrolls
    // inside the shelf instead of overflowing the clip.
    if (declarationValue(panel, "min-height") !== "0") {
      violations.push(
        `activity-shelf.css .th-activity-panel min-height is ` +
          `"${declarationValue(panel, "min-height") || "missing"}"; expected 0`,
      );
    }
    if (declarationValue(grip, "flex") !== "none") {
      violations.push(
        `activity-shelf.css .th-activity-resize flex is ` +
          `"${declarationValue(grip, "flex") || "missing"}"; the grip must keep flex: none`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("draws the activity button focus outline inside the clipped shelf in either aria-expanded state", () => {
    const focus = ruleBody(activityShelf, ".th-activity-bar:focus-visible");
    const violations: string[] = [];
    if (declarationValue(focus, "outline-offset") !== "-2px") {
      violations.push(
        `activity-shelf.css .th-activity-bar:focus-visible outline-offset is ` +
          `"${declarationValue(focus, "outline-offset") || "missing"}"; expected -2px`,
      );
    }
    // The selector must not depend on aria-expanded, otherwise one shelf state
    // can silently lose its visible keyboard focus treatment.
    if (activityShelf.includes('.th-activity-bar[aria-expanded="true"]:focus-visible') ||
        activityShelf.includes('.th-activity-bar[aria-expanded="false"]:focus-visible')) {
      violations.push("activity focus treatment must apply regardless of aria-expanded state");
    }
    expect(violations).toEqual([]);
  });
});
