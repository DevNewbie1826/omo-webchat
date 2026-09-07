import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// Regression contracts for the active-pane outline (C1). The pane's
// .th-pane--focused class is routing identity: App's nonsplit path and
// SplitView apply it, PaneResize resolves it, and pane-routing tests count
// it. At viewport widths <=768px only the painted outline is suppressed;
// desktop split indication and every keyboard focus affordance stay.
// Assertions read current disk bytes so runs observe shipped CSS, matching
// styleContracts.test.ts.
const splitPath = "src/styles/split-view.css";
const root = postcss.parse(readFileSync(splitPath, "utf8"), { from: splitPath });

const topLevelRules = (): postcss.Rule[] =>
  root.nodes.filter((node): node is postcss.Rule => node.type === "rule");

const topLevelMedia = (params: string): postcss.AtRule[] =>
  root.nodes.filter((node): node is postcss.AtRule => node.type === "atrule" && node.name === "media")
    .filter((atRule) => atRule.params.replace(/\s+/g, " ").trim() === params);

const rulesFor = (nodes: readonly postcss.ChildNode[] | undefined, selector: string): postcss.Rule[] =>
  (nodes ?? []).filter((node): node is postcss.Rule =>
    node.type === "rule" && node.selector.replace(/\s+/g, " ").trim() === selector);

const rulesIn = (nodes: readonly postcss.ChildNode[] | undefined): postcss.Rule[] =>
  (nodes ?? []).filter((node): node is postcss.Rule => node.type === "rule");

const declaration = (rule: postcss.Rule, property: string): postcss.Declaration | undefined =>
  rule.nodes.filter((node): node is postcss.Declaration => node.type === "decl")
    .find((node) => node.prop.toLowerCase() === property.toLowerCase());

const isOutlineNone = (rule: postcss.Rule): boolean =>
  ["outline", "outline-style"].some((property) => declaration(rule, property)?.value.replace(/\s+/g, " ").trim() === "none");

describe("mobile active-pane outline contracts", () => {
  it("keeps the desktop active-pane outline on the base focused-pane rule", () => {
    const [base] = rulesFor(topLevelRules(), ".th-pane--focused");
    expect(base).toBeDefined();
    const outline = declaration(base!, "outline")?.value ?? "";
    expect(outline).toContain("1px");
    expect(outline).toContain("var(--th-border-strong)");
    expect(declaration(base!, "outline-offset")?.value.trim()).toBe("-1px");
  });

  it("suppresses the outline inside the inclusive 768px width query only", () => {
    const mobile = topLevelMedia("(max-width: 768px)");
    const suppressions = mobile.flatMap((atRule) => rulesFor(atRule.nodes, ".th-pane--focused"))
      .filter(isOutlineNone);
    expect(suppressions).toHaveLength(1);
    // Every at-rule outside that query leaves the focused outline painted.
    const outside = root.nodes
      .filter((node): node is postcss.AtRule => node.type === "atrule" && node.name === "media")
      .filter((atRule) => !mobile.includes(atRule))
      .flatMap((atRule) => rulesFor(atRule.nodes, ".th-pane--focused"));
    expect(outside.every((rule) => !isOutlineNone(rule))).toBe(true);
  });

  it("does not suppress the outline behind a pointer media query", () => {
    const pointerSuppressions = root.nodes
      .filter((node): node is postcss.AtRule => node.type === "atrule" && node.name === "media")
      .filter((atRule) => atRule.params.includes("pointer"))
      .flatMap((atRule) => rulesFor(atRule.nodes, ".th-pane--focused"))
      .filter(isOutlineNone);
    expect(pointerSuppressions).toEqual([]);
  });

  it("suppresses only outline declarations so pane identity and geometry survive", () => {
    const [suppression] = topLevelMedia("(max-width: 768px)")
      .flatMap((atRule) => rulesFor(atRule.nodes, ".th-pane--focused"));
    expect(suppression).toBeDefined();
    const properties = suppression!.nodes
      .filter((node): node is postcss.Declaration => node.type === "decl")
      .map((node) => node.prop.toLowerCase());
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.every((property) => /^outline(-[\w-]+)?$/.test(property))).toBe(true);
  });

  it("leaves split-view keyboard focus affordances painted", () => {
    const dividerFocus = topLevelRules().find((rule) => rule.selector.includes(".th-divider:focus"));
    expect(dividerFocus).toBeDefined();
    expect(declaration(dividerFocus!, "background")?.value).toBe("var(--th-accent)");
    const menuFocus = topLevelRules().find((rule) => rule.selector.includes(".th-pane-resize-menu button:focus"));
    expect(menuFocus).toBeDefined();
    expect(declaration(menuFocus!, "outline")?.value).toContain("var(--th-border-strong)");
    const focusRulesInMobileQuery = topLevelMedia("(max-width: 768px)")
      .flatMap((atRule) => rulesIn(atRule.nodes))
      .filter((rule) => rule.selector.includes(":focus"));
    expect(focusRulesInMobileQuery).toEqual([]);
  });
});
