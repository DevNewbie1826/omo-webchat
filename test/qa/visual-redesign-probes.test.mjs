/** Unit tests for the pure helpers of the visual-redesign QA harness.
 * These cover the colour parsing/luminance/compositing math, the motion
 * allowlist and the border/uppercase classification that the in-page probes
 * execute inside real Chrome - one implementation, tested here, injected
 * there. Run: bun test test/qa/visual-redesign-probes.test.mjs */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScenarioRegistry, loadScenarioPlugins, NEW_CHAT_DIALOG_SURFACE, openNewChatDialogNative, overlayCycle, requiredInteractionVerdict } from './visual-redesign.mjs';
import {
  CONTRAST_BODY_MIN, CONTRAST_FAINT_MIN, HIERARCHY_MIN_RATIO, OLD_PALETTE_HEXES, classifyBorderFacts,
  collectAnimations, colorEquals, compositeOver, contrastRatio, defaultMotionAllowed, describeElement,
  hexOf, isOldPaletteColor, isVisibleElement, maxDurationMs, motionViolations, normalizeMotionProperty,
  pageKit, pagePanVerdict, parseColor, probeChromeTheme, probeContrastSurface, probeHeader, probeHierarchy, probeMotion,
  probePagePan,
  probeReducedMotion, probeRunningGlyphs, probeRunningReducedMotion, probeSeparation, probeStateColors,
  probeTokens, relativeLuminance, runningGlyphSelectors, tokenColor, uppercaseOf, overlaySnapshot,
  modalFocusRestoreDecision, modalFocusRestoreFacts,
} from './visual-redesign-probes.mjs';

const closeTo = (actual, expected, epsilon = 0.01) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
};

describe('per-task scenario plugins (T2/T3/T4 extension contract)', () => {
  test('a plugin module is picked up and overrides a stub; unknown ids allowed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vr-plugins-'));
    try {
      const file = join(dir, 'visual-redesign-scenarios-t9.mjs');
      await writeFile(file, [
        'export const scenarios = {',
        '  S7: async ctx => ({ pass: true, measurements: { plugin: ctx.scenario }, failures: [] }),',
        '  S99: async () => ({ pass: null, measurements: {}, failures: [] }),',
        '};',
      ].join('\n'));
      const plugins = await loadScenarioPlugins(dir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].file).toBe('visual-redesign-scenarios-t9.mjs');
      expect(Object.keys(plugins[0].scenarios).sort()).toEqual(['S7', 'S99']);
      const registry = buildScenarioRegistry(plugins);
      const s7 = registry.find(entry => entry.id === 'S7');
      expect(s7.stub).toBe(false);
      expect(s7.origin).toBe('plugin:visual-redesign-scenarios-t9.mjs');
      expect(typeof s7.run).toBe('function');
      const outcome = await s7.run({ scenario: 'S7' });
      expect(outcome).toEqual({ pass: true, measurements: { plugin: 'S7' }, failures: [] });
      expect(registry.some(entry => entry.id === 'S99' && entry.origin.startsWith('plugin:'))).toBe(true);
      expect(registry.find(entry => entry.id === 'S1').origin).toBe('builtin');
      expect(registry.find(entry => entry.id === 'S10').stub).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test('later files win and broken modules are skipped, not fatal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vr-plugins-'));
    try {
      await writeFile(join(dir, 'visual-redesign-scenarios-a.mjs'), 'export const scenarios = { S7: async () => ({ pass: false, measurements: {}, failures: [] }) };\n');
      await writeFile(join(dir, 'visual-redesign-scenarios-b.mjs'), 'export const scenarios = { S7: async () => ({ pass: true, measurements: { from: "b" }, failures: [] }) };\n');
      await writeFile(join(dir, 'visual-redesign-scenarios-c.mjs'), 'throw new Error("broken plugin");\n');
      const plugins = await loadScenarioPlugins(dir);
      expect(plugins.map(plugin => plugin.file)).toEqual(['visual-redesign-scenarios-a.mjs', 'visual-redesign-scenarios-b.mjs', 'visual-redesign-scenarios-c.mjs']);
      expect(plugins[2].skipped).toContain('import failed');
      const s7 = buildScenarioRegistry(plugins).find(entry => entry.id === 'S7');
      expect(await s7.run({})).toEqual({ pass: true, measurements: { from: 'b' }, failures: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pageKit completeness (regression: probes must resolve every helper in-page)', () => {
  const KIT_HELPERS = ['parseColor', 'relativeLuminance', 'contrastRatio', 'compositeOver', 'hexOf',
    'colorEquals', 'isOldPaletteColor', 'motionViolations', 'normalizeMotionProperty', 'defaultMotionAllowed',
    'classifyBorderFacts', 'uppercaseOf', 'maxDurationMs', 'describeElement', 'isVisibleElement',
    'tokenColor', 'collectAnimations', 'runningGlyphSelectors'];
  test('kit source defines every helper the probes call', () => {
    const kit = pageKit();
    for (const name of KIT_HELPERS) expect(kit).toContain(`function ${name}(`);
  });
  test('every probe serializes into a parsable kit-augmented function', () => {
    const probes = [probeTokens, probeHierarchy, probeSeparation, probeStateColors, probeHeader,
      probeRunningGlyphs, probeRunningReducedMotion, overlaySnapshot, probeMotion,
      probeReducedMotion, probeContrastSurface, probeChromeTheme, modalFocusRestoreFacts, probePagePan];
    for (const fn of probes) {
      expect(() => new Function(`${pageKit()}\nreturn (${fn.toString()})();`)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Free-identifier scan (D6 regression). pageKit() serializes FUNCTION
// SOURCES into the page: module constants (OLD_PALETTE_HEXES,
// RUNNING_GLYPH_SELECTORS-style) do not exist there, so any injected
// function that references one crashes in-page with a ReferenceError - the
// D6 defect that left S19 entirely unverified. The detector below masks
// strings/comments/regex/template bodies, then collects every identifier in
// reference position (not a keyword, property access, or object-literal
// key) and subtracts the names declared anywhere in the kit-augmented
// source plus the page/JS globals the browser guarantees. It is
// deliberately conservative: a local variable name that also exists inside
// a different injected function could mask a reference (accepted residual
// risk, documented here), but a module-level CONSTANT name can never be
// declared inside a serialized function, so the D6 class is always caught.
// ---------------------------------------------------------------------------

const PAGE_GLOBALS = new Set([
  // DOM / browser APIs the in-page probes rely on
  'document', 'window', 'getComputedStyle', 'Element', 'Node', 'NodeFilter', 'HTMLElement',
  'CSSAnimation', 'CSSTransition', 'requestAnimationFrame', 'fetch', 'console',
  'setTimeout', 'clearTimeout', 'getSelection', 'MutationObserver', 'ResizeObserver',
  // standard JavaScript builtins
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'Intl', 'BigInt', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone', 'globalThis',
  'URL', 'URLSearchParams', 'Event', 'CustomEvent',
]);
const JS_NON_REFERENCES = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'static', 'get', 'set',
  'true', 'false', 'null', 'undefined', 'arguments', 'NaN', 'Infinity']);

/** Mask strings, template-literal text, comments and regex bodies so the
 * identifier scan only sees code tokens. Template `${...}` parts are kept
 * (recursively) because they contain real references. */
function maskSource(source) {
  const out = [];
  let i = 0;
  const sig = () => {
    for (let j = out.length - 1; j >= 0; j -= 1) if (!/\s/.test(out[j])) return out[j];
    return '';
  };
  // A '/' starts a regex unless the previous significant token can end a
  // value (identifier, number, closing bracket/paren, quote).
  const regexAllowed = () => !/[A-Za-z0-9_$)\]"']/.test(sig());
  function readString(quote) {
    out.push(quote); i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') { out.push(' ', ' '); i += 2; continue; }
      out.push(source[i] === '\n' ? '\n' : ' '); i += 1;
    }
    if (i < source.length) { out.push(quote); i += 1; }
  }
  function readTemplate() { // i is just after the opening backtick
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '`') { out.push('`'); i += 1; return; }
      if (c === '$' && source[i + 1] === '{') {
        // The $ sigil is not an identifier; keep the brace for structure.
        out.push(' ', '{'); i += 2;
        readCode(true);
        if (source[i] === '}') { out.push('}'); i += 1; }
        continue;
      }
      out.push(c === '\n' ? '\n' : ' '); i += 1;
    }
  }
  function readRegex() {
    out.push('/'); i += 1;
    let inClass = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (c === '\n') break; // not a regex after all; the mask is harmless
      out.push(' '); i += 1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    if (source[i] === '/') { out.push('/'); i += 1; }
    while (i < source.length && /[a-z]/i.test(source[i])) { out.push(' '); i += 1; } // flags
  }
  function readCode(stopAtBrace) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (stopAtBrace && c === '}' && depth === 0) return;
      if (c === '{') { depth += 1; out.push(c); i += 1; continue; }
      if (c === '}') { depth -= 1; out.push(c); i += 1; continue; }
      if (c === '"' || c === "'") { readString(c); continue; }
      if (c === '`') { out.push('`'); i += 1; readTemplate(); continue; }
      if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') { out.push(' '); i += 1; }
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        while (i < stop) { out.push(source[i] === '\n' ? '\n' : ' '); i += 1; }
        continue;
      }
      if (c === '/' && regexAllowed()) { readRegex(); continue; }
      out.push(c); i += 1;
    }
  }
  readCode(false);
  return out.join('');
}

