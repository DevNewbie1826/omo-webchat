/** Visual-redesign QA probes: pure helpers + in-page measurement functions.
 *
 * Governing sources (binding):
 *   .omo/plans/visual-redesign.md         - QA scenarios S1..S22
 *   .omo/plans/visual-redesign-tokens.md  - token contract v2
 *
 * Layout of this module:
 *   1. Pure helpers (parseColor, contrast, compositing, motion allowlist,
 *      border classification). Unit-tested by visual-redesign-probes.test.mjs
 *      under `bun test`. They are plain function declarations so their
 *      .toString() can be injected into a browser page as executable source.
 *   2. pageKit(): concatenated source of every helper an in-page probe needs.
 *      The CLI evaluates `new Function(pageKit() + probeSource)` inside the
 *      real page, so colour math has exactly one implementation shared by the
 *      unit tests and the browser probes.
 *   3. In-page probe functions (probeTokens, probeSeparation, ...). They may
 *      only reference DOM APIs and names injected by pageKit() - never module
 *      imports or closures - because they are serialized into the page.
 *   4. SCENARIOS registry with stub declarations for the tasks that own them.
 *
 * Scenario orchestration (fixture choice, clicks, screenshots) lives in
 * visual-redesign.mjs; this module stays free of playwright imports.
 */

/** Pinned canvas + accent per theme (token contract v2; QA S1). */
export const THEME_EXPECTATIONS = Object.freeze({
  dark: { bg: '#17181b', accent: '#8b7cf6' },
  light: { bg: '#ffffff', accent: '#6d5bd0' },
});

/** Pre-redesign hexes that must disappear from every computed colour (S19).
 * Mirrors the list inlined in isOldPaletteColor: that function is
 * serialized into the page by pageKit(), where this module constant does
 * not exist. The unit test drives isOldPaletteColor over every hex here, so
 * the two lists cannot drift apart silently. */
export const OLD_PALETTE_HEXES = Object.freeze(['#181818', '#282828', '#2d2d2d', '#dfdfdf']);

/** Minimum luminance separation between --th-text and --th-muted (S3). */
export const HIERARCHY_MIN_RATIO = 1.8;

/** Text contrast floors (S19; token contract: faint is metadata-only at 3:1). */
export const CONTRAST_BODY_MIN = 4.5;
export const CONTRAST_FAINT_MIN = 3.0;

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

/** Parse a CSS colour string into {r,g,b,a} (0-255 channels, alpha 0-1).
 * Accepts #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba() in comma or modern
 * slash syntax (incl. percentages), color(srgb ...) and `transparent`.
 * Returns null for `none`, `currentcolor`, `inherit` and anything unparsable,
 * so callers decide how to treat unresolvable colours. */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (!s || s === 'none' || s === 'currentcolor' || s === 'inherit') return null;
  const clamp01 = v => Math.min(1, Math.max(0, v));
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map(c => parseInt(c + c, 16));
      return { r, g, b, a: h.length === 4 ? clamp01(a / 255) : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? clamp01(parseInt(h.slice(6, 8), 16) / 255) : 1,
      };
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const chan = p => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha = p => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
    const r = chan(parts[0]), g = chan(parts[1]), b = chan(parts[2]);
    const a = parts.length > 3 ? alpha(parts[3]) : 1;
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r, g, b, a: clamp01(a) };
  }
  m = /^color\((srgb|srgb-linear)\s+([^)]+)\)$/.exec(s);
  if (m) {
    if (m[1] !== 'srgb') return null;
    const parts = m[2].split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const chan = p => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p) * 255);
    const alpha = p => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
    const r = chan(parts[0]), g = chan(parts[1]), b = chan(parts[2]);
    const a = parts.length > 3 ? alpha(parts[3]) : 1;
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r, g, b, a: clamp01(a) };
  }
  return null;
}

/** WCAG 2.x relative luminance of an opaque colour (alpha ignored - callers
 * composite semi-transparent layers onto their backdrop first). */
