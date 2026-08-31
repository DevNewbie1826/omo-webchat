/**
 * WCAG 2.1 contrast measurement over the raw text of tokens.css.
 *
 * Theme scopes are parsed generically: the `:root` block is the base theme and
 * every later block that declares custom properties (e.g. a future
 * `[data-theme="light"] { ... }`) is treated as an override layer over `:root`,
 * mirroring how the cascade resolves custom properties at runtime. Colour
 * values outside the understood formats - #rrggbb, rgb()/rgba(), var() of
 * another colour token, and the two-component color-mix() in srgb the theme
 * contract allows - throw instead of being skipped, so a theme that
 * introduces a new syntax fails here loudly rather than passing unmeasured.
 */

import postcss from "postcss";

export type Rgba = {
  /** Channels are 0-255; alpha is 0-1. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
};

export type ThemeScope = {
  /** Selector prelude as written, e.g. ":root" or "[data-theme=\"light\"]". */
  readonly selector: string;
  /** Tokens declared directly in this scope, before cascade inheritance. */
  readonly declaredTokens: Readonly<Record<string, string>>;
  /** Effective tokens: the scope's own declarations layered over `:root`. */
  readonly tokens: Readonly<Record<string, string>>;
};

const ROOT_SELECTOR = ":root";
const decodeCssIdentifier = (identifier: string): string =>
  identifier.replace(/\\([\da-f]{1,6}[\t\n\f\r ]?|.)/gis, (_escape, sequence: string) => {
    const hex = sequence.match(/^[\da-f]{1,6}/i)?.[0];
    if (hex === undefined) return sequence;
    const codePoint = Number.parseInt(hex, 16);
    return codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
  });