function identifierTokens(masked) {
  const tokens = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match;
  while ((match = re.exec(masked))) tokens.push({ name: match[0], start: match.index, end: match.index + match[0].length });
  return tokens;
}

function neighbours(masked, start, end) {
  let prev = '', prev2 = '', next = '';
  for (let j = start - 1; j >= 0; j -= 1) {
    if (!/\s/.test(masked[j])) {
      prev = masked[j];
      for (let k = j - 1; k >= 0; k -= 1) if (!/\s/.test(masked[k])) { prev2 = masked[k]; break; }
      break;
    }
  }
  for (let j = end; j < masked.length; j += 1) if (!/\s/.test(masked[j])) { next = masked[j]; break; }
  return { prev, prev2, next };
}

/** Identifiers in reference position within `masked`. Property accesses
 * (a.b, a?.b) and object-literal keys ({ key: ... }) are excluded; shorthand
 * ({ failures }) counts, as it is a real reference. */
function referencesIn(masked) {
  const refs = new Set();
  for (const token of identifierTokens(masked)) {
    if (JS_NON_REFERENCES.has(token.name)) continue;
    const { prev, prev2, next } = neighbours(masked, token.start, token.end);
    if (prev === '.' || (prev === '?' && prev2 === '.')) continue;
    if (next === ':' && (prev === '{' || prev === ',')) continue;
    refs.add(token.name);
  }
  return refs;
}

/** Names bound by function declarations (name + params), arrow params and
 * const/let/var declarators (incl. array-destructuring patterns) anywhere
 * in `masked` - an over-approximation of the lexical scope, see the block
 * comment above for the accepted residual risk. */
function declaredNames(masked) {
  const names = new Set();
  const addIdentifierList = body => {
    for (const token of identifierTokens(body)) {
      if (JS_NON_REFERENCES.has(token.name)) continue;
      const { prev, next } = neighbours(body, token.start, token.end);
      if (prev === '.') continue;
      if (next === ',' || next === '=' || next === '') names.add(token.name);
    }
  };
  const balancedEnd = (openIndex) => {
    const open = masked[openIndex];
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    for (let j = openIndex; j < masked.length; j += 1) {
      if (masked[j] === open) depth += 1;
      else if (masked[j] === close) { depth -= 1; if (depth === 0) return j; }
    }
    return openIndex;
  };
  // function declarations: name + parameter list
  const fnRe = /\bfunction\b\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
  let m;
  while ((m = fnRe.exec(masked))) {
    if (m[1]) names.add(m[1]);
    const open = m.index + m[0].length - 1;
    addIdentifierList(masked.slice(open + 1, balancedEnd(open)));
  }
  // catch bindings: catch (error) { ... }
  const catchRe = /\bcatch\s*\(/g;
  while ((m = catchRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const end = balancedEnd(open);
    for (const token of identifierTokens(masked.slice(open + 1, end))) {
      if (!JS_NON_REFERENCES.has(token.name)) names.add(token.name);
    }
  }
  // arrow functions: (...) => or ident =>
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(masked))) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(masked[j])) j -= 1;
    if (j >= 0 && masked[j] === ')') {
      let depth = 0;
      for (; j >= 0; j -= 1) {
        if (masked[j] === ')') depth += 1;
        else if (masked[j] === '(') { depth -= 1; if (depth === 0) break; }
      }
      if (j >= 0) addIdentifierList(masked.slice(j + 1, m.index - 1).replace(/\)\s*$/, ''));
    } else if (j >= 0 && /[A-Za-z0-9_$]/.test(masked[j])) {
      let start = j;
      while (start >= 0 && /[A-Za-z0-9_$]/.test(masked[start])) start -= 1;
      names.add(masked.slice(start + 1, j + 1));
    }
  }
  // const/let/var declarators
  const declRe = /\b(?:const|let|var)\b/g;
  while ((m = declRe.exec(masked))) {
    let j = m.index + m[0].length;
    let expectBinding = true;
    let depth = 0;
    while (j < masked.length) {
      const c = masked[j];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (depth === 0 && (c === ';' || c === '\n' && /\s*\n/.test(masked.slice(j, j + 2)))) break;
      if (expectBinding && /[A-Za-z_$[]/.test(c)) {
        if (c === '[' || c === '{') {
          const end = balancedEnd(j);
          for (const token of identifierTokens(masked.slice(j + 1, end))) {
            if (!JS_NON_REFERENCES.has(token.name)) names.add(token.name);
          }
          j = end + 1;
        } else {
          const idRe = /[A-Za-z_$][A-Za-z0-9_$]*/;
          const id = idRe.exec(masked.slice(j));
          if (id) {
            names.add(id[0]);
            j += id[0].length;
          } else j += 1;
        }
        expectBinding = false;
        continue;
      }
      if (depth === 0 && c === ',') expectBinding = true;
      j += 1;
    }
  }
  return names;
}