export function relativeLuminance(color) {
  if (!color) return null;
  const channel = v => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio between two (already composited) colours. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` painted over `bottom` (source-over). Both {r,g,b,a}. */
export function compositeOver(top, bottom) {
  if (!top || !bottom) return null;
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** Normalized #rrggbb form (alpha dropped) for measurements/reports. */
export function hexOf(color) {
  if (!color) return null;
  const part = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** Colour equality with small tolerance for rounding in computed styles. */
export function colorEquals(a, b, tolerance = 1.5) {
  if (!a || !b) return false;
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance
    && Math.abs(a.b - b.b) <= tolerance && Math.abs(a.a - b.a) <= 0.02;
}

/** True when the colour is opaque and identical to a pre-redesign hex (S19).
 * Semi-transparent variants are ignored: only fully painted colours count.
 * The hex list is INLINED, not read from OLD_PALETTE_HEXES: this function is
 * serialized into the page by pageKit(), where module constants do not
 * exist (defect D6). The self-containment unit test fails any injected
 * function that references a name the page never receives. */
export function isOldPaletteColor(input) {
  const parsed = typeof input === 'string' ? parseColor(input) : input;
  if (!parsed || parsed.a < 0.999) return false;
  return ['#181818', '#282828', '#2d2d2d', '#dfdfdf'].some(hex => colorEquals(parsed, parseColor(hex), 0.5));
}

/** Contract motion allowlist: compositor-friendly properties plus the
 * documented hover-colour and disclosure (grid-template-rows) exceptions,
 * plus visibility: a discrete property that only times the hide/show flip
 * paired with an opacity/transform fade and never interpolates. */
export function defaultMotionAllowed() {
  return ['transform', 'opacity', 'filter', 'clip-path', 'stroke-dashoffset', 'background-position',
    'color', 'background-color', 'border-color', 'box-shadow', 'grid-template-rows', 'visibility'];
}

export function normalizeMotionProperty(property) {
  // Web Animations keyframes report camelCase names (strokeDashoffset,
  // backgroundPositionX); some serializers lowercase them with the hyphens
  // stripped. Convert both back to the CSS property name before matching.
  const kebab = String(property).trim().replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  const aliases = new Map([
  'transform', 'opacity', 'filter', 'clip-path', 'stroke-dashoffset', 'background-position',
  'background-position-x', 'background-position-y', 'border-color', 'background-color', 'color',
  'box-shadow', 'translate', 'scale', 'rotate', 'offset-distance', 'stroke-dasharray',
].map(name => [name.replace(/-/g, ''), name]));
  const name = kebab.includes('-') ? kebab : (aliases.get(kebab) ?? kebab);
  // Chrome reports per-side longhands for shorthands: a transition declared as
  // border-color animates as border-top-color/border-right-color/... Map them
  // back onto the contract's border-color entry.
  if (/^border-(top|right|bottom|left)-color$/.test(name)) return 'border-color';
  // Keyframe longhands of background-position are reported as
  // background-position-x/-y (some engines drop the hyphens).
  if (/^background-?position-?[xy]$/.test(name)) return 'background-position';
  return name;
}

/** Disallowed animated property names within `properties` (may be a list of
 * comma-joined transition shorthands). `all` is reported as a violation
 * because it cannot be proven to stay inside the allowlist. */
export function motionViolations(properties, allowed) {
  const allow = new Set((allowed ?? defaultMotionAllowed()).map(normalizeMotionProperty));
  const out = [];
  for (const raw of properties ?? []) {
    for (const p of String(raw).split(',').map(normalizeMotionProperty).filter(Boolean)) {
      if (p === 'all') out.push('all (enumerate animated properties explicitly)');
      else if (!allow.has(p)) out.push(p);
    }
  }
  return [...new Set(out)];
}

/** Border classification over synthetic facts (unit-testable core of S4).
 * facts: [{ excluded, parentIndex, sides: [{width, color:{a}} x4] }, ...]
 * parentIndex MUST refer to a position within the SAME array - callers that
 * filter the array have to remap indices first (see probeSeparation).
 * Excluded facts (form fields, focus-ring owners) count neither as bordered
 * nor as bordered ancestors. The ancestor walk carries a cycle guard so bad
 * input can never spin the caller. */
export function classifyBorderFacts(facts) {
  const bordered = new Set();
  facts.forEach((fact, index) => {
    if (fact.excluded) return;
    if ((fact.sides ?? []).some(side => side.width > 0 && side.color && side.color.a > 0.02)) bordered.add(index);
  });
  const nested = [];
  for (const index of bordered) {
    const visited = new Set([index]);
    let parent = facts[index].parentIndex;
    while (parent !== -1 && parent !== null && parent !== undefined) {
      if (visited.has(parent)) break;
      visited.add(parent);
      if (bordered.has(parent)) { nested.push(index); break; }
      parent = facts[parent] ? facts[parent].parentIndex : -1;
    }
  }
  return { borderedCount: bordered.size, nestedBorderedCount: nested.length, bordered: [...bordered], nested };
}

/** Uppercase-label scan core (S5): counts elements with computed
 * text-transform uppercase that carry visible text. */
export function uppercaseOf(facts) {
  const hits = [];
  (facts ?? []).forEach((fact, index) => {
    if (fact.textTransform === 'uppercase' && typeof fact.text === 'string' && fact.text.trim().length > 0) {
      hits.push(index);
    }
  });
  return { uppercaseCount: hits.length, uppercase: hits };
}

/** Longest transition/animation duration in a CSS duration list, in ms. */
export function maxDurationMs(list) {
  let max = 0;
  for (const raw of String(list ?? '').split(',')) {
    const s = raw.trim();
    if (!s || s === 'none' || s === 'initial') continue;
    const value = s.endsWith('ms') ? parseFloat(s) : parseFloat(s) * 1000;
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/** A viewport capture is valid only at the document's left edge with no
 * document-level horizontal overflow. Internal scrollports do not count. */
export function pagePanVerdict(facts) {
  const failures = [];
  const where = facts.offender ?? 'document.scrollingElement';
  if (facts.scrollX !== 0 || facts.scrollLeft !== 0) {
    failures.push(`horizontal document pan at ${where}: window.scrollX=${facts.scrollX}, scrollingElement.scrollLeft=${facts.scrollLeft} (active: ${facts.active})`);
  }
  if (facts.scrollWidth > facts.innerWidth + 1) {
    failures.push(`horizontal document overflow at ${where}: scrollWidth=${facts.scrollWidth} > innerWidth=${facts.innerWidth} + 1`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// 2. Page kit
// ---------------------------------------------------------------------------

/** Source text injected ahead of every in-page probe. Collects the pure
 * helpers plus DOM-reading helpers the probes share. */
export function pageKit() {
  return [
    parseColor, relativeLuminance, contrastRatio, compositeOver, hexOf, colorEquals,
    isOldPaletteColor, motionViolations, normalizeMotionProperty, defaultMotionAllowed,
    classifyBorderFacts, uppercaseOf, maxDurationMs, describeElement, isVisibleElement,
    tokenColor, collectAnimations, runningGlyphSelectors,
  ].map(fn => fn.toString()).join('\n');
}

export function describeElement(element) {
  if (!element || !(element instanceof Element)) return 'unknown';
  const cls = (typeof element.className === 'string' ? element.className : '').trim().split(/\s+/)[0] ?? '';
  const id = element.id ? `#${element.id}` : '';
  return `${element.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}`;
}

export function isVisibleElement(element) {
  if (!element || element.nodeType !== 1) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}

/** The real DOM facts checked immediately before every screenshot. Identify
 * the widest visible element if an overflow is present, and name the active
 * element when focus has caused the document itself to pan. */
export function probePagePan() {
  const innerWidth = window.innerWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  let offender = null;
  if (scrollWidth > innerWidth + 1) {
    let maxRight = innerWidth + 1;
    for (const element of document.querySelectorAll('body *')) {
      if (!isVisibleElement(element)) continue;
      const right = element.getBoundingClientRect().right;
      if (right > maxRight) {
        maxRight = right;
        offender = `${describeElement(element)} (right=${Math.round(right)}px)`;
      }
    }
  }
  return {
    scrollX: window.scrollX,
    scrollLeft: document.scrollingElement.scrollLeft,
    scrollWidth, innerWidth, offender,
    active: describeElement(document.activeElement),
  };
}

export function tokenColor(name) {
  return parseColor(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}

/** Inventory of every Animation on `scope` (document or element) with the
 * CSS property names it animates, its iteration count and play state. */
export function collectAnimations(scope) {
  const animations = (scope === document ? document.getAnimations() : scope.getAnimations({ subtree: true }));
  return animations.map(animation => {
    let kind = 'other', name = '', properties = [];
    try {
      if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition) {
        kind = 'transition';
        name = animation.transitionProperty;
        properties = String(animation.transitionProperty).split(',').map(s => s.trim());
      } else if (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation) {
        kind = 'animation';
        name = animation.animationName;
        const meta = new Set(['offset', 'computedOffset', 'easing', 'composite', 'cssText']);
        const frames = animation.effect.getKeyframes();
        properties = [...new Set(frames.flatMap(frame => Object.keys(frame).filter(key => !meta.has(key))))];
      }
    } catch { /* Web Animations from other origins; reported without props */ }
    let iterations = null, duration = null;
    try {
      const timing = animation.effect.getComputedTiming();
      iterations = timing.iterations ?? null;
      duration = timing.duration ?? null;
    } catch { /* non-standard effect */ }
    return { kind, name, properties, iterations, duration, playState: animation.playState };
  });
}

// ---------------------------------------------------------------------------
// 3. In-page probes. Every function below is serialized into the page with
//    pageKit() in scope; keep them free of module references.
// ---------------------------------------------------------------------------