const HEX_PATTERN = /^#([\da-fA-F]{6})$/;
const RGB_PATTERN = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/;
const VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*\)$/;
const COLOR_MIX_PATTERN = /^color-mix\(\s*in\s+([\w-]+)\s*,\s*([\s\S]+)\)$/;
const MIX_PERCENT_PATTERN = /^(.*?)\s+(\d+(?:\.\d+)?)%$/;
const WHOLE_VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*\)$/i;
const BARE_COLOUR_KEYWORD_PATTERN = /^[a-z][\w-]*$/i;
const FUNCTION_PATTERN = /([a-z][\w-]*)\s*\(/gi;
const PROVABLY_NON_COLOUR_FUNCTIONS = new Set([
  "calc",
  "clamp",
  "cubic-bezier",
  "max",
  "min",
  "repeat",
  "steps",
]);

/**
 * Conservatively identifies custom-property values that may represent a
 * colour. Bare identifiers are treated as colours because CSS named colours
 * cannot be distinguished from other identifiers without an exhaustive,
 * brittle allow-list. Likewise, every function except syntax that is
 * provably non-colour is considered colour-bearing. Whole-value var() aliases
 * are resolved by the caller so semantic colour aliases retain their type.
 */
export function isColourTokenValue(value: string, resolveAlias?: (name: string) => boolean): boolean {
  const text = value.trim();
  if (text === "none") return true;
  const alias = WHOLE_VAR_PATTERN.exec(text);
  if (alias !== null) return resolveAlias?.(alias[1] ?? "") ?? false;
  if (/#[\da-f]{3,8}\b/i.test(text)) return true;
  if (BARE_COLOUR_KEYWORD_PATTERN.test(text)) return true;
  for (const match of text.matchAll(FUNCTION_PATTERN)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name !== "var" && !PROVABLY_NON_COLOUR_FUNCTIONS.has(name)) return true;
  }
  return false;
}

/** Fully transparent black; the channels are moot once alpha is 0. */
const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

type MixComponent = {
  readonly color: Rgba;
  readonly weight: number | undefined;
};

/** Splits on top-level commas, leaving commas inside parentheses alone. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * One color-mix() component: a colour (literal, `transparent`, or a var()
 * reference) with an optional percentage weight.
 */
function parseMixComponent(text: string, resolveToken: ((name: string) => Rgba) | undefined): MixComponent {
  const percent = MIX_PERCENT_PATTERN.exec(text);
  const colorText = (percent ? percent[1] : text) ?? "";
  const weight = percent ? Number(percent[2]) : undefined;
  if (weight !== undefined && (weight < 0 || weight > 100)) {
    throw new Error(`color-mix() percentage ${weight} is outside 0-100`);
  }
  if (colorText === "transparent") return { color: TRANSPARENT, weight };
  return { color: parseColor(colorText, resolveToken), weight };
}

/**
 * Resolves color-mix() in srgb per CSS Color 5: omitted weights default to
 * 50/50 (a single weight takes the remainder to 100), channels interpolate
 * in premultiplied form, and weights summing under 100 scale the result's
 * alpha. Other interpolation spaces (hsl, lab, ...) need polar/cylindrical
 * math the design system does not use, so they are a loud error, not a guess.
 */
function parseColorMix(space: string, body: string, resolveToken: ((name: string) => Rgba) | undefined): Rgba {
  if (space !== "srgb") {
    throw new Error(`unsupported color-mix() interpolation space "${space}": only srgb is understood`);
  }
  const components = splitTopLevel(body).map((part) => parseMixComponent(part, resolveToken));
  if (components.length !== 2) {
    throw new Error(`color-mix() takes exactly two components, got ${components.length}: "${body}"`);
  }
  const [first, second] = components as [MixComponent, MixComponent];
  // Omitted weights: both default to 50/50; a single weight's counterpart
  // takes the remainder to 100 (CSS Color 5).
  const secondWeight = second.weight ?? (first.weight === undefined ? 50 : 100 - first.weight);
  const firstWeight = first.weight ?? 100 - secondWeight;
  const sum = firstWeight + secondWeight;
  if (sum <= 0) {
    throw new Error("color-mix() percentages sum to zero: the result is undefined");
  }
  const alphaMultiplier = sum < 100 ? sum / 100 : 1;
  const firstShare = firstWeight / sum;
  const secondShare = secondWeight / sum;
  const mixedAlpha = firstShare * first.color.a + secondShare * second.color.a;
  if (mixedAlpha === 0) return TRANSPARENT;
  const channel = (firstChannel: number, secondChannel: number): number =>
    (firstShare * firstChannel * first.color.a + secondShare * secondChannel * second.color.a) / mixedAlpha;
  return {
    r: channel(first.color.r, second.color.r),
    g: channel(first.color.g, second.color.g),
    b: channel(first.color.b, second.color.b),
    a: mixedAlpha * alphaMultiplier,
  };
}

/**
 * Parses the colour forms the design system uses: #rrggbb, rgb()/rgba(),
 * `transparent` inside color-mix(), two-component color-mix() in srgb, and
 * var() of another colour token (when a resolver is given, as scopeColor
 * does). Anything else is a loud error.
 */
export function parseColor(value: string, resolveToken?: (name: string) => Rgba): Rgba {
  const text = value.trim();
  const hex = HEX_PATTERN.exec(text);
  if (hex) {
    const digits = hex[1] ?? "";
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = RGB_PATTERN.exec(text);
  if (rgb) {
    const color = {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
    if (color.r <= 255 && color.g <= 255 && color.b <= 255) return color;
  }
  const reference = VAR_PATTERN.exec(text);
  if (reference && resolveToken) return resolveToken(reference[1] ?? "");
  const mix = COLOR_MIX_PATTERN.exec(text);
  if (mix) return parseColorMix(mix[1] ?? "", mix[2] ?? "", resolveToken);
  throw new Error(
    `unsupported colour value "${value}": understood formats are #rrggbb, rgb()/rgba(), ` +
      "color-mix() in srgb, and var() of another colour token",
  );
}

/** Source-over composition of a translucent colour over an opaque backdrop. */
export function compositeOver(source: Rgba, backdrop: Rgba): Rgba {
  if (backdrop.a !== 1) {
    throw new Error("cannot composite over a translucent backdrop");
  }
  const channel = (foreground: number, background: number): number =>
    foreground * source.a + background * (1 - source.a);
  return {
    r: channel(source.r, backdrop.r),
    g: channel(source.g, backdrop.g),
    b: channel(source.b, backdrop.b),
    a: 1,
  };
}

const linearise = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** WCAG 2.1 relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linearise(color.r) + 0.7152 * linearise(color.g) + 0.0722 * linearise(color.b);
}

/** WCAG 2.1 contrast ratio, 1:1 (identical) through 21:1 (black on white). */
export function contrastRatio(first: Rgba, second: Rgba): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Splits a stylesheet into theme scopes. Every rule that declares custom
 * properties is examined; non-`:root` scopes inherit every `:root` token they
 * do not redeclare, as the cascade does. Conditional nested theme scopes are
 * rejected because flattening them would pretend a conditional declaration is
 * unconditional and cannot model which media/supports conditions are active.
 */
export function parseThemeScopes(css: string, sourceName?: string): readonly ThemeScope[] {
  const bySelector = new Map<string, Record<string, string>>();
  const stylesheet = postcss.parse(css, { from: sourceName });
  stylesheet.walkRules((rule) => {
    const declarations: Record<string, string> = {};
    rule.walkDecls((child) => {
      let nearestRule = child.parent;
      while (nearestRule !== undefined && nearestRule.type !== "rule" && nearestRule.type !== "root") {
        nearestRule = nearestRule.parent;
      }
      // An outer rule's walk also visits declarations owned by nested rules;
      // leave each declaration to its nearest rule so it is recorded once.
      if (nearestRule !== rule) return;
      const name = decodeCssIdentifier(child.prop.trim());
      if (!name.startsWith("--")) return;
      const atRules: string[] = [];
      let ancestor = child.parent;
      while (ancestor !== undefined && ancestor.type !== "root") {
        if (ancestor.type === "atrule") atRules.push(`@${ancestor.name}`);
        ancestor = ancestor.parent;
      }
      if (atRules.length > 0) {
        const file = child.source?.input.file ?? sourceName ?? "<css>";
        const line = child.source?.start?.line ?? "?";
        throw new Error(
          `${file}:${line}: ${name} theme declaration in ${rule.selector.trim()} is nested inside ` +
            `${atRules.join(" inside ")}; theme scopes must be top-level`,
        );
      }
      declarations[name] = child.value.trim();
    });
    if (Object.keys(declarations).length === 0) return;
    const selector = rule.selector.trim();
    bySelector.set(selector, { ...bySelector.get(selector), ...declarations });
  });
  if (!bySelector.has(ROOT_SELECTOR)) {
    throw new Error(`no ${ROOT_SELECTOR} theme scope found`);
  }
  const base = bySelector.get(ROOT_SELECTOR) ?? {};
  return Array.from(bySelector, ([selector, declaredTokens]) => ({
    selector,
    declaredTokens,
    tokens: selector === ROOT_SELECTOR ? declaredTokens : { ...base, ...declaredTokens },
  }));
}

/**
 * Resolves one token to a colour, naming the scope and token on failure.
 * var() references - bare or inside color-mix() - are followed through the
 * scope's effective tokens; a reference cycle throws instead of recursing
 * forever.
 */
export function scopeColor(scope: ThemeScope, token: string): Rgba {
  const value = scope.tokens[token];
  if (value === undefined) {
    throw new Error(`${scope.selector} does not define ${token}`);
  }
  const resolving = new Set<string>([token]);
  const resolveReference = (name: string): Rgba => {
    const referenced = scope.tokens[name];
    if (referenced === undefined) {
      throw new Error(`${scope.selector} does not define ${name} (referenced via var() from ${token})`);
    }
    if (resolving.has(name)) {
      throw new Error(`${scope.selector}: circular var() reference to ${name}`);
    }
    resolving.add(name);
    try {
      return parseColor(referenced, resolveReference);
    } finally {
      resolving.delete(name);
    }
  };
  try {
    return parseColor(value, resolveReference);
  } catch (error) {
    throw new Error(`${scope.selector} ${token}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Contrast ratio of a foreground token on a background token. When either side
 * is translucent, `overToken` names the opaque backdrop it is composed over
 * first; omitting it is an error, since a bare ratio against a translucent
 * colour would be confident nonsense.
 */
export function pairRatio(scope: ThemeScope, fgToken: string, bgToken: string, overToken?: string): number {
  let foreground = scopeColor(scope, fgToken);
  let background = scopeColor(scope, bgToken);
  if (foreground.a < 1 || background.a < 1) {
    if (overToken === undefined) {
      throw new Error(
        `${scope.selector}: ${fgToken} on ${bgToken} is translucent; name the backdrop token it is composed over`,
      );
    }
    const backdrop = scopeColor(scope, overToken);
    if (background.a < 1) background = compositeOver(background, backdrop);
    if (foreground.a < 1) foreground = compositeOver(foreground, background);
  }
  return contrastRatio(foreground, background);
}