/** Free identifiers in `fnSource` given that `combinedSource` (kit + fn) is
 * everything the in-page evaluation scope provides. */
function freeIdentifiers(combinedSource, fnSource) {
  const combined = maskSource(combinedSource);
  const scope = maskSource(fnSource);
  const declared = declaredNames(combined);
  return [...referencesIn(scope)].filter(name => !declared.has(name) && !PAGE_GLOBALS.has(name)).sort();
}

describe('injected-function self-containment (D6 regression)', () => {
  const INJECTED = () => [parseColor, relativeLuminance, contrastRatio, compositeOver, hexOf,
    colorEquals, isOldPaletteColor, motionViolations, normalizeMotionProperty, defaultMotionAllowed,
    classifyBorderFacts, uppercaseOf, maxDurationMs, describeElement, isVisibleElement,
    tokenColor, collectAnimations, runningGlyphSelectors,
    probeTokens, probeHierarchy, probeSeparation, probeStateColors, probeHeader,
    probeRunningGlyphs, probeRunningReducedMotion, overlaySnapshot, probeMotion,
    probeReducedMotion, probeContrastSurface, probeChromeTheme, modalFocusRestoreFacts, probePagePan];
  test('no injected function references a name the page never receives', () => {
    const kit = pageKit();
    for (const fn of INJECTED()) {
      const free = freeIdentifiers(`${kit}\n${fn.toString()}`, fn.toString());
      expect(free, `${fn.name || '(anonymous)'} leaks non-injected identifiers`).toEqual([]);
    }
  });
  test('the detector catches a module-constant reference (the D6 bug shape)', () => {
    // The exact shape of defect D6: an injected function reading a module
    // constant that pageKit() never ships to the page.
    function buggyIsOldPaletteColor(input) {
      const parsed = typeof input === 'string' ? parseColor(input) : input;
      if (!parsed || parsed.a < 0.999) return false;
      return OLD_PALETTE_HEXES.some(hex => colorEquals(parsed, parseColor(hex), 0.5));
    }
    const free = freeIdentifiers(`${pageKit()}\n${buggyIsOldPaletteColor.toString()}`, buggyIsOldPaletteColor.toString());
    expect(free).toContain('OLD_PALETTE_HEXES');
    // ...and the same shape for a selector constant (the latent S8 variant).
    function buggyProbeRunning() {
      const glyphs = [];
      for (const selector of RUNNING_GLYPH_SELECTORS) glyphs.push(selector);
      return glyphs;
    }
    expect(freeIdentifiers(`${pageKit()}\n${buggyProbeRunning.toString()}`, buggyProbeRunning.toString()))
      .toContain('RUNNING_GLYPH_SELECTORS');
  });
  test('the detector knows property accesses, keys, shorthand and template parts', () => {
    const fnSource = [
      'function styledProbe(arg) {',
      '  const label = `value: ${arg.name}`;',
      '  const { text } = arg;',
      '  const parts = [text].map(part => part.trim());',
      '  return { label, count: parts.length, deep: arg?.meta?.id };',
      '}',
    ].join('\n');
    const free = freeIdentifiers(`${pageKit()}\n${fnSource}`, fnSource);
    expect(free).toEqual([]);
  });
});

describe('parseColor', () => {
  test('hex forms', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('#17181b'.toUpperCase())).toEqual({ r: 23, g: 24, b: 27, a: 1 });
    const withAlpha = parseColor('#ff000080');
    expect(withAlpha.r).toBe(255);
    closeTo(withAlpha.a, 128 / 255, 0.0001);
  });
  test('rgb/rgba legacy and modern syntax', () => {
    expect(parseColor('rgb(24, 24, 24)')).toEqual({ r: 24, g: 24, b: 24, a: 1 });
    expect(parseColor('rgba(24,24,24,0.5)')).toEqual({ r: 24, g: 24, b: 24, a: 0.5 });
    expect(parseColor('rgb(24 24 24 / 50%)')).toEqual({ r: 24, g: 24, b: 24, a: 0.5 });
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
  test('color(srgb ...) form Chrome emits for wide-gamut resolution', () => {
    expect(parseColor('color(srgb 1 0 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    const srgb = parseColor('color(srgb 0.1 0.2 0.3 / 0.25)');
    closeTo(srgb.r, 25.5, 0.0001); closeTo(srgb.g, 51, 0.0001); closeTo(srgb.b, 76.5, 0.0001);
    expect(srgb.a).toBe(0.25);
    const srgbPercent = parseColor('color(srgb 50% 50% 50%)');
    closeTo(srgbPercent.r, 127.5, 0.0001);
    expect(srgbPercent.a).toBe(1);
  });
  test('transparent resolves; unresolvable keywords return null', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('none')).toBeNull();
    expect(parseColor('currentcolor')).toBeNull();
    expect(parseColor('inherit')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor('var(--th-bg)')).toBeNull();
    expect(parseColor('repeating-linear-gradient(red, blue)')).toBeNull();
    expect(parseColor(42)).toBeNull();
  });
});

describe('relativeLuminance and contrastRatio', () => {
  test('reference values', () => {
    closeTo(relativeLuminance(parseColor('#ffffff')), 1, 0.001);
    closeTo(relativeLuminance(parseColor('#000000')), 0, 0.001);
    closeTo(relativeLuminance(parseColor('#767676')), 0.1812, 0.001);
  });
  test('contrast extremes and design tokens', () => {
    closeTo(contrastRatio(parseColor('#ffffff'), parseColor('#000000')), 21, 0.01);
    closeTo(contrastRatio(parseColor('#767676'), parseColor('#ffffff')), 4.54, 0.01);
    // Contract dark canvas: --th-text #ededf0 on --th-bg #17181b must clear 4.5.
    expect(contrastRatio(parseColor('#ededf0'), parseColor('#17181b'))).toBeGreaterThan(CONTRAST_BODY_MIN);
    // Contract light muted #5f5f68 on white must clear 4.5.
    expect(contrastRatio(parseColor('#5f5f68'), parseColor('#ffffff'))).toBeGreaterThan(CONTRAST_BODY_MIN);
  });
  test('the old flat ladder fails the S3 hierarchy gate, the new one passes', () => {
    const oldText = parseColor('#dfdfdf'), oldMuted = parseColor('#b3b3b3');
    expect(contrastRatio(oldText, oldMuted)).toBeLessThan(HIERARCHY_MIN_RATIO);
    const newText = parseColor('#ededf0'), newMuted = parseColor('#a1a1aa');
    expect(contrastRatio(newText, newMuted)).toBeGreaterThanOrEqual(HIERARCHY_MIN_RATIO);
  });
});