/** S1 - tokens + Pretendard on the live document. */
export async function probeTokens(arg) {
  const failures = [];
  const root = getComputedStyle(document.documentElement);
  const rawBg = root.getPropertyValue('--th-bg').trim();
  const rawAccent = root.getPropertyValue('--th-accent').trim();
  const bg = parseColor(rawBg), accent = parseColor(rawAccent);
  const wantBg = parseColor(arg.expectBg), wantAccent = parseColor(arg.expectAccent);
  const measurements = {
    theme: document.documentElement.getAttribute('data-theme'), rawBg, rawAccent,
    resolvedBg: hexOf(bg), resolvedAccent: hexOf(accent), fontsStatus: null, pretendardLoaded: null,
  };
  if (document.documentElement.getAttribute('data-theme') !== arg.expectTheme) {
    failures.push(`data-theme is ${measurements.theme}, expected ${arg.expectTheme}`);
  }
  if (!bg || !wantBg || !colorEquals(bg, wantBg)) failures.push(`--th-bg ${rawBg || '(missing)'} != ${arg.expectBg}`);
  if (!accent || !wantAccent || !colorEquals(accent, wantAccent)) failures.push(`--th-accent ${rawAccent || '(missing)'} != ${arg.expectAccent}`);
  const bodyFont = getComputedStyle(document.body).fontFamily;
  measurements.bodyFontFamily = bodyFont;
  if (!/^\s*"?pretendard/i.test(bodyFont)) failures.push(`body font-family does not start with Pretendard: ${bodyFont}`);
  await document.fonts.ready;
  measurements.fontsStatus = document.fonts.status;
  measurements.pretendardLoaded = document.fonts.check('14px "Pretendard Variable"');
  if (!measurements.pretendardLoaded) failures.push('document.fonts.check(\'14px "Pretendard Variable"\') is false after fonts.ready');
  return { scenario: 'S1', pass: failures.length === 0, measurements, failures };
}

/** S3 - text hierarchy: --th-text vs --th-muted separation. */
export function probeHierarchy(arg) {
  const failures = [];
  const text = tokenColor('--th-text'), muted = tokenColor('--th-muted'), bg = tokenColor('--th-bg');
  const measurements = {
    text: hexOf(text), muted: hexOf(muted), bg: hexOf(bg),
    textOnBg: contrastRatio(text, bg), mutedOnBg: contrastRatio(muted, bg),
    textVsMuted: null,
  };
  if (!text) failures.push('--th-text unresolved');
  if (!muted) failures.push('--th-muted unresolved');
  if (!bg) failures.push('--th-bg unresolved');
  if (text && muted) {
    measurements.textVsMuted = contrastRatio(text, muted);
    if (measurements.textVsMuted === null || measurements.textVsMuted < arg.minRatio - 0.01) {
      failures.push(`--th-text vs --th-muted contrast ${measurements.textVsMuted} < ${arg.minRatio}`);
    }
  }
  return { scenario: 'S3', pass: failures.length === 0, measurements, failures };
}

/** S4 - tonal separation with one neutral hairline per tool record. The
 * previous 50%-of-baseline ceiling still applies to non-tool borders;
 * card hairlines have their own one-per-record allowance. */
export function probeSeparation(arg) {
  const pane = document.querySelector('.th-chat-pane');
  if (!pane) return { scenario: 'S4', pass: false, measurements: {}, failures: ['.th-chat-pane not found'] };
  const elements = [...pane.querySelectorAll('*')];
  const indexOf = new Map(elements.map((element, index) => [element, index]));
  const facts = elements.map((element, index) => {
    const style = getComputedStyle(element);
    const sides = [
      { width: parseFloat(style.borderTopWidth) || 0, color: parseColor(style.borderTopColor) },
      { width: parseFloat(style.borderRightWidth) || 0, color: parseColor(style.borderRightColor) },
      { width: parseFloat(style.borderBottomWidth) || 0, color: parseColor(style.borderBottomColor) },
      { width: parseFloat(style.borderLeftWidth) || 0, color: parseColor(style.borderLeftColor) },
    ];
    return {
      index,
      parentIndex: indexOf.get(element.parentElement) ?? -1,
      excluded: /^(input|textarea|select)$/i.test(element.tagName) || element.matches(':focus-visible')
        || !!element.closest('.th-goal-shelf, .th-activity-shelf'),
      visible: isVisibleElement(element),
      label: describeElement(element),
      toolCard: element.matches('.th-tool[data-tool-call-id]'),
      sides,
    };
  });
  const counted = facts.filter(fact => fact.visible);
  // Visibility filtering reindexes the array: remap parent references onto
  // the filtered positions so every parentIndex points into `counted` itself.
  // A parent that is itself invisible drops out here, which also correctly
  // stops nesting chains at invisible boundaries.
  const remap = new Map(counted.map((fact, position) => [fact.index, position]));
  const countedFacts = counted.map(fact => ({ ...fact, parentIndex: remap.get(fact.parentIndex) ?? -1 }));
  const census = classifyBorderFacts(countedFacts);
  const toolCards = countedFacts.filter(fact => fact.toolCard);
  const toolCardBorder = tokenColor('--th-tool-record-border');
  const cardFacts = toolCards.map(fact => {
    const painted = fact.sides.filter(side => side.width > 0 && side.color?.a > 0.02);
    return { label: fact.label, paintedSides: painted.length,
      neutralHairline: painted.length === 4 && painted.every(side =>
        Math.abs(side.width - 1) <= 0.1 && colorEquals(side.color, toolCardBorder)) };
  });
  const nonToolBorderedCount = census.borderedCount - countedFacts.filter((fact, index) =>
    fact.toolCard && census.bordered.includes(index)).length;
  const measurements = {
    elementsInPane: elements.length, visibleElements: counted.length,
    borderedCount: census.borderedCount, nestedBorderedCount: census.nestedBorderedCount,
    nonToolBorderedCount, toolCardBorder: hexOf(toolCardBorder), toolCards: cardFacts,
    nestedBorderedSamples: census.nested.slice(0, 12).map(position => counted[position].label),
    composerRadius: null, userBubble: null, baselineComparison: null,
  };
  const failures = [];
  const composer = document.querySelector('.th-chat-input-inner');
  if (composer) {
    measurements.composerRadius = getComputedStyle(composer).borderRadius;
    const radius = parseFloat(measurements.composerRadius);
    if (!Number.isFinite(radius) || Math.abs(radius - 24) > 0.5) failures.push(`composer .th-chat-input-inner radius ${measurements.composerRadius} != 24px`);
  } else failures.push('composer .th-chat-input-inner not found');
  const bubble = document.querySelector('.th-chat-msg--user');
  if (bubble) {
    const style = getComputedStyle(bubble);
    const styles = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle];
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
      .map(value => parseFloat(value) || 0);
    const minRadius = Math.min(...radii);
    measurements.userBubble = { borderStyles: styles, cornerRadii: radii, minRadius };
    if (styles.some(s => s !== 'none')) failures.push(`user bubble border-style ${styles.join('/')} != none`);
    if (minRadius < 16) failures.push(`user bubble min corner radius ${minRadius}px < 16px`);
  } else failures.push('user bubble .th-chat-msg--user not found');
  if (census.nestedBorderedCount > 0) failures.push(`${census.nestedBorderedCount} bordered elements nested inside another bordered element`);
  if (cardFacts.length === 0) failures.push('no tool record found for the neutral hairline budget');
  for (const card of cardFacts) if (!card.neutralHairline) failures.push(`${card.label} needs one neutral 1px --th-tool-record-border hairline on all sides`);
  if (typeof arg.baselineBordered === 'number') {
    const ceiling = arg.baselineBordered * 0.5;
    measurements.baselineComparison = { baseline: arg.baselineBordered, ceiling,
      toolCardAllowance: cardFacts.length, verdict: nonToolBorderedCount <= ceiling };
    if (nonToolBorderedCount > ceiling) failures.push(`non-tool bordered count ${nonToolBorderedCount} > 50% of baseline ${arg.baselineBordered} (tool cards have one neutral hairline each)`);
  } else measurements.baselineComparison = 'no baseline captured (run with --baseline first)';
  return { scenario: 'S4', pass: failures.length === 0, measurements, failures };
}

