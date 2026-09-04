import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Headroom contract for the activity shelf panel's section header rows.
 *
 * When the expanded panel is squeezed to an extreme height (below roughly
 * 40px of visible box), the first thing inside the scrollport is a section
 * header row ("에이전트" + "0개 실행 중 / 0개 완료", the DAG toolbar, the
 * todo title) clipped mid-glyph by the panel's top padding edge - half-cut
 * text that reads as a rendering bug. Rows that short cannot show a header
 * legibly, so the headers must be hidden while the list content keeps
 * scrolling.
 *
 * The trigger is a height container query, which needs a size container
 * with a definite height: .th-chat-pane is height: 100% down a definite
 * chain (#root is 100dvh), so it upgrades from inline-size to size
 * containment and the shelf hides its header rows under
 * `@container chat-pane (max-height: …)`. Rules are read straight from
 * disk so removing or weakening any of them fails here.
 */

const chatPane = readFileSync("src/styles/chat-pane.css", "utf8");
const activityShelf = readFileSync("src/styles/activity-shelf.css", "utf8");

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

/** Body of the `@container chat-pane (max-height: …)` block, if present. */
const heightQueryBlock = (css: string): string => {
  const match = css.match(/@container\s+chat-pane\s+\(max-height:[^)]+\)\s*\{/);
  if (match === null || match.index === undefined) return "";
  let depth = 1;
  let index = match.index + match[0].length;
  const start = index;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") depth -= 1;
    index += 1;
  }
  return depth === 0 ? css.slice(start, index - 1) : "";
};

describe("activity shelf panel headroom contract", () => {
  it("makes .th-chat-pane a size container so height container queries resolve", () => {
    const pane = ruleBody(chatPane, ".th-chat-pane");
    const container = pane.match(/(?:^|;)\s*container\s*:\s*([^;}]*)/i)?.[1]?.trim() ?? "";
    const containerType = pane.match(/(?:^|;)\s*container-type\s*:\s*([^;}]*)/i)?.[1]?.trim() ?? "";
    const sizeContained =
      /(^|\s)\/\s*size$/.test(container) || containerType.toLowerCase() === "size";
    expect(
      sizeContained,
      `chat-pane.css .th-chat-pane must be a size container (container: chat-pane / size); ` +
        `found container="${container || "missing"}" container-type="${containerType || "missing"}". ` +
        "The pane is height: 100% down a definite chain (#root is 100dvh), so size " +
        "containment is safe and is what lets the shelf react to extreme vertical compression",
    ).toBe(true);
  });

  it("hides the panel's section header rows under a chat-pane max-height container query", () => {
    const block = heightQueryBlock(activityShelf);
    expect(
      block,
      "activity-shelf.css must hide section header rows inside " +
        "`@container chat-pane (max-height: …)` so a panel squeezed below ~40px " +
        "of visible height cannot paint half-clipped header glyphs",
    ).not.toBe("");
    for (const selector of [
      ".th-activity-section-head",
      ".th-activity-dag-toolbar",
      ".th-activity-section > .th-activity-section-title",
    ]) {
      const body = ruleBody(block, selector);
      expect(
        /(?:^|;)\s*display\s*:\s*none\s*(;|$)/i.test(body),
        `${selector} must be display: none inside the max-height container query; ` +
          `found "${body || "missing"}"`,
      ).toBe(true);
    }
  });
});