describe('compositeOver', () => {
  test('opaque top wins; half-white over black lands on mid grey', () => {
    expect(compositeOver({ r: 10, g: 20, b: 30, a: 1 }, { r: 200, g: 200, b: 200, a: 1 }))
      .toEqual({ r: 10, g: 20, b: 30, a: 1 });
    const over = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
    closeTo(over.r, 127.5); closeTo(over.g, 127.5); closeTo(over.b, 127.5);
    expect(over.a).toBe(1);
  });
  test('stacked translucent layers accumulate alpha', () => {
    const stacked = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 255, g: 255, b: 255, a: 0.5 });
    closeTo(stacked.a, 0.75);
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0 }, { r: 9, g: 9, b: 9, a: 0 })).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('hexOf and colorEquals', () => {
  test('round trips and clamping', () => {
    expect(hexOf(parseColor('#8B7CF6'))).toBe('#8b7cf6');
    expect(hexOf({ r: 300, g: -5, b: 0, a: 1 })).toBe('#ff0000');
    expect(hexOf(null)).toBeNull();
  });
  test('equality tolerance covers computed-style rounding', () => {
    expect(colorEquals(parseColor('#a1a1aa'), parseColor('rgb(161, 161, 170)'))).toBe(true);
    expect(colorEquals(parseColor('#a1a1aa'), parseColor('#a1a1ab'))).toBe(true);
    expect(colorEquals(parseColor('#a1a1aa'), parseColor('#9d9da8'))).toBe(false);
    expect(colorEquals(parseColor('rgba(161,161,170,1)'), parseColor('rgba(161,161,170,0.985)'))).toBe(true);
    expect(colorEquals(parseColor('rgba(161,161,170,1)'), parseColor('rgba(161,161,170,0.9)'))).toBe(false);
    expect(colorEquals(null, parseColor('#000'))).toBe(false);
  });
});

describe('isOldPaletteColor', () => {
  test('flags every pre-redesign hex in any notation', () => {
    for (const hex of OLD_PALETTE_HEXES) expect(isOldPaletteColor(hex)).toBe(true);
    expect(isOldPaletteColor('rgb(40, 40, 40)')).toBe(true);
    expect(isOldPaletteColor('rgb(223, 223, 223)')).toBe(true);
    expect(isOldPaletteColor('#181818'.toUpperCase())).toBe(true);
  });
  test('ignores near-misses, alphas and the new canvas', () => {
    expect(isOldPaletteColor('#17181b')).toBe(false);
    expect(isOldPaletteColor('#181819')).toBe(false);
    expect(isOldPaletteColor('rgba(24, 24, 24, 0.5)')).toBe(false);
    expect(isOldPaletteColor('none')).toBe(false);
    expect(isOldPaletteColor('#dfdfde')).toBe(false);
  });
});

describe('motionViolations', () => {
  test('contract allowlist passes, geometry fails', () => {
    expect(motionViolations(['transform', 'opacity'])).toEqual([]);
    expect(motionViolations(['filter', 'clip-path', 'stroke-dashoffset', 'background-position'])).toEqual([]);
    expect(motionViolations(['color', 'background-color', 'border-color', 'box-shadow'])).toEqual([]);
    expect(motionViolations(['grid-template-rows'])).toEqual([]);
    expect(motionViolations(['width', 'left'])).toEqual(['width', 'left']);
    expect(motionViolations(['transform', 'height', 'transform'])).toEqual(['height']);
    expect(motionViolations(['margin-top'])).toEqual(['margin-top']);
  });
  test('normalization, comma lists and the indeterminate all', () => {
    expect(motionViolations(['TRANSFORM', ' Opacity '])).toEqual([]);
    expect(motionViolations(['transform, width'])).toEqual(['width']);
    expect(motionViolations(['all'])).toEqual(['all (enumerate animated properties explicitly)']);
    expect(motionViolations([])).toEqual([]);
    expect(motionViolations(null)).toEqual([]);
  });
  test('per-side border longhands count as border-color (Chrome reporting)', () => {
    expect(motionViolations(['border-bottom-color'])).toEqual([]);
    expect(motionViolations(['border-left-color, opacity'])).toEqual([]);
    expect(motionViolations(['border-top-color', 'width'])).toEqual(['width']);
  });
  test('custom allowlists are honoured', () => {
    expect(motionViolations(['width'], ['width'])).toEqual([]);
    expect(motionViolations(['opacity'], ['width'])).toEqual(['opacity']);
    expect(defaultMotionAllowed()).toContain('grid-template-rows');
  });
});

describe('classifyBorderFacts (S4 core)', () => {
  const side = (width, alpha = 1) => [{ width, color: { r: 255, g: 255, b: 255, a: alpha } }, { width: 0, color: null }, { width: 0, color: null }, { width: 0, color: null }];
  const facts = [
    { excluded: false, parentIndex: -1, sides: side(1) },          // 0 bordered root
    { excluded: false, parentIndex: 0, sides: side(1) },           // 1 bordered, nested directly
    { excluded: false, parentIndex: 1, sides: side(1) },           // 2 bordered, nested deeper
    { excluded: false, parentIndex: 0, sides: side(0) },           // 3 unbordered
    { excluded: false, parentIndex: 3, sides: side(1) },           // 4 bordered, nested through unbordered parent
    { excluded: true, parentIndex: 0, sides: side(2) },            // 5 form field, excluded from the census
    { excluded: false, parentIndex: 5, sides: side(1) },           // 6 bordered, nested through excluded ancestor
    { excluded: false, parentIndex: 0, sides: side(1, 0.01) },     // 7 alpha below visibility threshold
  ];
  test('counts and nesting (any bordered ancestor within the pane)', () => {
    const census = classifyBorderFacts(facts);
    expect(census.borderedCount).toBe(5);
    expect(census.nestedBorderedCount).toBe(4);
    expect(census.nested).toEqual([1, 2, 4, 6]);
    expect(census.bordered).toEqual([0, 1, 2, 4, 6]);
  });
  test('empty input', () => {
    expect(classifyBorderFacts([])).toEqual({ borderedCount: 0, nestedBorderedCount: 0, bordered: [], nested: [] });
  });
  test('a parent-reference cycle terminates instead of spinning', () => {
    const cyclic = [
      { excluded: false, parentIndex: 2, sides: side(1) },
      { excluded: false, parentIndex: 0, sides: side(1) },
      { excluded: false, parentIndex: 1, sides: side(1) },
    ];
    const census = classifyBorderFacts(cyclic);
    expect(census.borderedCount).toBe(3);
    expect(census.nestedBorderedCount).toBe(3);
  });
  test('the remap contract: filtered arrays must carry remapped parentIndex values', () => {
    // Full tree: 0 bordered root, 1 invisible unbordered middle, 2 bordered leaf.
    const full = [
      { excluded: false, parentIndex: -1, sides: side(1) },
      { excluded: false, parentIndex: 0, sides: side(0) },
      { excluded: false, parentIndex: 1, sides: side(1) },
    ];
    // Visibility filter drops the middle element - exactly what probeSeparation
    // does. Without remapping, stale indices point at the wrong facts.
    const counted = full.filter(fact => fact.sides[0].width !== 0 || fact !== full[1]);
    const kept = [full[0], full[2]];
    const remap = new Map(kept.map((fact, position) => [full.indexOf(fact), position]));
    const remapped = kept.map(fact => ({ ...fact, parentIndex: remap.get(fact.parentIndex) ?? -1 }));
    const census = classifyBorderFacts(remapped);
    expect(census.borderedCount).toBe(2);
    // The invisible middle is gone, so the leaf's chain ends without reaching
    // the bordered root: no nesting through invisible boundaries.
    expect(census.nestedBorderedCount).toBe(0);
  });
});