/** S5 - neutral borders/strokes AND matching state ink on a light tint. */
export function probeStateColors(arg = {}) {
  const tokens = {
    success: tokenColor('--th-success'), warning: tokenColor('--th-warning'),
    error: tokenColor('--th-error'), accent: tokenColor('--th-accent'),
  };
  const statusInk = { ...tokens, accent: tokenColor('--th-accent-ink') };
  const violations = [], uppercase = [];
  const uppercaseFacts = [];
  const stateTargets = {
    success: '.th-tool-status--ok, .th-activity-chip--ok, .th-toast--success',
    error: '.th-tool-status--error, .th-activity-chip--error',
    accent: '.th-tool-status--running, .th-activity-chip--running, .th-tree-running--count, .th-overview-card-running',
    warning: '.th-activity-chip--warning, .th-queue-engine',
  };
  const tintNames = { success: '--th-success-bg', error: '--th-error-bg',
    accent: '--th-accent-bg', warning: '--th-warning-bg' };
  const scratch = document.createElement('div');
  document.body.appendChild(scratch);
  const tints = {};
  for (const [state, name] of Object.entries(tintNames)) {
    scratch.style.backgroundColor = `var(${name})`;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const resolved = parseColor(getComputedStyle(scratch).backgroundColor);
    const literal = parseColor(raw);
    tints[state] = literal && !colorEquals(literal, resolved) ? literal : resolved;
  }
  scratch.remove();
  const statusSamples = [], statusFailures = [];
  for (const [state, selector] of Object.entries(stateTargets)) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisibleElement(element)) continue;
      if (arg.scope === 'chat' && !element.closest('.th-chat-pane')) continue;
      if (arg.scope === 'shell' && element.closest('.th-chat-pane, .th-activity-shelf, .th-goal-shelf')) continue;
      const style = getComputedStyle(element);
      const ink = parseColor(style.color);
      const fill = parseColor(style.backgroundColor);
      const inkOk = colorEquals(ink, statusInk[state]);
      const tintOk = !!tints[state] && tints[state].a > 0.02 && colorEquals(fill, tints[state]);
      const backdrop = tokenColor('--th-surface') ?? tokenColor('--th-bg');
      const contrast = ink && fill && backdrop ? contrastRatio(ink, compositeOver(fill, backdrop)) : null;
      const sample = { state, where: describeElement(element), ink: hexOf(ink), tint: hexOf(fill),
        tintAlpha: fill?.a ?? null, inkOk, tintOk, contrast };
      statusSamples.push(sample);
      if (!inkOk || !tintOk || contrast === null || contrast < 4.5 - 0.01) {
        statusFailures.push(`${sample.where} ${state} needs matching ink and tint at 4.5:1 (ink=${sample.ink}, fill=${sample.tint}, contrast=${contrast})`);
      }
    }
  }
  const glyphTargets = {
    success: '.th-tool-glyph--ok, .th-activity-glyph--ok, .th-activity-gstatus--ok',
    error: '.th-tool-glyph--error, .th-activity-glyph--error, .th-activity-gstatus--error',
    accent: '.th-tool-glyph--running, .th-activity-glyph--running, .th-activity-gstatus--running',
  };
  const glyphSamples = [];
  for (const [state, selector] of Object.entries(glyphTargets)) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisibleElement(element)) continue;
      if (arg.scope === 'chat' && (!element.closest('.th-chat-pane')
        || element.closest('.th-activity-shelf, .th-goal-shelf'))) continue;
      if (arg.scope === 'shell' && element.closest('.th-chat-pane, .th-activity-shelf, .th-goal-shelf')) continue;
      const shapes = [...element.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')];
      const painted = (shapes.length ? shapes : [element]).flatMap(part => {
        const style = getComputedStyle(part);
        if (part.namespaceURI !== 'http://www.w3.org/2000/svg') {
          return [style.color, style.backgroundColor].map(parseColor).filter(colour => colour && colour.a > 0.02);
        }
        return [
          (parseFloat(style.strokeWidth) || 0) > 0 && style.stroke !== 'none' ? style.stroke : 'none',
          style.fill !== 'none' ? style.fill : 'none',
        ].map(parseColor).filter(colour => colour && colour.a > 0.02);
      });
      const match = painted.some(colour => colorEquals(colour, tokens[state]));
      const sample = { state, where: describeElement(element), painted: painted.map(hexOf), match };
      glyphSamples.push(sample);
      if (!match) statusFailures.push(`${sample.where} ${state} glyph is not painted with the matching status hue`);
    }
  }
  if (!arg.statusOnly) for (const element of document.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    // Only painted borders encode state: a zero-width or style:none border
    // reports currentColor and must not be counted. Status glyphs and status
    // text may carry status/accent colour (DESIGN.md state encoding: wash +
    // glyph). Count every painted SVG shape, including dependency paths and
    // path-based enclosures. Only the actual production status glyph, comet,
    // glow and halo selectors are semantic exceptions; focus and alerts were
    // excluded above. A group inheriting stroke is not itself painted.
    const colours = [];
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const width = parseFloat(style['border' + side + 'Width']) || 0;
      const lineStyle = style['border' + side + 'Style'];
      if (width > 0 && lineStyle !== 'none' && lineStyle !== 'hidden') colours.push(style['border' + side + 'Color']);
    }
    if (element.namespaceURI === 'http://www.w3.org/2000/svg'
      && /^(rect|path|line|polyline|polygon|circle|ellipse)$/.test(element.localName)
      && !element.closest('.th-activity-gstatus, .th-tool-glyph--ok, .th-tool-glyph--error, .th-tool-glyph--running, .th-activity-glyph--ok, .th-activity-glyph--error, .th-activity-glyph--running, .th-activity-gedge-comet, .th-activity-gedge-glow, .th-activity-gnode-halo')
      && style.stroke && style.stroke !== 'none'
      && (parseFloat(style.strokeWidth) || 0) > 0
      && (style.strokeOpacity === '' || style.strokeOpacity === undefined
        || parseFloat(style.strokeOpacity) > 0.02)) colours.push(style.stroke);
    const where = describeElement(element);
    for (const raw of colours) {
      const colour = parseColor(raw);
      if (!colour || colour.a <= 0.02) continue;
      const dagCard = element.matches('.th-activity-gnode-card')
        ? element.closest('.th-activity-gnode') : null;
      for (const [name, token] of Object.entries(tokens)) {
        const sameHue = token && ['r', 'g', 'b'].every(channel =>
          Math.abs(colour[channel] - token[channel]) <= 1.5);
        if (!sameHue) continue;
        if (dagCard && ((name === 'success' && dagCard.matches('.th-activity-gnode--ok, .th-activity-gnode--completed'))
          || (name === 'error' && dagCard.matches('.th-activity-gnode--error, .th-activity-gnode--failed, .th-activity-gnode--cancelled, .th-activity-gnode--canceled')))) continue;
        if (violations.length < 400) {
          violations.push({ where, token: name, colour: hexOf(colour), alpha: Number(colour.a.toFixed(3)) });
        }
      }
    }
    if (style.textTransform === 'uppercase') {
      const text = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join(' ').trim();
      if (text && isVisibleElement(element)) uppercaseFacts.push({ textTransform: style.textTransform, text, where });
    }
  }
  const uppercaseCensus = uppercaseOf(uppercaseFacts);
  const tintTokens = {};
  for (const state of Object.keys(tints)) tintTokens[state] = hexOf(tints[state]);
  const measurements = {
    tokens: { success: hexOf(tokens.success), warning: hexOf(tokens.warning), error: hexOf(tokens.error), accent: hexOf(tokens.accent) },
    accentInk: hexOf(statusInk.accent),
    stateColorViolationCount: violations.length,
    stateColorViolationSamples: violations.slice(0, 25),
    uppercaseCount: uppercaseCensus.uppercaseCount,
    uppercaseSamples: uppercaseCensus.uppercase.slice(0, 12).map(index => uppercaseFacts[index]),
    statusSamples, glyphSamples, statusFailures, tintTokens,
  };
  const failures = [];
  if (violations.length > 0) failures.push(`${violations.length} elements carry a state/accent coloured border or stroke (first: ${violations[0].where} ${violations[0].token})`);
  if (uppercaseCensus.uppercaseCount > 0) failures.push(`${uppercaseCensus.uppercaseCount} visible elements use text-transform: uppercase (first: ${uppercaseFacts[uppercaseCensus.uppercase[0]].where})`);
  failures.push(...statusFailures);
  for (const state of arg.requireStates ?? []) {
    if (!statusSamples.some(sample => sample.state === state)) failures.push(`no ${state} status ink/tint target mounted`);
  }
  return { scenario: 'S5', pass: failures.length === 0, measurements, failures };
}

