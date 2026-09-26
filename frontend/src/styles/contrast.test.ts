import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  isColourTokenValue,
  pairRatio,
  parseColor,
  parseThemeScopes,
  relativeLuminance,
  scopeColor,
  valueReferencesCustomProperty,
} from "./contrast";
import type { ThemeScope } from "./contrast";

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("test invariant violated");
  return value;
};

describe("contrast utilities", () => {
  it("parses the colour formats tokens.css actually uses", () => {
    expect(parseColor("#0a0a0a")).toEqual({ r: 10, g: 10, b: 10, a: 1 });
    expect(parseColor("#ededed")).toEqual({ r: 237, g: 237, b: 237, a: 1 });
    expect(parseColor("rgba(229, 72, 77, 0.12)")).toEqual({ r: 229, g: 72, b: 77, a: 0.12 });
    expect(parseColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("conservatively identifies colour token values without a syntax allow-list", () => {
    expect(isColourTokenValue("hsl(0, 100%, 50%)")).toBe(true);
    expect(isColourTokenValue("hsla(0, 100%, 50%, 0.5)")).toBe(true);
    expect(isColourTokenValue("rebeccapurple")).toBe(true);
    expect(isColourTokenValue("oklch(60% 0.2 20)")).toBe(true);
    expect(isColourTokenValue("calc(var(--th-font-size) * 1.2)")).toBe(false);
    expect(isColourTokenValue("14px")).toBe(false);
    expect(isColourTokenValue("var(--th-alias)", (name) => name === "--th-alias")).toBe(true);
  });

  it("resolves the color-mix() forms the design system uses", () => {
    // activity-shelf.css recreates --th-success-bg as exactly this mix.
    const recreated = parseColor("color-mix(in srgb, #30a46c 12%, transparent)");
    expect(recreated.r).toBeCloseTo(48, 6);
    expect(recreated.g).toBeCloseTo(164, 6);
    expect(recreated.b).toBeCloseTo(108, 6);
    expect(recreated.a).toBeCloseTo(0.12, 6);
    // Two opaque colours at explicit weights: premultiplied srgb interpolation.
    expect(parseColor("color-mix(in srgb, #000000 25%, #ffffff 75%)")).toEqual({
      r: 191.25,
      g: 191.25,
      b: 191.25,
      a: 1,
    });
    // No weights defaults to 50/50.
    expect(parseColor("color-mix(in srgb, #000000, #ffffff)")).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    // Weights summing under 100% scale the result's alpha (CSS Color 5).
    const translucent = parseColor("color-mix(in srgb, rgb(255, 0, 0) 30%, rgb(0, 0, 255) 30%)");
    expect(translucent.r).toBeCloseTo(127.5, 6);
    expect(translucent.b).toBeCloseTo(127.5, 6);
    expect(translucent.a).toBeCloseTo(0.6, 6);
  });

  it("resolves var() references inside color-mix() through the theme scope", () => {
    const scope = must(
      parseThemeScopes(`
        :root { --th-hue: #30a46c; --th-tint: color-mix(in srgb, var(--th-hue) 12%, transparent); }
      `)[0],
    );
    const resolved = scopeColor(scope, "--th-tint");
    expect(resolved.r).toBeCloseTo(48, 6);
    expect(resolved.g).toBeCloseTo(164, 6);
    expect(resolved.b).toBeCloseTo(108, 6);
    expect(resolved.a).toBeCloseTo(0.12, 6);
  });

  it("fails loudly on var() reference cycles instead of recursing forever", () => {
    const scope = must(
      parseThemeScopes(":root { --th-a: var(--th-b); --th-b: var(--th-a); }")[0],
    );
    expect(() => scopeColor(scope, "--th-a")).toThrow(/circular var\(\) reference/);
  });

  it("fails loudly on color-mix() forms outside the understood subset", () => {
    expect(() => parseColor("color-mix(in hsl, #30a46c 12%, transparent)")).toThrow(/interpolation space/);
    expect(() => parseColor("color-mix(in srgb, #30a46c 12%, #ffffff, #000000)")).toThrow(/exactly two/);
    expect(() => parseColor("color-mix(in srgb, transparent 0%, transparent 0%)")).toThrow(/sum/);
    // var() with no resolver (a bare parseColor call) stays a loud error.
    expect(() => parseColor("color-mix(in srgb, var(--th-hue) 12%, transparent)")).toThrow(
      /unsupported colour value/,
    );
  });

  it("composites a translucent colour over its stated backdrop before measuring", () => {
    const tint = parseColor("rgba(229, 72, 77, 0.12)");
    const surface = parseColor("#141414");
    const composed = compositeOver(tint, surface);
    expect(composed.a).toBe(1);
    expect(composed.r).toBeCloseTo(45.08, 2);
    expect(composed.g).toBeCloseTo(26.24, 2);
    expect(composed.b).toBeCloseTo(26.84, 2);
    // Endpoints: fully transparent yields the backdrop, opaque yields the source.
    expect(compositeOver({ ...tint, a: 0 }, surface)).toEqual(surface);
    expect(compositeOver({ ...tint, a: 1 }, surface).r).toBe(229);
  });

  it("computes WCAG 2.1 relative luminance and contrast ratio", () => {
    expect(relativeLuminance(parseColor("#000000"))).toBe(0);
    expect(relativeLuminance(parseColor("#ffffff"))).toBeCloseTo(1, 6);
    expect(contrastRatio(parseColor("#000000"), parseColor("#ffffff"))).toBeCloseTo(21, 6);
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000000"))).toBeCloseTo(21, 6);
    expect(contrastRatio(parseColor("#7f7f7f"), parseColor("#7f7f7f"))).toBeCloseTo(1, 6);
  });

  it("layers later theme scopes over :root the way the cascade would", () => {
    const scopes = parseThemeScopes(`
      :root { --th-bg: #0a0a0a; --th-text: #ededed; }
      [data-theme="light"] { --th-bg: #fafafa; }
    `);
    expect(scopes.map((scope) => scope.selector)).toEqual([":root", '[data-theme="light"]']);
    const light = must(scopes[1]);
    expect(light.tokens["--th-bg"]).toBe("#fafafa");
    // Not overridden: inherited from :root, as the cascade resolves it at runtime.
    expect(light.tokens["--th-text"]).toBe("#ededed");
    expect(light.declaredTokens["--th-text"]).toBeUndefined();
    expect(light.declaredTokens["--th-bg"]).toBe("#fafafa");
  });

  it("rejects theme declarations nested in media rules with source details", () => {
    expect(() =>
      parseThemeScopes(
        `:root { --th-bg: #000000; }
@media (min-width: 0px) {
  :root {
    --th-oracle-nested-theme: rebeccapurple;
  }
}`,
        "oracle.css",
      ),
    ).toThrow("oracle.css:4: --th-oracle-nested-theme theme declaration in :root is nested inside @media");
  });

  it("rejects theme declarations nested in supports rules", () => {
    expect(() =>
      parseThemeScopes(
        `:root { --th-bg: #000000; }
@supports (display: grid) {
  :root { --th-oracle-supports: rebeccapurple; }
}`,
        "oracle.css",
      ),
    ).toThrow("oracle.css:3: --th-oracle-supports theme declaration in :root is nested inside @supports");
  });

  it("rejects declarations directly inside an at-rule nested in a theme rule", () => {
    expect(() =>
      parseThemeScopes(
        `:root {
  --th-bg: #000000;
  @media (min-width: 0px) {
    --th-oracle-direct-nested: rebeccapurple;
  }
}`,
        "oracle.css",
      ),
    ).toThrow("oracle.css:4: --th-oracle-direct-nested theme declaration in :root is nested inside @media");
  });

  it("rejects theme declarations at arbitrary at-rule depth", () => {
    expect(() =>
      parseThemeScopes(
        `:root { --th-bg: #000000; }
@media (min-width: 0px) {
  @supports (display: grid) {
    :root { --th-oracle-deep: rebeccapurple; }
  }
}`,
        "oracle.css",
      ),
    ).toThrow("oracle.css:4: --th-oracle-deep theme declaration in :root is nested inside @supports inside @media");
  });

  it("parses final declarations without semicolons in every theme scope", () => {
    const scopes = parseThemeScopes(`
      :root {
        --th-bg: #000000;
        /* A final declaration may legally omit its semicolon. */
        --th-oracle-final: rebeccapurple
      }
      [data-theme="light"] {
        --th-bg: #ffffff;
        --th-oracle-final:
          rebeccapurple
      }
    `);
    expect(must(scopes[0]).declaredTokens["--th-oracle-final"]).toBe("rebeccapurple");
    expect(must(scopes[1]).declaredTokens["--th-oracle-final"]).toBe("rebeccapurple");
  });

  it("ignores commented-out declarations", () => {
    const scopes = parseThemeScopes(":root { --th-bg: #000000; /* --th-bg: #ffffff; */ }");
    expect(must(scopes[0]).tokens["--th-bg"]).toBe("#000000");
  });

  it("normalises escaped custom-property names before recording declarations", () => {
    const scope = must(parseThemeScopes(String.raw`:root { --th-oracle\2d plain: 42; }`)[0]);
    expect(scope.declaredTokens["--th-oracle-plain"]).toBe("42");
  });

  it("fails loudly on colour syntaxes it does not understand", () => {
    expect(() => parseColor("#abc")).toThrow(/unsupported colour value/);
    expect(() => parseColor("hsl(0, 0%, 50%)")).toThrow(/unsupported colour value/);
    expect(() => parseColor("var(--th-bg)")).toThrow(/unsupported colour value/);
    expect(() => parseColor("rgba(300, 0, 0, 0.5)")).toThrow(/unsupported colour value/);
  });

  it("refuses to measure a translucent pair with no stated backdrop", () => {
    const scope = must(parseThemeScopes(":root { --th-tint: rgba(0, 0, 0, 0.5); --th-text: #ffffff; }")[0]);
    expect(() => pairRatio(scope, "--th-text", "--th-tint")).toThrow(/backdrop/);
  });

  it("names the token when a scope does not define it", () => {
    const scope = must(parseThemeScopes(":root { --th-bg: #000000; }")[0]);
    expect(() => scopeColor(scope, "--th-text")).toThrow(/--th-text/);
  });

  it("parses var() references instead of matching one literal spelling", () => {
    expect(valueReferencesCustomProperty("var(--th-faint)", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("var( --th-faint )", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("var(--th-faint, currentColor)", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("var( --th-faint, currentColor )", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("var(--th-text, var(--th-faint))", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("var(--th-text, var( --th-faint ))", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("color-mix(in srgb, var(--th-faint) 40%, transparent)", "--th-faint")).toBe(
      true,
    );
    expect(valueReferencesCustomProperty("VAR(--th-faint)", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty("var(/*c*/--th-faint)", "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty(String.raw`var(--th-\66 aint)`, "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty(String.raw`var(--th-\000066aint)`, "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty(String.raw`v\61 r(--th-faint)`, "--th-faint")).toBe(true);
    expect(valueReferencesCustomProperty('"var(--th-faint)"', "--th-faint")).toBe(false);
    expect(valueReferencesCustomProperty("'var(--th-faint)'", "--th-faint")).toBe(false);
    expect(valueReferencesCustomProperty("/* var(--th-faint) */ var(--th-text)", "--th-faint")).toBe(false);
    expect(valueReferencesCustomProperty("var(--th-text)", "--th-faint")).toBe(false);
    expect(valueReferencesCustomProperty("var(--th-faint-extra)", "--th-faint")).toBe(false);
    // A comment between the name and "(" is whitespace, so this is not a var() function.
    expect(valueReferencesCustomProperty("var/*c*/(--th-faint)", "--th-faint")).toBe(false);
  });
});

describe("token contrast contracts (WCAG 2.1)", () => {
  type ContrastPair = {
    readonly fg: string;
    readonly bg: string;
    /** Backdrop a translucent fg/bg is composed over before measuring. */
    readonly over?: string;
    readonly ratio: number;
    readonly note?: string;
  };

  // v2 contract: the three reading tiers hold the 4.5:1 matrix on every
  // elevation fill and every state fill in both theme scopes. The fourth
  // tier, --th-faint, is METADATA ONLY: it holds a separate 3.0:1 rule on
  // the fills metadata can land on, and the usage allowlist further down
  // restricts it to enumerated metadata selectors.
  const TEXT_TIERS = ["--th-text", "--th-text-dim", "--th-muted"] as const;
  // The composer capsule and the user bubble are elevation fills in their own
  // right (placeholder, queued text, and steer rows land on them).
  const ELEVATION_FILLS = [
    "--th-bg", "--th-surface", "--th-surface-composer", "--th-surface-raised",
    "--th-surface-user", "--th-surface-overlay",
    // Scoped tool material: tool title, preview, status word, and status hues
    // land on it in both disclosure states and both themes.
    "--th-tool-surface",
  ] as const;
  const STATE_FILLS = ["--th-hover", "--th-active"] as const;
  const TEXT_BACKGROUNDS = [...ELEVATION_FILLS, ...STATE_FILLS] as const;
  // The fills metadata (timestamps, counts, hints) actually lands on.
  const FAINT_FILLS = [
    "--th-bg", "--th-surface", "--th-surface-composer", "--th-surface-raised",
    "--th-tool-surface",
  ] as const;
  // The violet accent is legible as text on the canvas and body surfaces;
  // state and user fills sit too close to it for 4.5:1.
  const ACCENT_TEXT_FILLS = ["--th-bg", "--th-surface"] as const;
  const STATUS_TOKENS = ["--th-error", "--th-success", "--th-warning"] as const;
  const NORMAL_TEXT = 4.5;

  // Pairs that are intentionally NOT held to the matrix requirement. Each entry
  // must name a tier x surface pair above and carry a one-line reason; the
  // exemption test re-measures it so a fixed token forces promotion to REQUIRED.
  // Currently empty: the v2 matrix holds every tier on every fill.
  const EXEMPTIONS: readonly (ContrastPair & { readonly reason: string })[] = [];

  const REQUIRED: readonly ContrastPair[] = [
    ...TEXT_TIERS.flatMap((fg) => TEXT_BACKGROUNDS.map((bg): ContrastPair => ({ fg, bg, ratio: NORMAL_TEXT }))),
    // The metadata tier holds >=3.0:1 on the fills it can land on.
    ...FAINT_FILLS.map(
      (bg): ContrastPair => ({
        fg: "--th-faint",
        bg,
        ratio: 3,
        note: "--th-faint is METADATA ONLY; the usage allowlist below restricts it to metadata selectors",
      }),
    ),
    // Accent used as link or emphasis text on the canvas and body surfaces.
    ...ACCENT_TEXT_FILLS.map(
      (bg): ContrastPair => ({
        fg: "--th-accent",
        bg,
        ratio: NORMAL_TEXT,
        note: "accent used as link or emphasis text",
      }),
    ),
    {
      fg: "--th-accent",
      bg: "--th-surface-raised",
      ratio: NORMAL_TEXT,
      note: "accent used as emphasis or glyph on raised cards and menus",
    },
    {
      fg: "--th-accent-fg",
      bg: "--th-accent-solid",
      ratio: NORMAL_TEXT,
      note: "filled-control labels (send, primary buttons, toggles) on the accent-solid fill",
    },
    {
      fg: "--th-accent-fg",
      bg: "--th-accent-solid-hover",
      ratio: NORMAL_TEXT,
      note: "filled-control labels keep 4.5:1 while hovered",
    },
    {
      fg: "--th-send-fg",
      bg: "--th-send",
      ratio: NORMAL_TEXT,
      note: "the send control's white label and glyph on the accent-solid fill",
    },
    {
      fg: "--th-send-fg",
      bg: "--th-send-hover",
      ratio: 3,
      note:
        "the send control's visible content is an 18px SVG glyph and its text label is " +
        "screen-reader-only, so WCAG 2.1 1.4.11 non-text contrast (3:1) applies",
    },
    {
      fg: "--th-error-fg",
      bg: "--th-error",
      ratio: NORMAL_TEXT,
      note: "text on solid --th-error action fills, including the composer's Stop control",
    },
    // Status hues used as text: legible on every elevation fill they may land on.
    ...STATUS_TOKENS.flatMap((fg) =>
      ELEVATION_FILLS.map(
        (bg): ContrastPair => ({ fg, bg, ratio: NORMAL_TEXT, note: "status hue used as text" }),
      ),
    ),
    {
      fg: "--th-error",
      bg: "--th-error-bg",
      over: "--th-surface",
      ratio: NORMAL_TEXT,
      note: "activity-shelf error chip: status tint composed over the bar's --th-surface",
    },
    {
      fg: "--th-warning",
      bg: "--th-warning-bg",
      over: "--th-surface",
      ratio: NORMAL_TEXT,
      note: "activity-shelf running chip: status tint composed over the bar's --th-surface",
    },
    {
      fg: "--th-success",
      bg: "--th-success-bg",
      over: "--th-surface",
      ratio: NORMAL_TEXT,
      note: "activity-shelf done chip: status tint composed over the bar's --th-surface",
    },
  ];

  const isExempt = (fg: string, bg: string): boolean =>
    EXEMPTIONS.some((exemption) => exemption.fg === fg && exemption.bg === bg);
  const requiredPairs = REQUIRED.filter((pair) => !isExempt(pair.fg, pair.bg));

  const describePair = (pair: ContrastPair): string =>
    `${pair.fg} on ${pair.bg}${pair.over ? ` over ${pair.over}` : ""}`;

  // Every block in tokens.css that declares custom properties is a theme scope;
  // [data-theme="light"] is picked up here with no scope-specific code.
  const rawCss = readFileSync("src/styles/tokens.css", "utf8");
  const scopes: readonly ThemeScope[] = parseThemeScopes(rawCss, "tokens.css");

  // Raw body of each scope block (comments stripped) for declaration-level
  // checks: what a scope itself declares, not what it inherits from :root.
  const scopeBodies = new Map<string, string>();
  for (const block of rawCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    scopeBodies.set((block[1] ?? "").trim(), block[2] ?? "");
  }
  const declaredValues = (selector: string): Map<string, string> =>
    new Map(Object.entries(scopes.find((scope) => scope.selector === selector)?.declaredTokens ?? {}));

  // These tokens are intentionally theme-independent and therefore belong to
  // :root alone. Names are explicit: adding any other one-sided declaration
  // fails parity by default. Each category carries the reason for its members.
  const THEME_PARITY_EXEMPTIONS = [
    {
      reason: "Corner geometry is shared by every theme.",
      names: [
        "--th-radius-xs", "--th-radius-sm", "--th-radius", "--th-radius-lg",
        "--th-radius-xl", "--th-radius-pill",
      ],
    },
    {
      reason: "The font and type hierarchy is shared by every theme.",
      names: [
        "--th-font-mono", "--th-font-sans", "--th-font-size",
        "--th-type-display-size", "--th-type-display-line", "--th-type-display-tracking",
        "--th-type-title-size", "--th-type-title-line", "--th-type-title-tracking",
        "--th-type-input-size", "--th-type-input-line", "--th-type-input-tracking",
        "--th-type-body-size", "--th-type-body-line", "--th-type-body-tracking",
        "--th-type-secondary-size", "--th-type-secondary-line", "--th-type-secondary-tracking",
        "--th-type-label-size", "--th-type-label-line", "--th-type-label-tracking",
        "--th-type-micro-size", "--th-type-micro-line", "--th-type-micro-tracking",
        "--th-weight-read", "--th-weight-emphasize", "--th-weight-announce",
      ],
    },
    {
      reason: "The spacing scale is shared by every theme.",
      names: [
        "--th-space-0", "--th-space-0-5", "--th-space-1", "--th-space-2", "--th-space-3",
        "--th-space-4", "--th-space-5", "--th-space-6", "--th-space-8", "--th-space-9",
        "--th-space-11", "--th-space-12",
      ],
    },
    {
      reason: "Structural dimensions are shared by every theme.",
      names: ["--th-sidebar-w", "--th-header-h", "--th-node-h"],
    },
    {
      reason: "Motion timing and easing are shared by every theme.",
      names: [
        "--th-ease", "--th-ease-out", "--th-ease-in-out", "--th-ease-spring",
        "--th-dur-fast", "--th-dur", "--th-dur-slow", "--th-dur-emph",
      ],
    },
  ] as const;
  const parityExemptionNames = new Set<string>(THEME_PARITY_EXEMPTIONS.flatMap((exemption) => exemption.names));

  // A colour token is DERIVED from the file, never from a hand-maintained
  // syntax or name list. Values are treated as colours unless their syntax is
  // provably non-colour; whole-value var() aliases inherit the referenced
  // token's classification. This remains useful for the separate contract
  // that override scopes contain colour values only; parity does not use it.
  const colourTokenNames = (selector: string): Set<string> => {
    const values = declaredValues(selector);
    const isColour = (name: string, seen: ReadonlySet<string>): boolean => {
      const value = values.get(name);
      if (value === undefined || seen.has(name)) return false;
      return isColourTokenValue(value, (alias) => isColour(alias, new Set([...seen, name])));
    };
    const names = new Set<string>();
    for (const name of values.keys()) {
      if (isColour(name, new Set())) names.add(name);
    }
    return names;
  };

  it("finds a :root theme scope defining every token the pairs reference", () => {
    expect(scopes.length).toBeGreaterThan(0);
    const root = scopes.find((scope) => scope.selector === ":root");
    expect(root).toBeDefined();
    const referenced = new Set<string>();
    for (const pair of [...REQUIRED, ...EXEMPTIONS]) {
      referenced.add(pair.fg);
      referenced.add(pair.bg);
      if (pair.over) referenced.add(pair.over);
    }
    const missing = [...referenced].filter((token) => root?.tokens[token] === undefined);
    expect(missing).toEqual([]);
  });

  it("keeps exemptions inside the text-tier matrix they carve out of", () => {
    const matrix = new Set(TEXT_TIERS.flatMap((fg) => TEXT_BACKGROUNDS.map((bg) => `${fg}|${bg}`)));
    const stray = EXEMPTIONS.filter((exemption) => !matrix.has(`${exemption.fg}|${exemption.bg}`)).map(describePair);
    expect(stray).toEqual([]);
  });

  it("holds every required pair at or above its ratio in every theme scope", () => {
    const failures: string[] = [];
    for (const scope of scopes) {
      for (const pair of requiredPairs) {
        const measured = pairRatio(scope, pair.fg, pair.bg, pair.over);
        if (measured < pair.ratio) {
          failures.push(
            `[${scope.selector}] ${describePair(pair)}: ${measured.toFixed(2)}:1 < required ` +
              `${pair.ratio.toFixed(1)}:1${pair.note ? ` (${pair.note})` : ""}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // --th-faint is the METADATA-ONLY tier (the >=3.0:1 rule above). Every
  // selector that paints any property with it must be enumerated here with
  // its metadata role; a new usage fails the allowlist test until it is
  // either classified as metadata or re-tiered to --th-muted/--th-text-dim.
  // The stale check fails when an entry no longer uses the token, so the
  // list cannot silently rot. Readable prose, including expanded reasoning,
  // is not metadata and is not listed.
  const FAINT_METADATA_ALLOWLIST: Readonly<Record<string, string>> = {
    ".th-settings-label": "settings section label",
    ".th-login-foot": "login footer hint line",
    ".th-input::placeholder": "input placeholder hint",
    ".th-activity-bar-sep": "activity bar middot separator glyph",
    ".th-tree-chevron": "session-tree disclosure chevron icon",
    ".th-tree-source": "session-tree source badge",
    ".th-files-chevron": "file-tree disclosure chevron icon",
    ".th-files-childstatus": "file-tree child status metadata",
    ".th-files-meta--dim": "file-row dim metadata",
    ".th-tool-chevron": "tool record disclosure chevron icon",
    ".th-tool-sep": "tool record separator glyph",
    ".th-tool-caption": "tool record caption (timings/metadata)",
    ".th-picker-pane-title": "new-chat pane label",
  };

  type FaintUsage = {
    readonly file: string;
    readonly selector: string;
    readonly prop: string;
    readonly line: number | undefined;
  };

  const ruleOf = (declaration: postcss.Declaration): postcss.Rule | undefined => {
    let node = declaration.parent as postcss.Container | undefined;
    while (node !== undefined) {
      if (node.type === "rule") return node as postcss.Rule;
      node = node.parent as postcss.Container | undefined;
    }
    return undefined;
  };

  const collectFaintUsages = (css: string, file: string): FaintUsage[] => {
    const usages: FaintUsage[] = [];
    postcss.parse(css, { from: file }).walkDecls((declaration) => {
      if (!valueReferencesCustomProperty(declaration.value, "--th-faint")) return;
      usages.push({
        file,
        selector: ruleOf(declaration)?.selector.trim() ?? "",
        prop: declaration.prop,
        line: declaration.source?.start?.line,
      });
    });
    return usages;
  };

  const faintUsageViolations = (usages: readonly FaintUsage[]): string[] =>
    usages.flatMap((usage) =>
      FAINT_METADATA_ALLOWLIST[usage.selector] === undefined
        ? [
            `${usage.file}:${usage.line ?? "?"}: selector "${usage.selector}" paints ${usage.prop} ` +
              "with --th-faint but is not in FAINT_METADATA_ALLOWLIST",
          ]
        : [],
    );

  it("restricts --th-faint to an explicit allowlist of metadata selectors", () => {
    const stylesheetPaths = Object.keys(import.meta.glob("./*.css"));
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const path of stylesheetPaths) {
      const file = path.slice(2);
      const css = readFileSync(`src/styles/${file}`, "utf8");
      const usages = collectFaintUsages(css, file);
      for (const usage of usages) seen.add(usage.selector);
      violations.push(...faintUsageViolations(usages));
    }
    for (const selector of Object.keys(FAINT_METADATA_ALLOWLIST)) {
      if (!seen.has(selector)) {
        violations.push(`FAINT_METADATA_ALLOWLIST: "${selector}" no longer uses --th-faint; remove the stale entry`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("rejects whitespace var() syntax that paints body prose with --th-faint", () => {
    const usages = collectFaintUsages(".th-chat-markdown p { color: var( --th-faint ); }\n", "prose.css");
    expect(faintUsageViolations(usages)).toEqual([
      'prose.css:1: selector ".th-chat-markdown p" paints color with --th-faint but is not in FAINT_METADATA_ALLOWLIST',
    ]);
  });

  it("rejects fallback var() syntax that paints body prose with --th-faint", () => {
    const usages = collectFaintUsages(
      ".th-chat-markdown p { color: var(--th-faint, currentColor); }\n",
      "prose.css",
    );
    expect(faintUsageViolations(usages)).toEqual([
      'prose.css:1: selector ".th-chat-markdown p" paints color with --th-faint but is not in FAINT_METADATA_ALLOWLIST',
    ]);
  });

  it("rejects a nested var() reference that paints body prose with --th-faint", () => {
    const usages = collectFaintUsages(
      ".th-chat-markdown p { color: var(--th-text, var( --th-faint )); }\n",
      "prose.css",
    );
    expect(faintUsageViolations(usages)).toEqual([
      'prose.css:1: selector ".th-chat-markdown p" paints color with --th-faint but is not in FAINT_METADATA_ALLOWLIST',
    ]);
  });

  it("allows enumerated metadata selectors to use --th-faint", () => {
    const usages = collectFaintUsages(
      [
        ".th-tree-source { color: var(--th-faint); }",
        ".th-tree-chevron { border: 1px solid var(--th-faint); }",
        ".th-login-foot { color: var( --th-faint ); }",
        ".th-input::placeholder { color: var(--th-faint, currentColor); }",
      ].join("\n"),
      "metadata.css",
    );
    expect(usages.map((usage) => usage.selector)).toEqual([
      ".th-tree-source",
      ".th-tree-chevron",
      ".th-login-foot",
      ".th-input::placeholder",
    ]);
    expect(faintUsageViolations(usages)).toEqual([]);
  });

  it("does not treat a string spelling of var(--th-faint) as metadata paint", () => {
    const usages = collectFaintUsages(
      '.th-chat-markdown p { content: "var(--th-faint)"; color: var(--th-text); }\n',
      "prose.css",
    );
    expect(usages).toEqual([]);
  });

  it("measures the foreground and fill tokens requested by real error and disabled controls", () => {
    const componentPairs = [
      ["form-controls.css", ".th-btn--danger", "--th-error-fg", "--th-error"],
      ["chat-composer.css", ".th-chat-input .th-btn--danger", "--th-error-fg", "--th-error"],
      ["form-controls.css", ".th-btn:disabled", "--th-disabled-fg", "--th-disabled-bg"],
      ["session-tree.css", ".th-tree-node--disabled", "--th-disabled-fg", "--th-disabled-bg"],
      ["session-tree.css", ".th-tree-more:disabled", "--th-disabled-fg", "--th-disabled-bg"],
      ["new-chat-dialog.css", ".th-provider-card:has(input:disabled)", "--th-disabled-fg", "--th-disabled-bg"],
      ["settings-menu.css", ".th-settings-size-btn:disabled", "--th-disabled-fg", "--th-disabled-bg"],
    ] as const;
    const failures: string[] = [];
    for (const [file, selector, expectedFg, expectedBg] of componentPairs) {
      const css = readFileSync(`src/styles/${file}`, "utf8");
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      const fg = body.match(/(?:^|;)\s*color:\s*var\((--[\w-]+)\)/)?.[1] ?? "";
      const bg = body.match(/(?:^|;)\s*background:\s*var\((--[\w-]+)\)/)?.[1] ?? "";
      if (fg !== expectedFg || bg !== expectedBg) {
        failures.push(`${file} ${selector} requests ${fg || "no foreground"} on ${bg || "no fill"}, expected ${expectedFg} on ${expectedBg}`);
        continue;
      }
      for (const scope of scopes) {
        const measured = pairRatio(scope, fg, bg);
        if (measured < NORMAL_TEXT) failures.push(`[${scope.selector}] ${file} ${selector}: ${measured.toFixed(2)}:1 < 4.5:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("ships a light theme scope layered over :root", () => {
    expect(scopes.some((scope) => scope.selector === '[data-theme="light"]')).toBe(true);
  });

  it("declares exactly the same non-exempt custom property names in every theme scope", () => {
    const root = scopes.find((scope) => scope.selector === ":root");
    const base = new Set(Object.keys(root?.declaredTokens ?? {}).filter((name) => !parityExemptionNames.has(name)));
    const drift: string[] = [];
    for (const scope of scopes) {
      if (scope.selector === ":root") continue;
      const own = new Set(Object.keys(scope.declaredTokens).filter((name) => !parityExemptionNames.has(name)));
      for (const name of base) {
        if (!own.has(name)) drift.push(`tokens.css: ${name} is declared in :root but missing from ${scope.selector}`);
      }
      for (const name of own) {
        if (!base.has(name)) drift.push(`tokens.css: ${name} is declared in ${scope.selector} but missing from :root`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps every theme-parity exemption explicit, reasoned, and root-only", () => {
    const rootNames = new Set(Object.keys(scopes.find((scope) => scope.selector === ":root")?.declaredTokens ?? {}));
    const failures: string[] = [];
    for (const exemption of THEME_PARITY_EXEMPTIONS) {
      if (exemption.reason.length === 0) failures.push("theme-parity exemption has no reason");
      for (const name of exemption.names) {
        if (!rootNames.has(name)) failures.push(`${name} is a stale theme-parity exemption`);
        for (const scope of scopes) {
          if (scope.selector !== ":root" && scope.declaredTokens[name] !== undefined) {
            failures.push(`${name} is exempt from parity but declared in ${scope.selector}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("limits non-:root scopes to re-valuing colour tokens", () => {
    // Geometry, type, radius, and motion tokens stay shared in :root.
    const stray: string[] = [];
    for (const scope of scopes) {
      if (scope.selector === ":root") continue;
      const colours = colourTokenNames(scope.selector);
      for (const name of declaredValues(scope.selector).keys()) {
        if (!colours.has(name)) stray.push(`${scope.selector} declares non-colour token ${name}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("sets color-scheme inside each theme scope so native controls follow the theme", () => {
    expect(scopeBodies.get(":root") ?? "").toMatch(/color-scheme:\s*dark/);
    expect(scopeBodies.get('[data-theme="light"]') ?? "").toMatch(/color-scheme:\s*light/);
  });

  it("measures the activity-shelf chip's recreated success tint instead of skipping it", () => {
    // activity-shelf.css rebuilds --th-success-bg with a raw color-mix() - the
    // one component-side token recreation in the codebase. Resolve that exact
    // expression in every theme scope, prove it still equals the token, and
    // hold the chip's foreground-on-recreated-fill pair to the same 4.5:1
    // contract as the token pair it stands in for.
    const shelf = readFileSync("src/styles/activity-shelf.css", "utf8");
    const recreation = /\.th-activity-chip--ok\s*\{[^}]*?background:\s*([^;]+);/.exec(shelf)?.[1]?.trim();
    expect(recreation).toBeDefined();
    expect(recreation ?? "").toContain("color-mix(");
    const failures: string[] = [];
    for (const scope of scopes) {
      const recreated = parseColor(recreation ?? "", (name) => scopeColor(scope, name));
      const token = scopeColor(scope, "--th-success-bg");
      for (const channel of ["r", "g", "b", "a"] as const) {
        if (Math.abs(recreated[channel] - token[channel]) > 1e-6) {
          failures.push(
            `[${scope.selector}] recreated chip tint ${channel}=${recreated[channel]} ` +
              `!= --th-success-bg ${token[channel]}: the recreation drifted from the token`,
          );
        }
      }
      const withRecreation: ThemeScope = {
        selector: scope.selector,
        declaredTokens: scope.declaredTokens,
        tokens: { ...scope.tokens, "--th-success-bg-recreated": recreation ?? "" },
      };
      const measured = pairRatio(withRecreation, "--th-success", "--th-success-bg-recreated", "--th-surface");
      if (measured < NORMAL_TEXT) {
        failures.push(
          `[${scope.selector}] --th-success on recreated chip tint: ${measured.toFixed(2)}:1 < required 4.5:1`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps every exemption measured, reasoned, and still below its required ratio", () => {
    const stale: string[] = [];
    for (const exemption of EXEMPTIONS) {
      expect(exemption.reason.length).toBeGreaterThan(0);
      for (const scope of scopes) {
        const measured = pairRatio(scope, exemption.fg, exemption.bg, exemption.over);
        if (measured >= exemption.ratio) {
          stale.push(
            `[${scope.selector}] ${describePair(exemption)} now measures ${measured.toFixed(2)}:1 ` +
              `(>= ${exemption.ratio.toFixed(1)}:1): the exemption is stale - delete it and add the pair to REQUIRED`,
          );
        }
      }
    }
    expect(stale).toEqual([]);
  });

  // Token contract v2 (.omo/plans/visual-redesign-tokens.md): the values
  // below are contract pins, not captured measurements. Fills pin exact
  // hexes; derived roles pin ordering contracts instead of invented hexes.
  const REFERENCE_SURFACES = {
    canvas: { token: "--th-bg", light: "#ffffff", dark: "#17181b" },
    "sidebar/top-bar surface": { token: "--th-surface", light: "#f7f7f8", dark: "#1d1e22" },
    "composer capsule": { token: "--th-surface-composer", light: "#ffffff", dark: "#232429" },
    "raised card/menu fallback": { token: "--th-surface-raised", light: "#ffffff", dark: "#25262b" },
    "hover state": { token: "--th-hover", light: "#f1f1f3", dark: "#2c2d33" },
    "primary text": { token: "--th-text", light: "#18181b", dark: "#ededf0" },
  } as const;

  const hexChannels = (hex: string): number[] =>
    (hex.match(/\w\w/g) ?? []).map((channel) => parseInt(channel, 16));

  it("pins every contract reference surface in both theme scopes", () => {
    const failures: string[] = [];
    for (const [label, reference] of Object.entries(REFERENCE_SURFACES)) {
      for (const [selector, expected] of [
        [":root", reference.dark],
        ['[data-theme="light"]', reference.light],
      ] as const) {
        const scope = must(scopes.find((candidate) => candidate.selector === selector));
        const got = scopeColor(scope, reference.token);
        const want = hexChannels(expected);
        const drifted = [got.r, got.g, got.b].some((channel, i) => Math.abs(channel - must(want[i])) > 0.5) || got.a !== 1;
        if (drifted) {
          failures.push(`[${selector}] ${reference.token} (${label}): ` +
            `rgb(${got.r}, ${got.g}, ${got.b}) != reference ${expected}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // The composer send control is the accent-solid filled control: the same
  // solid violet in both themes with a white glyph, so the label and glyph
  // hold 4.5:1 (white on the lighter --th-accent text violet would not).
  const PRIMARY_ACTION = {
    "--th-send": { light: "#6d5bd0", dark: "#6d5bd0" },
    "--th-send-fg": { light: "#ffffff", dark: "#ffffff" },
  } as const;

  it("pins the send control to the accent-solid fill with its white glyph", () => {
    const failures: string[] = [];
    for (const [token, expected] of Object.entries(PRIMARY_ACTION)) {
      for (const [selector, hex] of [
        [":root", expected.dark],
        ['[data-theme="light"]', expected.light],
      ] as const) {
        const scope = must(scopes.find((candidate) => candidate.selector === selector));
        const got = scopeColor(scope, token);
        const want = hexChannels(hex);
        const drifted =
          [got.r, got.g, got.b].some((channel, i) => Math.abs(channel - must(want[i])) > 0.5) || got.a !== 1;
        if (drifted) {
          failures.push(`[${selector}] ${token}: rgb(${got.r}, ${got.g}, ${got.b}) != measured primary action ${hex}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // The v2 shadow roles are literal contract values in both themes (the
  // measured-none idiom retired with the Codex reference).
  const REFERENCE_SHADOWS = {
    "--th-shadow-surface": {
      dark: "0 1px 2px rgba(0, 0, 0, 0.28), 0 4px 12px rgba(0, 0, 0, 0.16)",
      light: "0 1px 2px rgba(24, 24, 27, 0.04), 0 4px 12px rgba(24, 24, 27, 0.05)",
    },
    "--th-shadow-raised": {
      dark: "0 2px 6px rgba(0, 0, 0, 0.24), 0 10px 28px -8px rgba(0, 0, 0, 0.45)",
      light: "0 1px 3px rgba(24, 24, 27, 0.06), 0 10px 28px -10px rgba(24, 24, 27, 0.14)",
    },
    "--th-shadow-overlay": {
      dark: "0 8px 20px rgba(0, 0, 0, 0.30), 0 28px 64px -16px rgba(0, 0, 0, 0.60)",
      light: "0 8px 20px rgba(24, 24, 27, 0.08), 0 28px 64px -16px rgba(24, 24, 27, 0.22)",
    },
  } as const;

  it("pins the v2 shadow roles to their contract values in both themes", () => {
    const squash = (value: string): string => value.replace(/\s+/g, " ").trim();
    const failures: string[] = [];
    for (const [token, expected] of Object.entries(REFERENCE_SHADOWS)) {
      for (const [selector, value] of [
        [":root", expected.dark],
        ['[data-theme="light"]', expected.light],
      ] as const) {
        const scope = must(scopes.find((candidate) => candidate.selector === selector));
        const got = squash(scope.tokens[token] ?? "");
        if (got !== squash(value)) {
          failures.push(`[${selector}] ${token}: '${got}' != contract value '${squash(value)}'`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the send hover a visible step from the send fill in both themes", () => {
    const failures: string[] = [];
    for (const scope of scopes) {
      const base = relativeLuminance(scopeColor(scope, "--th-send"));
      const hover = relativeLuminance(scopeColor(scope, "--th-send-hover"));
      if (hover === base) {
        failures.push(`[${scope.selector}] --th-send-hover must differ from --th-send`);
        continue;
      }
      // Hover deepens toward the darker violet in both themes so the white
      // label keeps 4.5:1 while hovered; the step must be perceptible.
      const direction = hover < base && (base + 0.05) / (hover + 0.05) >= 1.1;
      if (!direction) {
        failures.push(`[${scope.selector}] --th-send-hover is not a visible step from --th-send`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps border tiers at the contract hairline alpha mixes", () => {
    const failures: string[] = [];
    const expected = [
      [":root", "--th-border-surface", 0.06, [255, 255, 255]],
      [":root", "--th-border-strong", 0.10, [255, 255, 255]],
      [":root", "--th-tool-border", 0.06, [255, 255, 255]],
      ['[data-theme="light"]', "--th-border-surface", 0.07, [24, 24, 27]],
      ['[data-theme="light"]', "--th-border-strong", 0.12, [24, 24, 27]],
      ['[data-theme="light"]', "--th-tool-border", 0.06, [24, 24, 27]],
    ] as const;
    for (const [selector, token, alpha, tint] of expected) {
      const scope = must(scopes.find((candidate) => candidate.selector === selector));
      const got = scopeColor(scope, token);
      if (Math.abs(got.a - alpha) > 0.006 || [got.r, got.g, got.b].some((channel, i) => Math.abs(channel - must(tint[i])) > 0.5)) {
        failures.push(`[${selector}] ${token}: rgba(${got.r}, ${got.g}, ${got.b}, ${got.a}) != ` +
          `the contract ${alpha} alpha over rgb(${tint.join(", ")})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("pins the glass, backdrop, and highlight tokens to their contract values", () => {
    const failures: string[] = [];
    const translucent = [
      [":root", "--th-glass", "rgba(38, 39, 44, 0.72)"],
      ['[data-theme="light"]', "--th-glass", "rgba(255, 255, 255, 0.72)"],
      [":root", "--th-backdrop", "rgba(10, 10, 12, 0.55)"],
      ['[data-theme="light"]', "--th-backdrop", "rgba(24, 24, 27, 0.24)"],
    ] as const;
    for (const [selector, token, expected] of translucent) {
      const scope = must(scopes.find((candidate) => candidate.selector === selector));
      const got = scopeColor(scope, token);
      const want = parseColor(expected);
      const channelDrift = [got.r - want.r, got.g - want.g, got.b - want.b].some((drift) => Math.abs(drift) > 0.5);
      if (channelDrift || Math.abs(got.a - want.a) > 0.006) {
        failures.push(`[${selector}] ${token}: rgba(${got.r}, ${got.g}, ${got.b}, ${got.a}) != ${expected}`);
      }
    }
    const squash = (value: string): string => value.replace(/\s+/g, " ").trim();
    const filters = [
      [":root", "blur(20px) saturate(1.5)"],
      ['[data-theme="light"]', "blur(20px) saturate(1.8)"],
    ] as const;
    for (const [selector, expected] of filters) {
      const scope = must(scopes.find((candidate) => candidate.selector === selector));
      const got = squash(scope.tokens["--th-glass-filter"] ?? "");
      if (got !== expected) failures.push(`[${selector}] --th-glass-filter: '${got}' != '${expected}'`);
    }
    const highlights = [
      [":root", "inset 0 1px 0 rgba(255, 255, 255, 0.05)"],
      ['[data-theme="light"]', "inset 0 1px 0 rgba(255, 255, 255, 0.7)"],
    ] as const;
    for (const [selector, expected] of highlights) {
      const scope = must(scopes.find((candidate) => candidate.selector === selector));
      const got = squash(scope.tokens["--th-highlight"] ?? "");
      if (got !== squash(expected)) failures.push(`[${selector}] --th-highlight: '${got}' != '${squash(expected)}'`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps derived roles ordered inside the contract hierarchy", () => {
    const failures: string[] = [];
    const luminance = (scope: ThemeScope, token: string): number => {
      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
      };
      const color = scopeColor(scope, token);
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const dark = must(scopes.find((scope) => scope.selector === ":root"));
    // Dark lifts by luminance steps: tool shares surface, overlay shares
    // raised, then surface < composer < raised < user < hover < active.
    if (luminance(dark, "--th-tool-surface") !== luminance(dark, "--th-surface")) {
      failures.push("[dark] --th-tool-surface must equal --th-surface");
    }
    if (luminance(dark, "--th-surface-overlay") !== luminance(dark, "--th-surface-raised")) {
      failures.push("[dark] --th-surface-overlay must equal --th-surface-raised");
    }
    for (const [below, above] of [
      ["--th-surface", "--th-surface-composer"],
      ["--th-surface-composer", "--th-surface-raised"],
      ["--th-surface-raised", "--th-surface-user"],
      ["--th-surface-user", "--th-hover"],
      ["--th-hover", "--th-active"],
    ] as const) {
      if (luminance(dark, above) <= luminance(dark, below)) {
        failures.push(`[dark] ${above} must sit one visible step above ${below}`);
      }
    }
    const light = must(scopes.find((scope) => scope.selector === '[data-theme="light"]'));
    // Light: canvas, composer, raised, and overlay hold pure white; surface
    // and tool sit one whisper below; user and hover share one grey step
    // further down; active steps below that.
    if (luminance(light, "--th-bg") !== 1) {
      failures.push("[light] --th-bg must stay white");
    }
    for (const token of ["--th-surface-composer", "--th-surface-raised", "--th-surface-overlay"]) {
      if (luminance(light, token) !== 1) {
        failures.push(`[light] ${token} must stay at the contract white`);
      }
    }
    if (luminance(light, "--th-tool-surface") !== luminance(light, "--th-surface")) {
      failures.push("[light] --th-tool-surface must equal --th-surface");
    }
    if (luminance(light, "--th-surface") >= luminance(light, "--th-bg")) {
      failures.push("[light] --th-surface must sit one whisper below the white canvas");
    }
    if (luminance(light, "--th-surface-user") >= luminance(light, "--th-surface")) {
      failures.push("[light] --th-surface-user must sit below --th-surface");
    }
    if (luminance(light, "--th-hover") !== luminance(light, "--th-surface-user")) {
      failures.push("[light] --th-hover shares the user's grey step (#f1f1f3)");
    }
    if (luminance(light, "--th-active") >= luminance(light, "--th-hover")) {
      failures.push("[light] --th-active must darken --th-hover");
    }
    expect(failures).toEqual([]);
  });
});