describe('uppercaseOf (S5 core)', () => {
  test('counts only uppercase with real text', () => {
    const facts = [
      { textTransform: 'uppercase', text: 'RUNNING' },
      { textTransform: 'uppercase', text: '   ' },
      { textTransform: 'uppercase', text: '' },
      { textTransform: 'none', text: 'Running' },
      { textTransform: 'capitalize', text: 'Running' },
    ];
    const census = uppercaseOf(facts);
    expect(census.uppercaseCount).toBe(1);
    expect(census.uppercase).toEqual([0]);
    expect(uppercaseOf([]).uppercaseCount).toBe(0);
  });
});

describe('maxDurationMs', () => {
  test('parses CSS duration lists to the longest milliseconds value', () => {
    expect(maxDurationMs('0s')).toBe(0);
    expect(maxDurationMs('0.12s')).toBeCloseTo(120);
    expect(maxDurationMs('120ms')).toBeCloseTo(120);
    expect(maxDurationMs('0s, 0.18s')).toBeCloseTo(180);
    expect(maxDurationMs('200ms, 0s, 0.32s')).toBeCloseTo(320);
    expect(maxDurationMs('')).toBe(0);
    expect(maxDurationMs('none')).toBe(0);
    expect(maxDurationMs(null)).toBe(0);
  });
});