/** S6 - pane header discipline. arg: { cwd } */
export function probeHeader(arg) {
  const header = document.querySelector('.th-termhead');
  if (!header) return { scenario: 'S6', pass: false, measurements: {}, failures: ['.th-termhead not found'] };
  const failures = [];
  const rawTexts = [];
  const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (text) rawTexts.push(text);
    if (text === arg.cwd && isVisibleElement(node.parentElement)) failures.push(`raw cwd "${arg.cwd}" is visible header text`);
  }
  const clipped = [];
  for (const button of header.querySelectorAll('button')) {
    if (!isVisibleElement(button)) continue;
    if (button.scrollWidth > button.clientWidth) {
      clipped.push({ where: describeElement(button), label: button.getAttribute('aria-label') ?? button.title ?? '', scrollWidth: button.scrollWidth, clientWidth: button.clientWidth });
    }
  }
  if (clipped.length > 0) failures.push(`${clipped.length} header buttons clip their label (${clipped[0].where}: ${clipped[0].scrollWidth}>${clipped[0].clientWidth})`);
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  if (overflow > 1) failures.push(`document overflows viewport by ${overflow}px at width ${window.innerWidth}`);
  const titleCarrier = header.querySelector(`[title="${arg.cwd}"]`);
  const measurements = {
    headerTexts: rawTexts, cwdInTitleOrAria: titleCarrier !== null || header.querySelector(`[aria-label="${arg.cwd}"]`) !== null,
    clippedButtons: clipped, documentScrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth,
  };
  return { scenario: 'S6', pass: failures.length === 0, measurements, failures };
}

/** Running-glyph selectors shared by both S8 probes. Kit function, not a
 * module constant: pageKit() injects function sources only, so the list
 * lives inside the function body (same D6 class as OLD_PALETTE_HEXES). */
export function runningGlyphSelectors() {
  return ['.th-tool-glyph--running', '.th-tree-running-dot', '.th-overview-card-running-dot',
    '.th-tree-running', '.th-overview-card-running',
    '.th-activity-gnode--running', '.th-activity-gstatus--running'];
}

/** S8 part 1 - running glyphs and sidebar count chips use accent ink;
 * the sidebar dots must complete a visible cycle within 800ms. */
export function probeRunningGlyphs() {
  const accent = tokenColor('--th-accent');
  const accentInk = tokenColor('--th-accent-ink');
  const glyphs = [];
  for (const selector of runningGlyphSelectors()) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisibleElement(element)) continue;
      const style = getComputedStyle(element);
      const colourFacts = {
        stroke: style.stroke && style.stroke !== 'none' ? hexOf(parseColor(style.stroke)) : null,
        border: hexOf(parseColor(style.borderTopColor)), background: hexOf(parseColor(style.backgroundColor)),
        fill: style.fill && style.fill !== 'none' ? hexOf(parseColor(style.fill)) : null, color: hexOf(parseColor(style.color)),
      };
      const matchesAccent = [
        parseColor(style.stroke), parseColor(style.borderTopColor), parseColor(style.backgroundColor), parseColor(style.fill),
      ].some(colour => colour && colorEquals(colour, accent))
        || (element.matches('.th-tree-running, .th-overview-card-running')
          && colorEquals(parseColor(style.color), accentInk));
      const dot = element.matches('.th-tree-running, .th-overview-card-running')
        ? element.querySelector('.th-tree-running-dot, .th-overview-card-running-dot') : null;
      const dotStyle = dot ? getComputedStyle(dot) : null;
      const animationMs = dotStyle ? maxDurationMs(dotStyle.animationDuration)
        * (dotStyle.animationDirection.includes('alternate') ? 2 : 1) : null;
      const animationCount = dot ? dot.getAnimations().filter(animation => animation.playState === 'running').length : null;
      glyphs.push({ selector, where: describeElement(element), colourFacts, matchesAccent,
        countInkMatches: dot ? colorEquals(parseColor(style.color), accentInk) : null,
        dotAnimationMs: animationMs, dotRunningAnimations: animationCount });
    }
  }
  const measurements = { accent: hexOf(accent), accentInk: hexOf(accentInk), glyphsFound: glyphs.length, glyphs };
  const failures = [];
  if (glyphs.length === 0) failures.push('no running glyphs found (fixture must expose a running tool/tree/DAG)');
  for (const glyph of glyphs) if (!glyph.matchesAccent) failures.push(`running glyph ${glyph.selector} at ${glyph.where} is not accent-coloured: ${JSON.stringify(glyph.colourFacts)}`);
  for (const glyph of glyphs.filter(item => item.countInkMatches !== null)) {
    if (!glyph.countInkMatches) failures.push(`running count ${glyph.selector} is not --th-accent-ink-coloured`);
    if (glyph.dotRunningAnimations === 0 || !glyph.dotAnimationMs || glyph.dotAnimationMs > 800) {
      failures.push(`sidebar ${glyph.selector} indicator period ${glyph.dotAnimationMs ?? 'none'}ms exceeds 800ms or does not animate`);
    }
  }
  return { scenario: 'S8', pass: failures.length === 0, measurements, failures };
}

