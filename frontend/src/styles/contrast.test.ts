import { readFileSync } from "node:fs";
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

  const TEXT_TIERS = ["--th-text", "--th-text-dim", "--th-muted", "--th-faint"] as const;
  // DESIGN.md "Theme contract": every text tier is tested on every elevation
  // fill and every state fill it can land on, in both theme scopes.
  const ELEVATION_FILLS = ["--th-bg", "--th-surface", "--th-surface-raised", "--th-surface-overlay"] as const;
  const STATE_FILLS = ["--th-hover", "--th-active"] as const;
  const TEXT_BACKGROUNDS = [...ELEVATION_FILLS, ...STATE_FILLS] as const;
  const STATUS_TOKENS = ["--th-error", "--th-success", "--th-warning"] as const;
  const NORMAL_TEXT = 4.5;

  // Pairs that are intentionally NOT held to the matrix requirement. Each entry
  // must name a tier x surface pair above and carry a one-line reason; the
  // exemption test re-measures it so a fixed token forces promotion to REQUIRED.
  // Currently empty: the re-valued Raised fill lifts faint-on-raised above
  // 4.5:1 in both themes, so that former exemption is now an ordinary
  // REQUIRED pair inside the matrix below.
  const EXEMPTIONS: readonly (ContrastPair & { readonly reason: string })[] = [];

  const REQUIRED: readonly ContrastPair[] = [
    ...TEXT_TIERS.flatMap((fg) => TEXT_BACKGROUNDS.map((bg): ContrastPair => ({ fg, bg, ratio: NORMAL_TEXT }))),
    // Accent used as link or emphasis text on the elevation fills.
    ...ELEVATION_FILLS.map(
      (bg): ContrastPair => ({
        fg: "--th-accent",
        bg,
        ratio: NORMAL_TEXT,
        note: "accent used as link or emphasis text",
      }),
    ),
    { fg: "--th-accent-fg", bg: "--th-accent", ratio: NORMAL_TEXT, note: "Approve-button text and ::selection" },
    {
      fg: "--th-accent-fg",
      bg: "--th-accent-hover",
      ratio: NORMAL_TEXT,
      note: "the accent's hover state keeps its label legible",
    },
    {
      fg: "--th-send-fg",
      bg: "--th-send",
      ratio: 3,
      note:
        "the send control's visible content is an 18px SVG glyph and its text label is " +
        "screen-reader-only, so WCAG 2.1 1.4.11 non-text contrast (3:1) applies",
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
      names: ["--th-radius-sm", "--th-radius", "--th-radius-lg", "--th-radius-pill"],
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
      reason: "Motion timing is shared by every theme.",
      names: ["--th-ease", "--th-dur-fast", "--th-dur", "--th-dur-slow"],
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
});