describe('pagePanVerdict (all screenshot cells)', () => {
  const settled = {
    scrollX: 0, scrollLeft: 0, scrollWidth: 390, innerWidth: 390,
    offender: null, active: 'textarea.th-chat-input-textarea',
  };

  test('a settled document and the one-pixel rounding allowance pass', () => {
    expect(pagePanVerdict(settled)).toEqual([]);
    expect(pagePanVerdict({ ...settled, scrollWidth: 391 })).toEqual([]);
  });

  test('a focused offscreen element that pans only window or scrollingElement fails', () => {
    for (const offsets of [{ scrollX: 40, scrollLeft: 0 }, { scrollX: 0, scrollLeft: 250 }, { scrollX: -2, scrollLeft: 0 }]) {
      const failures = pagePanVerdict({ ...settled, ...offsets });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('horizontal document pan');
      expect(failures[0]).toContain('textarea.th-chat-input-textarea');
    }
  });

  test('an overflowing document fails and identifies the offending element', () => {
    const failures = pagePanVerdict({
      ...settled, scrollWidth: 392, offender: 'div.th-chat-pane (right=392px)',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('div.th-chat-pane (right=392px)');
    expect(failures[0]).toContain('scrollWidth=392 > innerWidth=390 + 1');
  });

  test('simultaneous scroll and overflow produce independent failure reasons', () => {
    const failures = pagePanVerdict({
      ...settled, scrollX: 264, scrollLeft: 264, scrollWidth: 654,
      offender: 'section.th-chat-scrollport (right=654px)',
    });
    expect(failures).toHaveLength(2);
    expect(failures.every(failure => failure.includes('section.th-chat-scrollport'))).toBe(true);
  });
});

describe('modalFocusRestoreDecision (G25 / S12 / S23)', () => {
  const hidden = {
    triggerRestorable: false, activeIsTrigger: false, activeIsBody: false, activeIsFallback: false,
  };

  test('visible trigger passes only when focus returns to that trigger', () => {
    expect(modalFocusRestoreDecision({ ...hidden, triggerRestorable: true, activeIsTrigger: true }))
      .toEqual({ pass: true, branch: 'trigger' });
    expect(modalFocusRestoreDecision({ ...hidden, triggerRestorable: true, activeIsFallback: true }))
      .toEqual({ pass: false, branch: 'trigger' });
  });

  test('hidden or detached trigger passes only for the composer or main fallback', () => {
    expect(modalFocusRestoreDecision({ ...hidden, activeIsFallback: true }))
      .toEqual({ pass: true, branch: 'fallback' });
    expect(modalFocusRestoreDecision({ ...hidden, activeIsTrigger: true }))
      .toEqual({ pass: false, branch: 'fallback' });
  });

  test('focus on body fails even when another flag is also set', () => {
    expect(modalFocusRestoreDecision({ ...hidden, activeIsBody: true }))
      .toEqual({ pass: false, branch: 'body' });
    expect(modalFocusRestoreDecision({
      triggerRestorable: true, activeIsTrigger: true, activeIsBody: true, activeIsFallback: true,
    })).toEqual({ pass: false, branch: 'body' });
  });

  test('S23 is a built-in non-stub probe', () => {
    const entry = buildScenarioRegistry([]).find(item => item.id === 'S23');
    expect(entry?.stub).toBe(false);
    expect(entry?.origin).toBe('builtin');
    expect(entry?.title).toContain('fallback');
    expect(typeof entry?.run).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Serialized-probe negative tests (review R1/R4). These drive the ACTUAL
// functions the browser executes - pageKit() + the probe's own source,
// evaluated through new Function-shaped code inside a controlled DOM - so a
// defect in the injected implementation cannot hide behind the pure helpers
// that merely share its file. jsdom supplies the DOM (layout-less: client
// rects are patched non-empty so isVisibleElement honors CSS hiding only).
// ---------------------------------------------------------------------------

import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';

/** Evaluate the real serialized probe inside a controlled jsdom document. */
function serializedProbeInDom(probeFn, arg, { html = '<body></body>', tokens = {}, animations = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://qa.local/' });
  const { window } = dom;
  window.Element.prototype.getClientRects = function () { return [{ width: 10, height: 10 }]; };
  for (const [name, value] of Object.entries(tokens)) {
    window.document.documentElement.style.setProperty(name, value);
  }
  if (animations) window.document.getAnimations = () => animations;
  // The real driver wraps the kit + probe in new Function(...) so a top-level
  // `return` is legal; window.eval evaluates a Program, so wrap the identical
  // source in an IIFE - same code, same realm.
  const source = `(function(){\n${pageKit()}\nreturn (${probeFn.toString()})(${JSON.stringify(arg)});\n})()`;
  return window.eval(source);
}

const contrastArg = { surface: 'unit', bodyMin: CONTRAST_BODY_MIN, faintMin: CONTRAST_FAINT_MIN };

describe('serialized probeContrastSurface (R1: descendant-over-ancestor compositing)', () => {
  test('review counterexample fails: white on rgba(255,255,255,.72) glass over black', async () => {
    const result = await serializedProbeInDom(probeContrastSurface, contrastArg, {
      html: `<body style="background-color: #000000">
        <div style="background-color: rgba(255, 255, 255, 0.72)">
          <span style="color: #ffffff">Read me on the glass panel</span>
        </div>
      </body>`,
      tokens: { '--th-faint': '#71717a', '--th-bg': '#17181b' },
    });
    // The correctly composited backdrop is #b8b8b8 (0.72 white over black),
    // not the ancestor's black: white text there measures ~1.99:1.
    expect(result.pass).toBe(false);
    expect(result.measurements.failedNodes).toBeGreaterThanOrEqual(1);
    expect(result.measurements.nodeFailures[0].background).toBe('#b8b8b8');
    expect(result.measurements.nodeFailures[0].ratio).toBeLessThan(4.5);
    expect(result.failures[0]).toContain('below contrast');
  });

  test('nested translucent layers composite in stack order, not ancestor-first', async () => {
    // inner rgba(0,0,0,.4) over outer rgba(255,255,255,.6) over black body
    // lands on #5c5c5c. The pre-fix walk painted the ancestors over the
    // descendants and reported pure black - a false pass for this text.
    const result = await serializedProbeInDom(probeContrastSurface, contrastArg, {
      html: `<body style="background-color: #000000">
        <div style="background-color: rgba(255, 255, 255, 0.6)">
          <div style="background-color: rgba(0, 0, 0, 0.4)">
            <span style="color: #c4c4cc">Nested translucent panel text</span>
          </div>
        </div>
      </body>`,
      tokens: { '--th-faint': '#71717a', '--th-bg': '#17181b' },
    });
    expect(result.pass).toBe(false);
    expect(result.measurements.nodeFailures[0].background).toBe('#5c5c5c');
    // Independent oracle: the same chain through the pure helper, in stack
    // order (innermost first, each ancestor painted UNDER).
    const inner = parseColor('rgba(0, 0, 0, 0.4)'), outer = parseColor('rgba(255, 255, 255, 0.6)');
    const expected = compositeOver(compositeOver(inner, outer), parseColor('#000000'));
    expect(hexOf(expected)).toBe(result.measurements.nodeFailures[0].background);
  });

  test('positive control: dark text on the same glass over black passes', async () => {
    const result = await serializedProbeInDom(probeContrastSurface, contrastArg, {
      html: `<body style="background-color: #000000">
        <div style="background-color: rgba(255, 255, 255, 0.72)">
          <span style="color: #18181b">Dark readable text</span>
        </div>
      </body>`,
      tokens: { '--th-faint': '#71717a', '--th-bg': '#17181b' },
    });
    expect(result.pass).toBe(true);
    expect(result.measurements.failedNodes).toBe(0);
    expect(result.measurements.textNodes).toBe(1);
  });

  test('an opaque panel terminates the walk without erasing translucent descendants', async () => {
    const result = await serializedProbeInDom(probeContrastSurface, contrastArg, {
      html: `<body style="background-color: rgba(255, 255, 255, 0.3)">
        <div style="background-color: #1d1e22">
          <span style="color: #ededf0">Opaque panel keeps its own contrast</span>
        </div>
      </body>`,
      tokens: { '--th-faint': '#71717a', '--th-bg': '#17181b' },
    });
    expect(result.pass).toBe(true);
  });
});

describe('serialized probeReducedMotion (R4: finite entrances must fail)', () => {
  const fakeAnimation = ({ iterations = 1, duration = 480, playState = 'running' } = {}) => ({
    playState,
    transitionProperty: 'opacity',
    animationName: 'th-enter',
    effect: {
      getKeyframes: () => [{ opacity: 0 }, { opacity: 1 }],
      getComputedTiming: () => ({ iterations, duration }),
    },
  });

  test('review counterexample fails: one running 480ms one-iteration entrance', async () => {
    const result = await serializedProbeInDom(probeReducedMotion, {}, {
      animations: [fakeAnimation({ iterations: 1, duration: 480, playState: 'running' })],
    });
    expect(result.pass).toBe(false);
    expect(result.measurements.animationCount).toBe(1);
    expect(result.failures.join(' ')).toContain('finite animations with duration > 1ms');
    expect(result.failures.join(' ')).toContain('480');
  });

  test('infinite animations keep failing regardless of duration', async () => {
    const result = await serializedProbeInDom(probeReducedMotion, {}, {
      animations: [fakeAnimation({ iterations: Infinity, duration: 0 })],
    });
    expect(result.pass).toBe(false);
    expect(result.failures.join(' ')).toContain('infinite animations');
  });

  test('a fully collapsed policy passes: no animations, zero transitions', async () => {
    const result = await serializedProbeInDom(probeReducedMotion, {}, {
      html: '<body><div style="transition: none">settled</div></body>',
      animations: [],
    });
    expect(result.pass).toBe(true);
    expect(result.measurements.animationCount).toBe(0);
  });

  test('the ~1ms collapse tolerance admits only effectively-zero durations', async () => {
    const collapsed = await serializedProbeInDom(probeReducedMotion, {}, {
      animations: [fakeAnimation({ iterations: 1, duration: 0.01, playState: 'finished' })],
    });
    expect(collapsed.pass).toBe(true);
    const above = await serializedProbeInDom(probeReducedMotion, {}, {
      animations: [fakeAnimation({ iterations: 1, duration: 2, playState: 'finished' })],
    });
    expect(above.pass).toBe(false);
  });
});

describe('S12 native-entry gate (R3: a deliberately blocked native trigger must fail)', () => {
  /** In-memory page adapter, the same shape as the review's executed
   * counterexample: locator/keyboard only, because a blocked open fails the
   * cycle before any in-page probe runs. `nativeClickError` simulates the
   * browser refusing the pointer - an element covered by another overlay or
   * with pointer-events:none never becomes clickable and Playwright reports
   * exactly this actionability-timeout message. */
  const pageAdapter = ({ nativeClickError = null } = {}) => {
    const calls = [];
    const page = {
      calls,
      locator(selector) {
        const handle = {
          first() { return handle; },
          isVisible: async () => selector === '.th-tree-node',
          hover: async () => { calls.push(`hover ${selector}`); },
          click: async () => {
            calls.push(`click ${selector}`);
            if (nativeClickError) throw new Error(nativeClickError);
          },
          dispatchEvent: async type => { calls.push(`dispatchEvent ${selector} ${type}`); },
        };
        return handle;
      },
      waitForSelector: async selector => { calls.push(`wait ${selector}`); },
      keyboard: { press: async key => { calls.push(`key ${key}`); } },
    };
    return page;
  };
  const cycleCtx = { scenario: 'S12', theme: 'dark', viewport: { label: '1280x900' }, shotsDir: '/tmp' };
  const noSyntheticEntry = page => page.calls.filter(call => call.startsWith('dispatchEvent'));

  test('a covered / pointer-events:none trigger rejects the opener - no synthetic fallback', async () => {
    const page = pageAdapter({ nativeClickError: 'click: Timeout 4000ms exceeded.' });
    let rejected = null;
    try { await openNewChatDialogNative(page); } catch (error) { rejected = error; }
    expect(rejected?.message).toBe('click: Timeout 4000ms exceeded.');
    expect(page.calls).toContain('hover .th-tree-node');
    expect(page.calls).toContain('click button[title="Add chat session"]');
    expect(noSyntheticEntry(page)).toEqual([]);
  });

  test('the blocked native trigger fails the S12 cycle and the failure is recorded', async () => {
    const page = pageAdapter({ nativeClickError: 'click: Timeout 4000ms exceeded.' });
    const cycle = await overlayCycle(page, cycleCtx, NEW_CHAT_DIALOG_SURFACE);
    expect(cycle.failures).toHaveLength(1);
    expect(cycle.failures[0]).toContain('new-chat-dialog: overlay did not open through its real entry point');
    expect(cycle.failures[0]).toContain('click: Timeout 4000ms exceeded.');
    expect(cycle.record.surface).toBe('new-chat-dialog');
    expect(cycle.record.entryMethod).toBe('native');
    expect(cycle.screenshots).toEqual([]);
    expect(noSyntheticEntry(page)).toEqual([]);
  });

  test('a healthy native click needs no synthetic entry either', async () => {
    const page = pageAdapter();
    await openNewChatDialogNative(page);
    expect(page.calls).toContain('click button[title="Add chat session"]');
    expect(page.calls).toContain('wait .th-modal-overlay');
    expect(noSyntheticEntry(page)).toEqual([]);
  });

  test('the new-chat surface opens through the native-only opener', () => {
    expect(NEW_CHAT_DIALOG_SURFACE.entryMethod).toBe('native');
    expect(NEW_CHAT_DIALOG_SURFACE.open).toBe(openNewChatDialogNative);
  });

  test('the harness source carries no synthetic click fallback anywhere', async () => {
    const source = await Bun.file(new URL('./visual-redesign.mjs', import.meta.url).pathname).text();
    // Call-site shape only: the method invocation `.dispatchEvent(`. Prose
    // (comments naming the removed fallback) must not trip the pin.
    expect(source).not.toContain('.dispatchEvent(');
    // R3 also pins that the file-editor entry stays a native click.
    expect(source).toContain("locator('.th-files-name--link').first().click()");
  });
});

describe('requiredInteractionVerdict (R4: broken required interactions fail S15)', () => {
  test('the swallowed-timeout shape from the review now fails', () => {
    const failures = requiredInteractionVerdict([
      { label: 'modal', error: 'click: Timeout 8000ms exceeded.' },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('modal');
    expect(failures[0]).toContain('Timeout 8000ms exceeded');
  });
  test('healthy interactions pass and un-inspected ones fail', () => {
    expect(requiredInteractionVerdict([{ label: 'settings', inspected: true, animationCount: 2 }])).toEqual([]);
    expect(requiredInteractionVerdict([])).toEqual([]);
    expect(requiredInteractionVerdict(null)).toEqual([]);
    const failures = requiredInteractionVerdict([{ label: 'shelf' }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no in-state motion inspection');
  });
});

describe('lead fix: S5 painted-border and S15 background-position longhands', () => {
  test('background-position-x/y longhands normalise onto the allowed shorthand', () => {
    expect(normalizeMotionProperty('background-position-x')).toBe('background-position');
    expect(normalizeMotionProperty('backgroundpositiony')).toBe('background-position');
    expect(motionViolations(['background-position-x', 'background-position-y'])).toEqual([]);
    expect(motionViolations(['width'])).toEqual(['width']);
  });
});

// Adversarial DOM for the serialized probeStateColors the browser actually
// runs (pageKit + the probe source). Colours are the resolved token values:
// jsdom does not substitute var(--th-*) inside computed border/stroke.
const stateColorTokens = {
  '--th-success': '#146c43',
  '--th-warning': '#a15c07',
  '--th-error': '#b3252e',
  '--th-accent': '#8b7cf6',
};

describe('serialized probeStateColors (painted borders and SVG enclosures)', () => {
  test('a 1px solid border coloured --th-error fails', () => {
    const result = serializedProbeInDom(probeStateColors, {}, {
      html: '<body><span class="th-tool-status" style="border: 1px solid #b3252e">failed</span></body>',
      tokens: stateColorTokens,
    });
    expect(result.pass).toBe(false);
    expect(result.measurements.stateColorViolationCount).toBeGreaterThan(0);
    expect(result.measurements.stateColorViolationSamples.every(sample => sample.token === 'error')).toBe(true);
    expect(result.measurements.stateColorViolationSamples[0].where).toContain('th-tool-status');
    expect(result.failures[0]).toContain('coloured border or stroke');
  });

  test('error-coloured text with a zero-width border passes', () => {
    const result = serializedProbeInDom(probeStateColors, {}, {
      html: '<body><span class="th-tool-status" style="color: #b3252e; border-width: 0; border-style: solid; border-color: #b3252e">failed</span></body>',
      tokens: stateColorTokens,
    });
    expect(result.pass).toBe(true);
    expect(result.measurements.stateColorViolationCount).toBe(0);
    expect(result.measurements.uppercaseCount).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test('an svg rect enclosure with an accent stroke fails', () => {
    const result = serializedProbeInDom(probeStateColors, {}, {
      html: '<body><svg><rect style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></rect></svg></body>',
      tokens: stateColorTokens,
    });
    expect(result.pass).toBe(false);
    expect(result.measurements.stateColorViolationCount).toBeGreaterThan(0);
    expect(result.measurements.stateColorViolationSamples.every(sample => sample.token === 'accent')).toBe(true);
    expect(result.measurements.stateColorViolationSamples[0].where).toBe('rect');
  });

  test('an svg circle glyph with an accent stroke passes', () => {
    const result = serializedProbeInDom(probeStateColors, {}, {
      html: '<body><svg><circle class="th-tool-glyph" style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></circle></svg></body>',
      tokens: stateColorTokens,
    });
    expect(result.pass).toBe(true);
    expect(result.measurements.stateColorViolationCount).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test('a T2-scoped census ignores sidebar and activity-shelf violations', async () => {
    const { probeChatStateColors } = await import('./visual-redesign-scenarios-t2.mjs');
    const html = `<body>
      <aside class="th-sidebar">
        <div class="th-sidebar-section-label" style="border: 1px solid #b3252e; text-transform: uppercase">Workspaces</div>
      </aside>
      <section class="th-chat-pane">
        <div class="th-activity-shelf">
          <span class="th-activity-chip" style="border: 1px solid #146c43; text-transform: uppercase">Active</span>
          <svg><rect style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></rect></svg>
        </div>
        <div class="th-chat-msg">plain transcript</div>
      </section>
    </body>`;
    const shared = serializedProbeInDom(probeStateColors, {}, { html, tokens: stateColorTokens });
    expect(shared.pass).toBe(false);
    expect(shared.measurements.stateColorViolationCount).toBeGreaterThan(0);
    expect(shared.measurements.uppercaseCount).toBeGreaterThan(0);
    const scoped = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: stateColorTokens });
    expect(scoped.pass).toBe(true);
    expect(scoped.scenario).toBe('S5');
    expect(scoped.measurements.stateColorViolationCount).toBe(0);
    expect(scoped.measurements.uppercaseCount).toBe(0);
    expect(scoped.measurements.tokens.error).toBe('#b3252e');
    expect(scoped.failures).toEqual([]);
  });
});

describe('lead fix: camelCase and hyphen-stripped motion property names', () => {
  test('strokeDashoffset / strokedashoffset normalise to stroke-dashoffset and are allowed', () => {
    expect(normalizeMotionProperty('strokeDashoffset')).toBe('stroke-dashoffset');
    expect(normalizeMotionProperty('strokedashoffset')).toBe('stroke-dashoffset');
    expect(normalizeMotionProperty('backgroundPositionX')).toBe('background-position');
    expect(motionViolations(['strokedashoffset', 'backgroundPositionY'])).toEqual([]);
    expect(motionViolations(['marginLeft'])).toEqual(['margin-left']);
  });
});

describe('serialized T2 S5/S8 exclusion of T4-owned elements', () => {
  const goalBar = `<body><section class="th-chat-pane">
    <section class="th-goal-shelf">
      <button type="button" class="th-goal-bar">
        <span id="goal-chip" class="th-activity-chip" style="text-transform: uppercase">Active</span>
      </button>
    </section>
  </section></body>`;
  const glyphs = glyphStyle => `<body>
    <span class="th-tool-glyph th-tool-glyph--running" style="${glyphStyle}"></span>
    <g id="dag-node" class="th-activity-gnode th-activity-gnode--running" style="stroke: #ededf0; fill: #000000; color: #ededf0"></g>
    <circle id="dag-status" class="th-activity-gstatus th-activity-gstatus--running" style="stroke: #ededf0; fill: none; color: #ededf0"></circle>
  </body>`;

  test('uppercase activity chip inside the goal bar is ignored', async () => {
    const { probeChatStateColors } = await import('./visual-redesign-scenarios-t2.mjs');
    const result = serializedProbeInDom(probeChatStateColors, {}, { html: goalBar, tokens: stateColorTokens });
    expect(result.pass).toBe(true);
    expect(result.measurements.uppercaseCount).toBe(0);
    expect(result.measurements.excludedSelectors).toEqual([
      '.th-activity-shelf', '.th-goal-shelf', '.th-goal-bar', '.th-activity-chip', '.th-activity-g*',
    ]);
    expect(result.measurements.excludedElementCount).toBeGreaterThan(0);
    expect(result.measurements.excludedSamples).toContain('span#goal-chip.th-activity-chip');
    expect(result.failures).toEqual([]);
  });

  test('uppercase text in a T2-owned element still fails', async () => {
    const { probeChatStateColors } = await import('./visual-redesign-scenarios-t2.mjs');
    const html = goalBar.replace(
      '</section></body>',
      '<span class="th-chat-kicker" style="text-transform: uppercase">Running</span></section></body>',
    );
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: stateColorTokens });
    expect(result.pass).toBe(false);
    expect(result.measurements.uppercaseCount).toBe(1);
    expect(result.measurements.uppercaseSamples[0].text).toBe('Running');
    expect(result.measurements.uppercaseSamples[0].where).toContain('th-chat-kicker');
    expect(result.failures[0]).toContain('th-chat-kicker');
    expect(result.failures.some(failure => failure.includes('th-activity-chip'))).toBe(false);
  });

  test('a non-accent running tool glyph still fails S8', async () => {
    const { probeChatRunningGlyphs } = await import('./visual-redesign-scenarios-t2.mjs');
    const result = serializedProbeInDom(probeChatRunningGlyphs, {}, {
      html: glyphs('background-color: #ededf0; color: #ededf0; border-color: #ededf0'),
      tokens: stateColorTokens,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some(failure => failure.includes('.th-tool-glyph--running'))).toBe(true);
    expect(result.failures.some(failure => failure.includes('th-activity-g'))).toBe(false);
    expect(result.measurements.excludedElementCount).toBe(2);
  });

  test('a non-accent DAG gnode is ignored by T2 S8 and still fails the shared probe', async () => {
    const { probeChatRunningGlyphs } = await import('./visual-redesign-scenarios-t2.mjs');
    const html = glyphs('background-color: #8b7cf6');
    const scoped = serializedProbeInDom(probeChatRunningGlyphs, {}, { html, tokens: stateColorTokens });
    expect(scoped.pass).toBe(true);
    expect(scoped.measurements.glyphsFound).toBe(1);
    expect(scoped.measurements.glyphs[0].selector).toBe('.th-tool-glyph--running');
    expect(scoped.measurements.excludedElementCount).toBe(2);
    expect(scoped.measurements.excludedSamples.some(sample => sample.includes('dag-node'))).toBe(true);
    const shared = serializedProbeInDom(probeRunningGlyphs, {}, { html, tokens: stateColorTokens });
    expect(shared.pass).toBe(false);
    expect(shared.failures.some(failure => failure.includes('.th-activity-gnode--running'))).toBe(true);
    expect(shared.failures.some(failure => failure.includes('.th-activity-gstatus--running'))).toBe(true);
  });
});