/** S8 part 2 - under prefers-reduced-motion: no glyph animations and a
 * textual running label must carry the state. */
export function probeRunningReducedMotion() {
  const failures = [];
  const glyphStates = [];
  let labelSamples = [];
  for (const selector of runningGlyphSelectors()) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isVisibleElement(element)) continue;
      const animations = element.getAnimations({ subtree: true });
      const sidebarChip = element.matches('.th-tree-running, .th-overview-card-running');
      const accessibleName = sidebarChip ? element.getAttribute('aria-label') || element.getAttribute('title') || '' : null;
      glyphStates.push({ selector, where: describeElement(element), animationCount: animations.length, accessibleName });
      if (animations.length > 0) failures.push(`running glyph ${selector} still animates under reduced motion (${animations.length})`);
      if (sidebarChip && !/(running|responding|executing|streaming|live|진행|실행|응답)/i.test(accessibleName)) {
        failures.push(`sidebar running chip ${selector} lacks an accessible running name under reduced motion`);
      }
    }
  }
  const labelPattern = /(running|responding|executing|streaming|live|진행|실행|응답)/i;
  for (const element of document.querySelectorAll('[aria-label], [title], button, [role="status"], [class*="tool-status"], [class*="termhead"], [class*="status"]')) {
    if (!isVisibleElement(element)) continue;
    const text = (element.textContent || '').trim();
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
    if (labelPattern.test(label)) labelSamples.push({ where: describeElement(element), label: label.slice(0, 60) });
    else if (labelPattern.test(text) && text.length < 60) labelSamples.push({ where: describeElement(element), label: text.slice(0, 60) });
    if (labelSamples.length > 12) break;
  }
  labelSamples = labelSamples.filter((sample, index, all) => all.findIndex(other => other.label === sample.label) === index);
  if (glyphStates.length === 0) failures.push('no running glyphs found for reduced-motion check');
  if (labelSamples.length === 0) failures.push('no textual running label present under reduced motion');
  const measurements = { glyphStates, runningLabels: labelSamples };
  return { scenario: 'S8', pass: failures.length === 0, measurements, failures };
}

/** G25 / S12 / S23. Pure: the caller has already judged the DOM.
 *   triggerRestorable - trigger is connected, visible, and focusable now
 *   activeIsTrigger    - document.activeElement is that trigger
 *   activeIsBody       - activeElement is <body> or the document element
 *   activeIsFallback   - activeElement is the focused pane's composer
 *                        textarea, or the main region used as the last resort
 * branch 'trigger' when the trigger can take focus (pass only if it has it),
 * 'fallback' when the trigger is hidden or detached (pass only for the
 * composer/main, never a random control), 'body' when focus is on body. */
export function modalFocusRestoreDecision(facts) {
  if (facts.activeIsBody === true) return { pass: false, branch: 'body' };
  if (facts.triggerRestorable === true) {
    return { pass: facts.activeIsTrigger === true, branch: 'trigger' };
  }
  return { pass: facts.activeIsFallback === true, branch: 'fallback' };
}

/** In-page facts for modalFocusRestoreDecision. arg: { trigger: selector }.
 * Injected with pageKit(); uses only DOM APIs and kit helpers. A trigger
 * counts as restorable when it is visible (non-zero box, not display:none
 * or visibility:hidden) and neither disabled nor inside an inert subtree. */
export function modalFocusRestoreFacts(arg) {
  const trigger = arg && arg.trigger ? document.querySelector(arg.trigger) : null;
  const active = document.activeElement;
  const composer = document.querySelector('.th-pane--focused .th-chat-input textarea');
  const main = document.querySelector('main.th-main');
  const blocked = element => element.matches(':disabled') || element.closest('[inert]') !== null;
  const triggerRestorable = isVisibleElement(trigger) && !blocked(trigger);
  return {
    triggerRestorable,
    activeIsTrigger: trigger !== null && active === trigger,
    activeIsBody: active === document.body || active === document.documentElement,
    activeIsFallback: (composer !== null && active === composer) || (main !== null && active === main),
    activeElement: active instanceof Element ? describeElement(active) : 'none',
  };
}

/** S12 helper - overlay census right after an action. arg: { root, controller? }
 * `root` counts the overlay instances; `controller` (optional) describes the
 * controlling element of a non-modal popover - the trigger button or the
 * composer textarea driving a palette - per the refined S12 contract:
 * popovers keep focus on the controller with aria-expanded=true (and
 * aria-activedescendant resolving inside the overlay for palettes while an
 * option is active). */
export function overlaySnapshot(arg) {
  const roots = [...document.querySelectorAll(arg.root)];
  const active = document.activeElement;
  const root = roots[0] ?? null;
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const snapshot = {
    count: roots.length,
    activeInside: !!(root && root.contains(active)),
    activeElement: active && active instanceof Element ? describeElement(active) : String(active?.tagName ?? null),
    backdropFilter: null, backdropFilterIsNone: null, animations: [],
    interactiveCount: 0,
    controller: null,
  };
  if (root) {
    const style = getComputedStyle(root);
    snapshot.backdropFilter = style.backdropFilter || style.webkitBackdropFilter || null;
    snapshot.backdropFilterIsNone = !snapshot.backdropFilter || snapshot.backdropFilter === 'none';
    snapshot.animations = collectAnimations(root);
    snapshot.interactiveCount = [...root.querySelectorAll(focusableSelector)]
      .filter(element => isVisibleElement(element)).length;
  }
  if (arg.controller) {
    const controller = document.querySelector(arg.controller);
    const facts = { found: !!controller };
    if (controller) {
      const activeDescendant = controller.getAttribute('aria-activedescendant');
      facts.descriptor = describeElement(controller);
      facts.ariaExpanded = controller.getAttribute('aria-expanded');
      facts.hasFocus = controller === active || controller.contains(active);
      facts.ariaActiveDescendant = activeDescendant;
      facts.activeDescendantInRoot = !!activeDescendant && !!root
        && root.contains(document.getElementById(activeDescendant));
    }
    snapshot.controller = facts;
  }
  return snapshot;
}

/** S15 - motion hygiene across the whole document. */
export function probeMotion() {
  const inventory = collectAnimations(document);
  const violating = [];
  for (const entry of inventory) {
    const bad = motionViolations(entry.properties);
    if (bad.length > 0) violating.push({ ...entry, violations: bad });
  }
  const measurements = {
    animationCount: inventory.length,
    byKind: inventory.reduce((acc, entry) => { acc[entry.kind] = (acc[entry.kind] ?? 0) + 1; return acc; }, {}),
    infiniteCount: inventory.filter(entry => entry.iterations === Infinity).length,
    inventory: inventory.slice(0, 80), violating: violating.slice(0, 25),
  };
  const failures = [];
  if (violating.length > 0) {
    failures.push(`${violating.length} animations animate properties outside the contract (first: ${violating[0].kind} "${violating[0].name}" -> ${violating[0].violations.join(', ')})`);
  }
  return { scenario: 'S15', pass: failures.length === 0, measurements, failures };
}

