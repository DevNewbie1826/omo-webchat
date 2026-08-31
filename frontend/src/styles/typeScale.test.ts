import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Proves the user's font-size setting drives rendered text, not merely that
 * tokens exist.
 *
 * jsdom runs the real cascade - selector matching, specificity, stylesheet
 * order - so getComputedStyle returns each element's genuinely cascaded
 * value. What jsdom does not implement is var()/calc() evaluation, so this
 * file resolves only those two primitives itself: custom properties come from
 * the parsed :root rules via the CSSOM plus the inline --th-font-size the app
 * sets on <html> (src/app-config.ts), and calc() is the single multiplication
 * form the token block uses. Which declaration wins for each element always
 * comes from jsdom's computed style, never from assertions here.
 */

const STYLE_DIR = "src/styles";

/* import.meta.glob is expanded by Vite at test time, so a newly added .css
 * file joins the contract scan without this list changing. (The project's
 * node:fs types - src/vite-env.d.ts - export only readFileSync.) */
const cssFiles = (): string[] =>
  Object.keys(import.meta.glob("./*.css")).map((path) => path.slice(2));

const readStyle = (name: string): string => readFileSync(`${STYLE_DIR}/${name}`, "utf8");

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

type TierName = "display" | "title" | "input" | "body" | "secondary" | "label" | "micro";

type TierSpec = {
  /** Size multiplier of --th-font-size from the DESIGN.md type-scale table. */
  readonly factor: number;
  readonly line: number;
  readonly tracking: string;
};

/** The DESIGN.md "Type scale" table, transcribed once as the test oracle. */
const TIERS: Readonly<Record<TierName, TierSpec>> = {
  display: { factor: 1.7143, line: 1.15, tracking: "-0.025em" },
  title: { factor: 1.2857, line: 1.25, tracking: "-0.018em" },
  input: { factor: 1.1429, line: 1.4, tracking: "-0.008em" },
  body: { factor: 1, line: 1.6, tracking: "-0.005em" },
  secondary: { factor: 0.9286, line: 1.45, tracking: "0" },
  label: { factor: 0.8571, line: 1.35, tracking: "0.01em" },
  micro: { factor: 0.7857, line: 1.3, tracking: "0.02em" },
};

type Fixture = {
  readonly tier: TierName;
  /** Selector matching one representative element inside the fixture tree. */
  readonly selector: string;
  /** Weight the surface assigns via a token, or null when none is declared. */
  readonly weight: number | null;
};

/** One representative rendered element per tier, from real surfaces. */
const FIXTURES: readonly Fixture[] = [
  { tier: "display", selector: ".th-empty-title", weight: 590 },
  { tier: "title", selector: ".th-confirm-title", weight: 590 },
  { tier: "input", selector: ".th-chat-input textarea", weight: null },
  { tier: "body", selector: ".th-chat-msg", weight: null },
  { tier: "secondary", selector: ".th-tree-label", weight: null },
  { tier: "label", selector: ".th-tool-head", weight: 510 },
  { tier: "micro", selector: ".th-tool-status", weight: 510 },
];

const FIXTURE_HTML = `
  <div class="th-empty"><h1 class="th-empty-title">Empty</h1></div>
  <div class="th-confirm"><h2 class="th-confirm-title">Confirm</h2></div>
  <div class="th-chat-input"><textarea></textarea></div>
  <div class="th-chat-msg">Message prose</div>
  <div class="th-tree"><span class="th-tree-label">session</span></div>
  <div class="th-tool">
    <button type="button" class="th-tool-head">tool</button>
    <span class="th-tool-status">Done</span>
  </div>
`;

const VAR_PATTERN = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/;

/** Custom properties visible to an element: :root CSSOM rules, then the
 * inline chain from <html> down to the element (nearest wins). The app sets
 * --th-font-size inline on <html> from the user's setting, exactly as the
 * test does. */
