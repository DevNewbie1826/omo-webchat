import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Headroom contract for the activity shelf panel's section header rows.
 *
 * When the expanded panel is squeezed to an extreme height (below roughly
 * 24px of visible box), the first thing inside the scrollport is a section
 * header row ("에이전트" + counts, the DAG toolbar, the todo title) clipped
 * mid-glyph by the panel's top padding edge - half-cut text that reads as a
 * rendering bug. Rows that short cannot show a header legibly, so the
 * headers must be hidden while the list content keeps scrolling.
 *
 * The trigger is measured panel headroom, not pane height: ActivityShelf.tsx
 * watches the rendered panel with a ResizeObserver and sets
 * data-headless="true" only while the panel's own content height is below
 * PANEL_HEADLESS_BELOW_PX (24). A pane-height proxy cannot do this - the
 * real-Chrome probes that motivated this contract measured a 577px pane
 * hiding every header and the DAG List/Graph controls despite a 269.25px
 * panel, and a 601px pane with an 18px panel still painting the agent
 * header 6.3px past the clip - and hiding the DAG toolbar removes the only
 * DAG view switch from the tab order and the accessibility tree, so the
 * state must fire only when the panel itself has no room. Rules are read
 * straight from disk (same readFileSync+regex approach as
 * styleContracts.test.ts) so removing or weakening any of them fails here.
 */

const chatPane = readFileSync("src/styles/chat-pane.css", "utf8");
const activityShelf = readFileSync("src/styles/activity-shelf.css", "utf8");
const component = readFileSync("src/features/split/ActivityShelf.tsx", "utf8");
const shelfMeasurement = readFileSync("src/features/split/useShelfAvailableSpace.ts", "utf8");

const HEADLESS_RULE = /(?:^|})([^{}]*\.th-activity-panel\[data-headless="true"\][^{}]*)\{([^}]*)\}/;
const HIDDEN_WHEN_HEADLESS = [
  ".th-activity-section-head",
  ".th-activity-dag-toolbar",
  ".th-activity-section > .th-activity-section-title",
] as const;

const panelSelector = '.th-activity-panel[data-headless="true"]';

const assertHeadlessSelectors = (css: string) => {
    const match = css.match(HEADLESS_RULE);
    expect(
      match,
      'activity-shelf.css must keep the .th-activity-panel[data-headless="true"] rule; ' +
        "it is the only hook that hides the header chrome when the measured panel runs out of room",
    ).not.toBeNull();
    const selectorList = (match?.[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
    const body = match?.[2] ?? "";
    const actualSelectors = new Set(
      selectorList.split(",").map((selector) => selector.replace(/\s+/g, " ").trim()),
    );
    const expectedSelectors = new Set(
      HIDDEN_WHEN_HEADLESS.map((selector) => `${panelSelector} ${selector}`),
    );
    expect(actualSelectors).toEqual(expectedSelectors);
    expect(
      /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(body),
      `the data-headless rule must hide each header row with display: none; found "${body.trim()}"`,
    ).toBe(true);
};

describe("activity shelf panel headroom contract", () => {
  it("hides the panel's section header rows via the data-headless attribute on the panel", () => {
    assertHeadlessSelectors(activityShelf);
  });

  it("rejects appended, removed, and prepended selector mutations", () => {
    const append = activityShelf.replace(panelSelector, `${panelSelector}, .unexpected-global`);
    const remove = activityShelf.replace(` ${HIDDEN_WHEN_HEADLESS[0]}`, "");
    const prepend = activityShelf.replace(panelSelector, `.unexpected-global, ${panelSelector}`);

    expect(() => assertHeadlessSelectors(append)).toThrow();
    expect(() => assertHeadlessSelectors(remove)).toThrow();
    expect(() => assertHeadlessSelectors(prepend)).toThrow();
  });

  it("keeps the pane-height proxy out of the stylesheet", () => {
    const maxHeightContainer = activityShelf.match(/@container[^{]*max-height[^{]*\{/);
    expect(
      maxHeightContainer,
      "activity-shelf.css must not hide headers through a @container max-height query; " +
        "pane height is not the invariant - the headless state comes from the panel's " +
        "measured headroom (data-headless set by ActivityShelf.tsx)",
    ).toBeNull();
  });

  it("measures the panel with a ResizeObserver wired to the named threshold constant", () => {
    const constant = component.match(/const\s+PANEL_HEADLESS_BELOW_PX\s*=\s*(\d+)\s*;/);
    expect(
      constant,
      "ActivityShelf.tsx must declare the PANEL_HEADLESS_BELOW_PX threshold constant",
    ).not.toBeNull();
    expect(
      constant?.[1],
      "PANEL_HEADLESS_BELOW_PX must stay 24: the column clamp reserves the panel's " +
        "target height in normal use, so headers survive until the panel box is " +
        "genuinely below one compact row (~24px)",
    ).toBe("24");
    expect(
      component,
      "ActivityShelf.tsx must consume the shared measured panel headroom",
    ).toContain("useShelfAvailableSpace(");
    expect(
      shelfMeasurement,
      "the shared shelf measurement path must use ResizeObserver for panel headroom",
    ).toContain("new ResizeObserver(");
    expect(
      component,
      "ActivityShelf.tsx must apply the measured state as data-headless on the panel element",
    ).toContain("data-headless={headless");
  });

  it("keeps .th-chat-pane a named inline-size container (width queries only)", () => {
    const container = chatPane
      .match(/\.th-chat-pane\s*\{([^}]*)\}/)?.[1]
      ?.match(/(?:^|;)\s*container\s*:\s*([^;}]*)/i)?.[1]
      ?.trim();
    expect(
      container,
      "chat-pane.css must keep the named chat-pane container; the width container queries in " +
        "chat-pane.css, activity-shelf.css, file-editor.css and file-browser.css resolve against it",
    ).toBe("chat-pane / inline-size");
  });
});