/** S16 - under prefers-reduced-motion: nothing infinite, durations collapsed.
 * The global policy (global.css) collapses BOTH animation and transition to
 * none/zero under reduce, so any Animation object that still exists with a
 * real duration is a violation: a finite one-iteration 480ms entrance passes
 * a duration-less gate (review R4 executed counterexample) and is rejected
 * here alongside infinite loops. */
export function probeReducedMotion() {
  const inventory = collectAnimations(document);
  const infinite = inventory.filter(entry => entry.iterations === Infinity);
  const finite = inventory.filter(entry => entry.iterations !== Infinity
    && typeof entry.duration === 'number' && entry.duration > 1);
  let maxTransitionMs = 0, worst = null;
  for (const element of document.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.display === 'none') continue;
    const duration = maxDurationMs(style.transitionDuration);
    if (duration > maxTransitionMs) { maxTransitionMs = duration; worst = describeElement(element); }
  }
  const measurements = {
    animationCount: inventory.length, infiniteAnimations: infinite.slice(0, 12),
    finiteAnimations: finite.slice(0, 12),
    maxTransitionMs, maxTransitionOn: worst,
  };
  const failures = [];
  if (infinite.length > 0) failures.push(`${infinite.length} infinite animations still run under reduced motion (first: ${infinite[0].name})`);
  if (finite.length > 0) failures.push(`${finite.length} finite animations with duration > 1ms still exist under reduced motion (first: ${finite[0].kind} "${finite[0].name}" ${finite[0].duration}ms)`);
  if (maxTransitionMs > 1) failures.push(`transition durations not collapsed under reduced motion: ${maxTransitionMs}ms on ${worst}`);
  return { scenario: 'S16', pass: failures.length === 0, measurements, failures };
}

/** S19 - per-surface contrast walk + pre-redesign hex scan. arg: { surface } */
export function probeContrastSurface(arg) {
  const failures = [];
  const faint = tokenColor('--th-faint');
  const canvas = tokenColor('--th-bg');
  let textNodes = 0, failedNodes = 0, gradientSkipped = 0, unresolved = 0;
  const nodeFailures = [];
  // Paint the stack from the canvas towards the text. Ancestors alone miss
  // earlier siblings such as a pointer-events:none segmented thumb painted
  // beneath a transparent tab label. Sample the text's own rect, then include
  // only preceding sibling surfaces that actually cover that point.
  const effectiveBackground = (element, textNode) => {
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : [];
    const rect = [...rects].find(box => box.width > 0 && box.height > 0);
    const point = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    const path = [];
    for (let current = element; current && current instanceof Element; current = current.parentElement) path.unshift(current);
    let layers = canvas ?? { r: 255, g: 255, b: 255, a: 1 };
    const paint = target => {
      const style = getComputedStyle(target);
      if (style.backgroundImage && style.backgroundImage !== 'none') gradientSkipped += 1;
      const colour = parseColor(style.backgroundColor);
      if (colour && colour.a > 0) layers = compositeOver(colour, layers);
    };
    const paintSibling = sibling => {
      if (!isVisibleElement(sibling)) return;
      const box = sibling.getBoundingClientRect();
      if (!point || point.x < box.left || point.x > box.right || point.y < box.top || point.y > box.bottom) return;
      paint(sibling);
      for (const child of sibling.children) paintSibling(child);
    };
    for (let index = 0; index < path.length; index += 1) {
      const current = path[index];
      paint(current);
      if (!point || index + 1 === path.length) continue;
      for (let sibling = current.firstElementChild; sibling && sibling !== path[index + 1]; sibling = sibling.nextElementSibling) {
        paintSibling(sibling);
      }
    }
    return layers;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent || !isVisibleElement(parent)) continue;
    textNodes += 1;
    const style = getComputedStyle(parent);
    const colour = parseColor(style.color);
    if (!colour) { unresolved += 1; continue; }
    const background = effectiveBackground(parent, node);
    const ratio = contrastRatio(colour, background);
    const isFaint = faint && colorEquals(colour, faint);
    // Tool status glyphs render as text characters but are aria-hidden icons:
    // judge their painted symbol at the non-text 3:1 floor. Their adjacent
    // visible status words retain the full 4.5:1 body-text floor (S5/Q1).
    const isGlyph = !!parent.closest('.th-chat-record-glyph[aria-hidden="true"]');
    const threshold = isGlyph ? arg.faintMin : isFaint ? arg.faintMin : arg.bodyMin;
    if (ratio === null) { unresolved += 1; continue; }
    if (ratio < threshold - 0.01) {
      failedNodes += 1;
      if (nodeFailures.length < 30) nodeFailures.push({
        where: describeElement(parent), text: node.textContent.trim().slice(0, 40),
        colour: hexOf(colour), background: hexOf(background), ratio: Number(ratio.toFixed(2)), threshold, isFaint, isGlyph,
      });
    }
  }
  const oldHexes = [];
  for (const element of document.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const colours = [style.color, style.backgroundColor, style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
    if (element.namespaceURI === 'http://www.w3.org/2000/svg') colours.push(style.stroke, style.fill);
    for (const raw of colours) {
      if (isOldPaletteColor(raw) && oldHexes.length < 200) oldHexes.push({ where: describeElement(element), colour: raw });
    }
  }
  if (failedNodes > 0) failures.push(`${failedNodes}/${textNodes} text nodes below contrast (first: ${nodeFailures[0].where} "${nodeFailures[0].text}" ${nodeFailures[0].ratio}<${nodeFailures[0].threshold})`);
  if (oldHexes.length > 0) failures.push(`${oldHexes.length} computed colours still use pre-redesign hexes (first: ${oldHexes[0].where} ${oldHexes[0].colour})`);
  const measurements = {
    surface: arg.surface, textNodes, failedNodes, gradientSkipped, unresolved,
    nodeFailures, oldHexCount: oldHexes.length, oldHexSamples: oldHexes.slice(0, 15),
  };
  return { scenario: 'S19', pass: failures.length === 0, measurements, failures };
}

/** S20 - browser chrome colours follow the canvas token. arg: { darkBg }
 * Refined 2026-09-25: a single static PWA manifest cannot carry two themes,
 * so manifest theme_color/background_color must equal the DEFAULT (dark,
 * no-script) :root --th-bg - arg.darkBg - in BOTH themes, while the meta
 * theme-color must equal the ACTIVE theme's --th-bg and update on theme
 * switch (the driver re-probes after switching via the real settings
 * control). */