function customPropertiesFor(el: Element): Map<string, string> {
  const props = new Map<string, string>();
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText !== "string" || styleRule.selectorText !== ":root") continue;
      for (let i = 0; i < styleRule.style.length; i++) {
        const name = styleRule.style[i] ?? "";
        if (name.startsWith("--")) props.set(name, styleRule.style.getPropertyValue(name).trim());
      }
    }
  }
  const chain: HTMLElement[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node instanceof HTMLElement) chain.unshift(node);
  }
  for (const node of chain) {
    for (let i = 0; i < node.style.length; i++) {
      const name = node.style[i] ?? "";
      if (name.startsWith("--")) props.set(name, node.style.getPropertyValue(name).trim());
    }
  }
  return props;
}

/** The element's cascaded value with var() substituted and cycles rejected. */
function resolveValue(el: Element, property: string): string {
  const raw = getComputedStyle(el).getPropertyValue(property).trim();
  if (raw === "") {
    throw new Error(`${property} is not set on <${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">`);
  }
  const props = customPropertiesFor(el);
  let out = raw;
  for (let depth = 0; VAR_PATTERN.test(out); depth++) {
    if (depth > 10) throw new Error(`var() cycle resolving "${raw}"`);
    out = out.replace(new RegExp(VAR_PATTERN.source, "g"), (match, name: string, fallback?: string) => {
      const value = props.get(name);
      if (value !== undefined && value !== "") return value;
      if (fallback !== undefined) return fallback.trim();
      throw new Error(`unresolvable custom property ${name} in "${raw}"`);
    });
  }
  return out.trim();
}