export async function probeChromeTheme(arg) {
  const failures = [];
  const bg = tokenColor('--th-bg');
  const darkDefault = parseColor(arg.darkBg);
  if (!darkDefault) failures.push('probe misconfigured: arg.darkBg (the :root default --th-bg) is required');
  const measurements = { resolvedBg: hexOf(bg), darkDefaultBg: arg.darkBg, metaThemeColor: null, manifestThemeColor: null, manifestBackgroundColor: null };
  const meta = document.querySelector('meta[name="theme-color"]');
  measurements.metaThemeColor = meta ? meta.getAttribute('content') : null;
  const metaColour = parseColor(measurements.metaThemeColor);
  if (!meta) failures.push('meta[name="theme-color"] missing');
  else if (!bg || !metaColour || !colorEquals(metaColour, bg)) failures.push(`meta theme-color ${measurements.metaThemeColor} != active --th-bg ${hexOf(bg)}`);
  try {
    const response = await fetch('./manifest.json', { cache: 'no-store' });
    const manifest = await response.json();
    measurements.manifestStatus = response.status;
    measurements.manifestThemeColor = manifest.theme_color ?? null;
    measurements.manifestBackgroundColor = manifest.background_color ?? null;
    for (const key of ['manifestThemeColor', 'manifestBackgroundColor']) {
      const colour = parseColor(measurements[key]);
      if (!darkDefault || !colour || !colorEquals(colour, darkDefault)) failures.push(`manifest ${key === 'manifestThemeColor' ? 'theme_color' : 'background_color'} ${measurements[key]} != :root default --th-bg ${arg.darkBg}`);
    }
  } catch (error) {
    failures.push(`manifest fetch failed: ${error}`);
  }
  return { scenario: 'S20', pass: failures.length === 0, measurements, failures };
}

// ---------------------------------------------------------------------------
// 4. Scenario registry
// ---------------------------------------------------------------------------

/** Every scenario the harness knows. stub entries report { pass: null }
 * without touching a browser; their owners implement the probes when the
 * corresponding redesign task lands. */
export const SCENARIOS = Object.freeze({
  S1: { title: 'Tokens + Pretendard font contract', stub: false },
  S2: {
    title: 'Contrast contract suite', stub: true,
    reason: 'not a browser-harness scenario: measured by npx vitest run src/styles/contrast.test.ts including its mutation check',
  },
  S3: { title: 'Text hierarchy luminance separation', stub: false },
  S4: { title: 'Neutral tool-card hairlines and tonal separation', stub: false },
  S5: { title: 'Neutral borders with matching state ink and tints', stub: false },
  S6: { title: 'Pane header label discipline', stub: false },
  S7: {
    title: 'Transcript timeline + disclosure', stub: true, reason: 'defined in T2/T3/T4',
    // T2 (chat surface) implements this probe once the transcript redesign
    // lands: tool calls as timeline items with a rail element, Enter/Space
    // toggling aria-expanded with content visibility, a non-none fade
    // (mask-image or gradient pseudo) on expanded overflowing output, and
    // 5 rapid toggles ending with aria-expanded consistent with visibility.
    detail: 'owner T2: rail element, keyboard disclosure, overflow fade mask, rapid-toggle consistency',
  },
  S8: { title: 'Running accent, chip cadence + reduced motion', stub: false },
  S9: {
    title: 'Composer + palette + send states', stub: true, reason: 'defined in T2/T3/T4',
    // T2 implements: send button background == --th-accent-solid when enabled,
    // accent-alpha focus-within ring, '/' palette with backdrop-filter glass
    // and keyboard hint row, ArrowDown+Enter insertion, send/stop behavior.
    detail: 'owner T2: accent-solid send, focus-within ring, palette glass + hints, command insertion',
  },
  S10: {
    title: 'Sidebar selection + running identity', stub: true, reason: 'defined in T2/T3/T4',
    // T3 (shell) implements: .th-btn-add not dashed, one moving selection
    // indicator (transform/translate) or moving active class, running session
    // dot colour == accent, non-mono counts, no uppercase labels.
    detail: 'owner T3: solid add button, single moving selection indicator, accent running dot, sans counts',
  },
  S11: {
    title: 'Empty state presence + choreography', stub: true, reason: 'defined in T2/T3/T4',
    // T3 implements: orb + greeting + CTA on the empty layout, one-time
    // entrance animations (getAnimations on load, finish), none under reduced
    // motion, CTA opens the new chat dialog.
    detail: 'owner T3: orb, greeting, CTA wiring, entrance-once choreography',
  },
  S12: { title: 'Overlay focus, escape, glass + motion', stub: false },
  S13: {
    title: 'Shelf segmented control', stub: true, reason: 'defined in T2/T3/T4',
    // T4 (activity + DAG) implements: segmented control with one thumb
    // element whose transform changes on selection, ArrowRight/Home/End
    // roving, visible non-mono counts.
    detail: 'owner T4: thumb element transform, roving keys, non-mono counts',
  },
  S14: {
    title: 'DAG graph + list redesign', stub: true, reason: 'defined in T2/T3/T4',
    // T4 implements: state-tinted fills, semantic completed/failed DAG card
    // strokes with neutral pending/running cards, glyph left of label,
    // cubic bezier <path> edges, animated comet on running edges, running
    // node halo, run-header progress scaleX == completed/total +-0.01,
    // auto-scroll on first paint, timeline list view, stable-layout test.
    detail: 'owner T4: bezier edges, comet, halo, progress scaleX, auto-scroll, list timeline',
  },
  S15: { title: 'Motion hygiene allowlist', stub: false },
  S16: { title: 'Reduced-motion collapse', stub: false },
  S17: {
    title: 'Full visual matrix + critique', stub: true,
    reason: 'not probed here: run this harness across the full theme x viewport matrix for screenshots; the verdict channel is the visual-qa reviewer against the approved direction',
  },
  S18: {
    title: 'Regression suites', stub: true,
    reason: 'not a browser-harness scenario: npx vitest run, npm run build, go test ./..., bun test test/qa/*.test.mjs',
  },
  S19: { title: 'Secondary surfaces contrast + palette', stub: false },
  S20: { title: 'Chrome/manifest canvas colours', stub: false },
  S21: {
    title: 'Embedded binary + font asset', stub: true,
    reason: 'not a browser-harness scenario: make build, run the binary from /tmp, curl the index, the Pretendard woff2 asset, the login POST, and THIRD_PARTY_NOTICES',
  },
  S22: {
    title: 'Rapid interruption consistency', stub: true, reason: 'defined in T2/T3/T4',
    // T2 implements: 3 rapid session switches within 100ms ending on the
    // last session with no stale content, rapid disclosure toggles staying
    // consistent, modal open/close/open consistency (S12 covers the modal
    // part until then).
    detail: 'owner T2: rapid session switch, disclosure, modal churn',
  },
  S23: {
    title: 'Modal focus restores to the trigger or a fallback', stub: false,
    detail: 'G25: a hidden or detached trigger must not drop focus on body',
  },
  S24: { title: 'Coarse-pointer 44px targets', stub: true, reason: 'defined in T3b' },
});

/** Scenario ids this harness actively probes, in plan order. */
export const BROWSER_SCENARIOS = Object.freeze(
  Object.keys(SCENARIOS).filter(id => !SCENARIOS[id].stub),
);