/** Resolves to a px number: a bare length or the token block's calc(Npx * M). */
function resolvePx(el: Element, property: string): number {
  const value = resolveValue(el, property);
  const calc = /^calc\(\s*(-?[\d.]+)px\s*\*\s*(-?[\d.]+)\s*\)$/.exec(value);
  if (calc) return Number(calc[1]) * Number(calc[2]);
  const px = /^(-?[\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`"${value}" is neither a px length nor the token block's calc() form`);
}

/** Mirrors src/app-config.ts: the font-size setting lands inline on <html>. */
const setFontSizeSetting = (px: number): void => {
  document.documentElement.style.setProperty("--th-font-size", `${px}px`);
};

describe("type scale computed from the user's font-size setting", () => {
  const STYLE_FILES = [
    "tokens.css",
    "global.css",
    "app-empty.css",
    "chat-composer.css",
    "chat-transcript.css",
    "confirm-dialog.css",
    "session-tree.css",
    "tool-card.css",
  ];

  let styleElements: HTMLStyleElement[] = [];
  let fixtureRoot: HTMLElement;

  beforeEach(() => {
    styleElements = STYLE_FILES.map((file) => {
      const el = document.createElement("style");
      el.textContent = readStyle(file);
      document.head.appendChild(el);
      return el;
    });
    fixtureRoot = document.createElement("div");
    fixtureRoot.innerHTML = FIXTURE_HTML;
    document.body.appendChild(fixtureRoot);
    setFontSizeSetting(13);
  });

  afterEach(() => {
    for (const el of styleElements) el.remove();
    styleElements = [];
    fixtureRoot.remove();
    document.documentElement.style.removeProperty("--th-font-size");
  });

  const elementFor = (fixture: Fixture): Element => {
    const el = fixtureRoot.querySelector(fixture.selector);
    if (!el) throw new Error(`fixture element ${fixture.selector} missing`);
    return el;
  };

  it("computes every tier's rendered size from --th-font-size as the DESIGN.md table specifies", () => {
    setFontSizeSetting(13);
    for (const fixture of FIXTURES) {
      const el = elementFor(fixture);
      const expected = 13 * TIERS[fixture.tier].factor;
      expect(resolvePx(el, "font-size"), `${fixture.tier} (${fixture.selector})`).toBeCloseTo(expected, 6);
    }
  });

  it("rescales every tier proportionally when the setting changes", () => {
    setFontSizeSetting(13);
    const before = FIXTURES.map((fixture) => resolvePx(elementFor(fixture), "font-size"));
    setFontSizeSetting(26);
    const after = FIXTURES.map((fixture) => resolvePx(elementFor(fixture), "font-size"));
    FIXTURES.forEach((fixture, index) => {
      const from = before[index] ?? 0;
      const to = after[index] ?? 0;
      expect(to, `${fixture.tier} must double when the setting doubles`).toBeCloseTo(from * 2, 6);
      expect(to, `${fixture.tier} at 26px base`).toBeCloseTo(26 * TIERS[fixture.tier].factor, 6);
    });
  });

  it("applies each tier as a complete style: size, line-height, tracking, and assigned weight", () => {
    setFontSizeSetting(16);
    for (const fixture of FIXTURES) {
      const el = elementFor(fixture);
      const spec = TIERS[fixture.tier];
      expect(resolvePx(el, "font-size"), fixture.tier).toBeCloseTo(16 * spec.factor, 6);
      expect(Number(resolveValue(el, "line-height")), `${fixture.tier} line-height`).toBeCloseTo(spec.line, 6);
      expect(resolveValue(el, "letter-spacing"), `${fixture.tier} tracking`).toBe(spec.tracking);
      if (fixture.weight !== null) {
        expect(Number(resolveValue(el, "font-weight")), `${fixture.tier} weight`).toBe(fixture.weight);
      }
    }
  });
});

describe("type scale token block", () => {
  const tokens = readStyle("tokens.css");

  it("declares every tier's size, line-height, and tracking exactly as the DESIGN.md table specifies", () => {
    for (const [tier, spec] of Object.entries(TIERS)) {
      const size = tier === "body" ? "var(--th-font-size)" : `calc(var(--th-font-size) * ${spec.factor})`;
      expect(tokens).toContain(`--th-type-${tier}-size: ${size};`);
      expect(tokens).toContain(`--th-type-${tier}-line: ${spec.line};`);
      expect(tokens).toContain(`--th-type-${tier}-tracking: ${spec.tracking};`);
    }
  });

  it("declares exactly the three text weights", () => {
    expect(tokens).toContain("--th-weight-read: 400;");
    expect(tokens).toContain("--th-weight-emphasize: 510;");
    expect(tokens).toContain("--th-weight-announce: 590;");
    expect(tokens.match(/--th-weight-[\w-]+:/g) ?? []).toHaveLength(3);
  });
});

describe("stylesheet type contracts", () => {
  const componentCss = cssFiles()
    .filter((file) => file !== "tokens.css")
    .map((file) => ({ file, css: stripComments(readStyle(file)) }));

  it("uses a named type tier for every font-size outside tokens.css", () => {
    const offenders: string[] = [];
    for (const { file, css } of componentCss) {
      for (const match of css.matchAll(/font-size\s*:\s*([^;}]+);/g)) {
        const value = (match[1] ?? "").trim();
        if (!/^var\(--th-type-(?:display|title|input|body|secondary|label|micro)-size\)$/.test(value)) {
          offenders.push(`${file}: font-size: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no raw px, rem, or em font-size outside tokens.css", () => {
    const offenders: string[] = [];
    for (const { file, css } of componentCss) {
      for (const match of css.matchAll(/font-size\s*:\s*[^;}]*[\d.]+\s*(?:px|rem|em)\b/g)) {
        offenders.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses only the three weight tokens for font-weight outside tokens.css", () => {
    const offenders: string[] = [];
    for (const { file, css } of componentCss) {
      for (const match of css.matchAll(/font-weight\s*:\s*([^;}]+);/g)) {
        const value = (match[1] ?? "").trim();
        if (!/^var\(--th-weight-(?:read|emphasize|announce)\)$/.test(value)) {
          offenders.push(`${file}: font-weight: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never sizes text through the font shorthand", () => {
    const offenders: string[] = [];
    for (const { file, css } of componentCss) {
      for (const match of css.matchAll(/(?:^|[{};])\s*font\s*:\s*([^;]+);/gm)) {
        const value = (match[1] ?? "").trim();
        if (value !== "inherit") offenders.push(`${file}: font: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
