/** Unit tests for the T3 (shell) scenario plugin's pure parts.
 *
 * Covers the verdict math the real-browser probes execute against the built
 * SPA (one implementation, tested here, driven there), the plugin/registry
 * contract with visual-redesign.mjs, the lean overview frame builder, and the
 * D6-class guard: in-page probes are serialized with fn.toString() into a
 * page that only has the shared kit, so any module-scope reference would
 * crash in-page - the identifier scan proves the probes are self-contained.
 * Run: bun test test/qa/visual-redesign-scenarios-t3.test.mjs */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScenarioRegistry } from './visual-redesign.mjs';
import { pageKit, probeStateColors } from './visual-redesign-probes.mjs';
import {
  ENTRANCE_RECORDER_SOURCE, armSidebarReversal, emptyStateVerdict, entranceVerdict, firstFamily, probeEmptyState,
  probeSelectionFacts, probeShellCoarseTargets, probeShellStateColors, probeSidebarMotion, probeSidebarStatic, scenarios, selectionVerdict, shellLiveFrame,
  sidebarFocusVerdict, sidebarReversalVerdict, sidebarStaticVerdict, runStateColorsShell,
} from './visual-redesign-scenarios-t3.mjs';

// ---------------------------------------------------------------------------
// Fixtures: pre-redesign baseline facts vs redesigned facts
// ---------------------------------------------------------------------------

const SANS = '"Pretendard Variable", Pretendard, -apple-system, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Code", monospace';

/** Everything .th-btn-add/.th-tree-count/.th-tree-running-dot/labels compute
 * on the pre-redesign shell (workspace-add-button.css, session-tree.css,
 * sidebar.css): dashed add button, mono count + brand, success-hued dot,
 * uppercase section label. */
const BASELINE_SIDEBAR = {
  sansFirst: 'Pretendard Variable', monoFirst: 'ui-monospace',
  addButton: { found: true, borderStyles: ['dashed', 'dashed', 'dashed', 'dashed'] },
  brand: { found: true, label: 'span.th-sidebar-logo', fontFamily: MONO },
  counts: [{ label: 'span.th-tree-count', text: '2', fontFamily: MONO }],
  dots: [{ label: 'span.th-tree-running-dot', background: '#22c55e', accent: '#8b7cf6', matchesAccent: false }],
  uppercase: [{ label: 'div.th-sidebar-section-label', text: 'Workspaces' }],
  runningChips: 1,
};

const REDESIGNED_SIDEBAR = {
  ...BASELINE_SIDEBAR,
  addButton: { found: true, borderStyles: ['none', 'none', 'none', 'none'] },
  brand: { found: true, label: 'span.th-sidebar-logo', fontFamily: SANS },
  counts: [{ label: 'span.th-tree-count', text: '2', fontFamily: SANS }],
  dots: [{ label: 'span.th-tree-running-dot', background: '#8b7cf6', accent: '#8b7cf6', matchesAccent: true }],
  uppercase: [],
};

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

describe('T3 plugin contract with the shared harness', () => {
  test('registers S5/S10/S11 and extends the S21 binary stub with G40', () => {
    expect(Object.keys(scenarios).sort()).toEqual(['S10', 'S11', 'S21', 'S5']);
    for (const probe of Object.values(scenarios)) expect(typeof probe).toBe('function');
    const registry = buildScenarioRegistry([{ file: 'visual-redesign-scenarios-t3.mjs', scenarios }]);
    const s5 = registry.find(entry => entry.id === 'S5');
    expect(s5.origin).toBe('plugin:visual-redesign-scenarios-t3.mjs');
    expect(s5.stub).toBe(false);
    expect(s5.run).toBe(scenarios.S5);
    for (const id of ['S10', 'S11', 'S21']) {
      const entry = registry.find(candidate => candidate.id === id);
      expect(entry.stub).toBe(false);
      expect(entry.origin).toBe('plugin:visual-redesign-scenarios-t3.mjs');
    }
    // Untouched ids keep their built-in registration.
    expect(registry.find(entry => entry.id === 'S1').origin).toBe('builtin');
    expect(registry.find(entry => entry.id === 'S13').stub).toBe(true);
  });

  test('S5 scores shell surfaces and does not score chat-pane or shelf hits', async () => {
    const source = await Bun.file(new URL('./visual-redesign-scenarios-t3.mjs', import.meta.url)).text();
    expect(source).toContain('ctx.probe(env.page, probeShellStateColors)');
    expect(source).not.toContain('ctx.probe(env.page, probeStateColors)');
    const probe = probeShellStateColors.toString();
    for (const selector of ['.th-sidebar', '.th-tree', '.th-picker-pane', '.th-toast', '.th-divider', '.th-activity-shelf', '.th-chat-pane']) {
      expect(probe).toContain(selector);
    }
  });

  test('S11 asserts the desktop picker and never records pass:null', async () => {
    const source = await Bun.file(new URL('./visual-redesign-scenarios-t3.mjs', import.meta.url)).text();
    expect(source).not.toContain('pass: null');
    expect(source).toContain("root: '.th-picker-pane'");
    expect(source).toContain('requireDisplayTier: true');
    expect(source).toContain('picker pane absent');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('firstFamily', () => {
  test('extracts the first family of quoted and unquoted stacks', () => {
    expect(firstFamily(SANS)).toBe('Pretendard Variable');
    expect(firstFamily(MONO)).toBe('ui-monospace');
    expect(firstFamily('menlo, monospace')).toBe('menlo');
    expect(firstFamily('')).toBeNull();
    expect(firstFamily(null)).toBeNull();
    expect(firstFamily(undefined)).toBeNull();
  });
});

describe('shellLiveFrame', () => {
  test('builds a wire-schema-shaped lean overview frame', () => {
    const frame = shellLiveFrame({ sessionId: 'stored-a', title: 'Stored A', agents: 3, now: 1234 });
    expect(frame).toEqual({
      type: 'sessions.activity', sessionId: 'stored-a', durableSessionId: 'stored-a', overflow: false,
      title: 'Stored A', active: true, running: { agents: 3 }, last_activity_ms: 1234, last_line: 'go test ./...',
    });
  });
  test('defaults are sane and sessionId is required', () => {
    const frame = shellLiveFrame({ sessionId: 'x' });
    expect(frame.running.agents).toBe(2);
    expect(frame.active).toBe(true);
    expect(Number.isFinite(frame.last_activity_ms)).toBe(true);
    expect(() => shellLiveFrame({})).toThrow(/sessionId/);
  });
});

describe('sidebarStaticVerdict (S10 static assertions)', () => {
  test('the pre-redesign baseline fails: dashed button, mono count+brand, dot hue, uppercase', () => {
    const failures = sidebarStaticVerdict(BASELINE_SIDEBAR);
    expect(failures.some(f => f.includes('dashed'))).toBe(true);
    expect(failures.some(f => f.includes('mono stack') && f.includes('th-tree-count'))).toBe(true);
    expect(failures.some(f => f.includes('mono stack') && f.includes('th-sidebar-logo'))).toBe(true);
    expect(failures.some(f => f.includes('expected --th-accent'))).toBe(true);
    expect(failures.some(f => f.includes('uppercase'))).toBe(true);
  });
  test('each assertion fails alone (no single fix can green the whole baseline)', () => {
    const dashedOnly = sidebarStaticVerdict({ ...REDESIGNED_SIDEBAR, addButton: BASELINE_SIDEBAR.addButton });
    expect(dashedOnly).toHaveLength(1);
    const monoCountOnly = sidebarStaticVerdict({ ...REDESIGNED_SIDEBAR, counts: BASELINE_SIDEBAR.counts });
    expect(monoCountOnly).toHaveLength(1);
    const dotOnly = sidebarStaticVerdict({ ...REDESIGNED_SIDEBAR, dots: BASELINE_SIDEBAR.dots });
    expect(dotOnly).toHaveLength(1);
    const upperOnly = sidebarStaticVerdict({ ...REDESIGNED_SIDEBAR, uppercase: BASELINE_SIDEBAR.uppercase });
    expect(upperOnly).toHaveLength(1);
    const brandOnly = sidebarStaticVerdict({ ...REDESIGNED_SIDEBAR, brand: BASELINE_SIDEBAR.brand });
    expect(brandOnly).toHaveLength(1);
  });
  test('the redesigned shell passes', () => {
    expect(sidebarStaticVerdict(REDESIGNED_SIDEBAR)).toEqual([]);
  });
  test('fixture contracts fail loudly: missing button, counts or dots', () => {
    const failures = sidebarStaticVerdict({ ...REDESIGNED_SIDEBAR, addButton: { found: false }, counts: [], dots: [] });
    expect(failures.some(f => f.includes('.th-btn-add not found'))).toBe(true);
    expect(failures.some(f => f.includes('no numeric sidebar counts'))).toBe(true);
    expect(failures.some(f => f.includes('no running session dot'))).toBe(true);
  });
});

describe('selectionVerdict (S10 selection idiom)', () => {
  const treatment = { label: 'Stored A row', background: 'rgb(52, 53, 60)', borderColors: [] };
  test('baseline class-move passes with a non-coloured-border fill', () => {
    const verdict = selectionVerdict(
      { activeRows: [{ label: 'Stored A…long' }], indicators: [], activeTreatment: treatment },
      { activeRows: [{ label: 'Newer' }], indicators: [], activeTreatment: { ...treatment, label: 'Newer row' } },
    );
    expect(verdict.mode).toBe('class');
    expect(verdict.failures).toEqual([]);
  });
  test('a coloured border on the selected row fails (state-by-border)', () => {
    const verdict = selectionVerdict(
      { activeRows: [{ label: 'Stored A' }], indicators: [], activeTreatment: treatment },
      {
        activeRows: [{ label: 'Newer' }], indicators: [],
        activeTreatment: { ...treatment, borderColors: [{ on: 'row', color: '#8b7cf6', token: 'accent' }] },
      },
    );
    expect(verdict.failures.join('\n')).toContain('coloured border');
  });
  test('one visible persistent indicator follows the newly selected row', () => {
    const verdict = selectionVerdict(
      {
        activeRows: [{ label: 'Stored A' }], activeTreatment: treatment,
        indicators: [{ id: 1, visible: true, painted: true, aligned: true, label: 'div.th-tree-indicator', parentLabel: 'div.th-tree', transform: 'matrix(1, 0, 0, 1, 0, 0)' }],
      },
      {
        activeRows: [{ label: 'Newer' }], activeTreatment: treatment,
        indicators: [{ id: 1, visible: true, painted: true, aligned: true, label: 'div.th-tree-indicator', parentLabel: 'div.th-tree', transform: 'matrix(1, 0, 0, 1, 0, 96)' }],
      },
    );
    expect(verdict.mode).toBe('indicator');
    expect(verdict.failures).toEqual([]);
  });
  test('zero or multiple selected rows fail', () => {
    expect(selectionVerdict({ activeRows: [] }, { activeRows: [], indicators: [] }).failures[0]).toContain('exactly one selected');
    const two = selectionVerdict(
      { activeRows: [{ label: 'A' }] },
      { activeRows: [{ label: 'A' }, { label: 'B' }], indicators: [] },
    );
    expect(two.failures[0]).toContain('found 2');
  });
  test('a static selection (nothing moved, no indicator) fails', () => {
    const verdict = selectionVerdict(
      { activeRows: [{ label: 'Stored A' }], indicators: [], activeTreatment: treatment },
      { activeRows: [{ label: 'Stored A' }], indicators: [], activeTreatment: treatment },
    );
    expect(verdict.failures[0]).toContain('selection did not move');
  });
});

describe('emptyStateVerdict (S11 presence)', () => {
  test('the pre-redesign picker-branch baseline fails: no orb, no greeting heading', () => {
    const failures = emptyStateVerdict({
      emptyCount: 1, monoFirst: 'ui-monospace',
      orb: { found: false }, greeting: { found: false }, cta: { found: true, name: 'New chat session' },
    });
    expect(failures.some(f => f.includes('no orb'))).toBe(true);
    expect(failures.some(f => f.includes('no greeting'))).toBe(true);
    expect(failures).toHaveLength(2);
  });
  test('a dashed, non-circular glyph box fails both orb assertions', () => {
    const failures = emptyStateVerdict({
      emptyCount: 1, monoFirst: 'ui-monospace',
      orb: { found: true, label: 'div.th-empty-glyph', width: 96, height: 48, radiusPx: 12, circular: false, borderStyle: 'dashed' },
      greeting: { found: true, label: 'h2.th-empty-title', text: 'No chat session selected', textTransform: 'none', fontFamily: SANS },
      cta: { found: true, name: 'New chat' },
    });
    expect(failures.some(f => f.includes('not circular'))).toBe(true);
    expect(failures.some(f => f.includes('dashed'))).toBe(true);
  });
  test('orb + sans greeting + CTA passes', () => {
    expect(emptyStateVerdict({
      emptyCount: 1, monoFirst: 'ui-monospace',
      orb: { found: true, label: 'div.th-empty-orb', width: 64, height: 64, radiusPx: 32, circular: true, borderStyle: 'none' },
      greeting: { found: true, label: 'h2.th-empty-title', text: 'Where should we start?', textTransform: 'none', fontFamily: SANS },
      cta: { found: true, name: 'New chat' },
    })).toEqual([]);
  });
  test('mono or uppercase greetings fail', () => {
    const mono = emptyStateVerdict({
      emptyCount: 1, monoFirst: 'ui-monospace',
      orb: { found: true, circular: true, borderStyle: 'none', label: 'orb' },
      greeting: { found: true, label: 'h2', text: 'Hi', textTransform: 'none', fontFamily: MONO },
      cta: { found: true, name: 'New chat' },
    });
    expect(mono.some(f => f.includes('mono stack'))).toBe(true);
    const upper = emptyStateVerdict({
      emptyCount: 1, monoFirst: 'ui-monospace',
      orb: { found: true, circular: true, borderStyle: 'none', label: 'orb' },
      greeting: { found: true, label: 'h2', text: 'Hi', textTransform: 'uppercase', fontFamily: SANS },
      cta: { found: true, name: 'New chat' },
    });
    expect(upper.some(f => f.includes('uppercase'))).toBe(true);
  });
  test('a missing CTA or missing empty layout fails', () => {
    const noCta = emptyStateVerdict({
      emptyCount: 1, monoFirst: 'ui-monospace',
      orb: { found: true, circular: true, borderStyle: 'none', label: 'orb' },
      greeting: { found: true, label: 'h2', text: 'Hi', textTransform: 'none', fontFamily: SANS },
      cta: { found: false },
    });
    expect(noCta.some(f => f.includes('no New chat CTA'))).toBe(true);
    expect(emptyStateVerdict({ emptyCount: 0 })).toEqual(['no empty layout (.th-empty) rendered']);
  });
});

describe('entranceVerdict (S11 choreography)', () => {
  test('no events fails: the baseline has no entrance choreography', () => {
    expect(entranceVerdict({ events: [] })[0]).toContain('no finite entrance animation');
  });
  test('one finite entrance animation passes', () => {
    expect(entranceVerdict({
      events: [{ kind: 'animation', name: 'th-empty-enter', label: 'div.th-empty', replays: 1, iterations: 1, duration: 480, properties: ['opacity', 'transform'] }],
    })).toEqual([]);
  });
  test('hover-colour-only transitions and infinite glyphs are not entrance', () => {
    expect(entranceVerdict({
      events: [
        { kind: 'transition', name: 'background-color', label: 'button.th-btn', replays: 3, iterations: 1, duration: 120, properties: ['background-color'] },
        { kind: 'animation', name: 'th-dot-pulse', label: 'span.th-overview-card-running-dot', replays: 1, iterations: -1, duration: 1280, properties: ['opacity'] },
      ],
    })[0]).toContain('no finite entrance animation');
  });
  test('a replayed entrance fails the one-time rule', () => {
    const failures = entranceVerdict({
      events: [{ kind: 'animation', name: 'th-empty-enter', label: 'div.th-empty', replays: 2, iterations: 1, duration: 480, properties: ['opacity'] }],
    });
    expect(failures.some(f => f.includes('restarted 2 times'))).toBe(true);
  });
  test('under reduced motion any started animation fails, none passes', () => {
    expect(entranceVerdict({ events: [] }, { reduced: true })).toEqual([]);
    const failures = entranceVerdict({
      events: [{ kind: 'animation', name: 'th-empty-enter', label: 'div.th-empty', replays: 1, iterations: 1, duration: 480, properties: ['opacity'] }],
    }, { reduced: true });
    expect(failures[0]).toContain('under reduced motion');
  });
  test('unknown-property events stay strict (counted as entrance candidates)', () => {
    expect(entranceVerdict({
      events: [{ kind: 'animation', name: 'x', label: 'y', replays: 1, iterations: 1, properties: [] }],
    })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Serialized-probe integrity (D6 class: no module references in-page)
// ---------------------------------------------------------------------------

describe('in-page probes serialize cleanly with the shared kit', () => {
  const probes = [probeSidebarStatic, probeSidebarMotion, probeSelectionFacts, probeEmptyState, probeShellStateColors, probeShellCoarseTargets];
  test('kit-augmented sources parse', () => {
    for (const probe of probes) {
      expect(() => new Function(`${pageKit()}\nreturn (${probe.toString()})();`)).not.toThrow();
    }
  });

  // The identifier scan mirrors the shared harness's D6 scanner
  // (visual-redesign-probes.test.mjs) verbatim in semantics: mask
  // strings/template text/comments/regex bodies, collect identifiers in
  // reference position (property accesses and literal keys excluded), and
  // subtract every name bound anywhere in the combined kit+probe source plus
  // the page/JS globals the browser guarantees. It is deliberately
  // conservative: a local variable name that also exists inside a different
  // injected function could mask a reference (accepted residual risk,
  // documented there), but a module-level constant can never be declared
  // inside a serialized function, so the D6 class is always caught.
  const PAGE_GLOBALS = new Set([
    'document', 'window', 'getComputedStyle', 'Element', 'Node', 'NodeFilter', 'HTMLElement',
    'CSSAnimation', 'CSSTransition', 'requestAnimationFrame', 'fetch', 'console',
    'setTimeout', 'clearTimeout', 'getSelection', 'MutationObserver', 'ResizeObserver',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
    'Error', 'TypeError', 'RangeError', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap',
    'WeakSet', 'Proxy', 'Reflect', 'Intl', 'BigInt', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone', 'globalThis',
    'URL', 'URLSearchParams', 'Event', 'CustomEvent', 'innerWidth', 'innerHeight', 'matchMedia',
  ]);
  const JS_NON_REFERENCES = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
    'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this', 'throw',
    'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'static', 'get', 'set',
    'true', 'false', 'null', 'undefined', 'arguments', 'NaN', 'Infinity']);
  function maskSource(source) {
    const out = [];
    let i = 0;
    const sig = () => {
      for (let j = out.length - 1; j >= 0; j -= 1) if (!/\s/.test(out[j])) return out[j];
      return '';
    };
    const regexAllowed = () => !/[A-Za-z0-9_$)\]"']/.test(sig());
    function readString(quote) {
      out.push(quote); i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { out.push(' ', ' '); i += 2; continue; }
        out.push(source[i] === '\n' ? '\n' : ' '); i += 1;
      }
      if (i < source.length) { out.push(quote); i += 1; }
    }
    function readTemplate() {
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
        if (c === '`') { out.push('`'); i += 1; return; }
        if (c === '$' && source[i + 1] === '{') {
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
        if (c === '\n') break;
        out.push(' '); i += 1;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      if (source[i] === '/') { out.push('/'); i += 1; }
      while (i < source.length && /[a-z]/i.test(source[i])) { out.push(' '); i += 1; }
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
    const balancedEnd = openIndex => {
      const open = masked[openIndex];
      const close = open === '(' ? ')' : open === '[' ? ']' : '}';
      let depth = 0;
      for (let j = openIndex; j < masked.length; j += 1) {
        if (masked[j] === open) depth += 1;
        else if (masked[j] === close) { depth -= 1; if (depth === 0) return j; }
      }
      return openIndex;
    };
    const fnRe = /\bfunction\b\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
    let m;
    while ((m = fnRe.exec(masked))) {
      if (m[1]) names.add(m[1]);
      const open = m.index + m[0].length - 1;
      addIdentifierList(masked.slice(open + 1, balancedEnd(open)));
    }
    const catchRe = /\bcatch\s*\(/g;
    while ((m = catchRe.exec(masked))) {
      const open = m.index + m[0].length - 1;
      const end = balancedEnd(open);
      for (const token of identifierTokens(masked.slice(open + 1, end))) {
        if (!JS_NON_REFERENCES.has(token.name)) names.add(token.name);
      }
    }
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
    const declRe = /\b(?:const|let|var)\b/g;
    while ((m = declRe.exec(masked))) {
      let j = m.index + m[0].length;
      let expectBinding = true;
      let depth = 0;
      while (j < masked.length) {
        const c = masked[j];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (depth === 0 && (c === ';' || (c === '\n' && /\s*\n/.test(masked.slice(j, j + 2))))) break;
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
  function freeIdentifiers(combinedSource, fnSource) {
    const combined = maskSource(combinedSource);
    const scope = maskSource(fnSource);
    const declared = declaredNames(combined);
    return [...referencesIn(scope)].filter(name => !declared.has(name) && !PAGE_GLOBALS.has(name)).sort();
  }
  test('the scanner catches a module-constant reference (negative control)', () => {
    const bad = `${pageKit()}\nfunction badProbe() { return OLD_PALETTE_HEXES.length; }`;
    expect(freeIdentifiers(bad, 'function badProbe() { return OLD_PALETTE_HEXES.length; }')).toContain('OLD_PALETTE_HEXES');
  });
  test('the probes reference nothing outside the kit and the page globals', () => {
    for (const probe of probes) {
      expect(freeIdentifiers(`${pageKit()}\n${probe.toString()}`, probe.toString())).toEqual([]);
    }
  });
});

describe('ENTRANCE_RECORDER_SOURCE', () => {
  test('records animation and transition starts scoped to .th-empty', () => {
    expect(ENTRANCE_RECORDER_SOURCE).toContain("addEventListener('animationstart'");
    expect(ENTRANCE_RECORDER_SOURCE).toContain("addEventListener('transitionrun'");
    expect(ENTRANCE_RECORDER_SOURCE).toContain('.th-empty');
    expect(ENTRANCE_RECORDER_SOURCE).toContain('.th-picker-pane');
    expect(ENTRANCE_RECORDER_SOURCE).toContain('__thT3Entrance');
  });
  test('encodes infinite iterations JSON-safely and bounds itself', () => {
    expect(ENTRANCE_RECORDER_SOURCE).toContain('Infinity ? -1');
    expect(ENTRANCE_RECORDER_SOURCE).toContain('record.done = true');
    // The only timer is the done bound; entrance settling itself is
    // animation-finished based.
    expect((ENTRANCE_RECORDER_SOURCE.match(/setTimeout/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Adversarial real-DOM proof (T1 review lesson, binding): every probe must
// be PROVEN able to fail. Each test below executes the ACTUAL serialized
// in-page probe - the same `new Function(pageKit() + source)` form ctx.probe
// injects into Chrome - inside Bun.WebView against a controlled DOM fixture
// that violates the scenario, asserts the verdict fails, then asserts a
// compliant fixture passes. Real computed styles, real animation events.
// ---------------------------------------------------------------------------

const TOKENS_CSS = `
:root {
  --th-bg: #17181b; --th-surface: #1d1e22; --th-surface-raised: #25262b;
  --th-text: #ededf0; --th-text-dim: #c4c4cc; --th-muted: #a1a1aa; --th-faint: #71717a;
  --th-success: #34d399; --th-warning: #fbbf24; --th-error: #f87171; --th-accent: #8b7cf6;
  --th-font-sans: "Pretendard Variable", Pretendard, sans-serif;
  --th-font-mono: ui-monospace, "SF Mono", monospace;
}
body { margin: 0; font-family: var(--th-font-sans); background: var(--th-bg); }
`;

const page = body => `<!doctype html><html><head><style>${TOKENS_CSS}</style></head><body>${body}</body></html>`;

async function withView(html, run) {
  const dir = await mkdtemp(join(tmpdir(), 't3-dom-'));
  const file = join(dir, 'fixture.html');
  await writeFile(file, html);
  const view = new Bun.WebView({ width: 900, height: 700 });
  try {
    await view.navigate(`file://${file}`);
    await view.evaluate('document.readyState');
    return await run(view);
  } finally {
    try { view.close(); } catch { /* best-effort disposal */ }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Exactly what ctx.probe injects: kit source + serialized probe, run in-page.
 * view.evaluate parses its argument as one expression, so every multi-
 * statement script goes through an IIFE wrapper. */
async function runSerialized(view, probeFunction, argJson = '{}') {
  return await view.evaluate(`(() => { ${pageKit()}\nreturn (${probeFunction.toString()})(${argJson}); })()`);
}

describe('serialized S21 coarse shell hit areas', () => {
  test('a 32px button fails the 44px minimum', async () => {
    await withView(page('<aside class="th-sidebar"><button aria-label="Settings" style="width:32px;height:32px"></button></aside>'), async view => {
      const result = await runSerialized(view, probeShellCoarseTargets, '{"root":".th-sidebar","requireCoarse":false}');
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({ name: 'Settings', size: { width: 32, height: 32 } });
      expect(result.failures.some(failure => failure.includes('<44px'))).toBe(true);
      expect(result.pass).toBe(false);
    });
  });

  test('a 44px button passes and records its selector and name', async () => {
    await withView(page('<aside class="th-sidebar"><button aria-label="Settings" style="width:44px;height:44px"></button></aside>'), async view => {
      const result = await runSerialized(view, probeShellCoarseTargets, '{"root":".th-sidebar","requireCoarse":false}');
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0].selector).toContain('.th-sidebar > button');
      expect(result.elements[0].name).toBe('Settings');
      expect(result.elements[0].size).toEqual({ width: 44, height: 44 });
      expect(result.failures).toEqual([]);
      expect(result.pass).toBe(true);
    });
  });

  test('two overlapping 44px hit areas fail even though sizes pass', async () => {
    await withView(page(`<aside class="th-sidebar" style="position:relative">
      <button aria-label="First" style="position:absolute;left:0;top:0;width:44px;height:44px"></button>
      <button aria-label="Second" style="position:absolute;left:22px;top:0;width:44px;height:44px"></button>
    </aside>`), async view => {
      const result = await runSerialized(view, probeShellCoarseTargets, '{"root":".th-sidebar","requireCoarse":false}');
      expect(result.elements).toHaveLength(2);
      expect(result.overlaps).toHaveLength(1);
      expect(result.failures.some(failure => failure.includes('hit areas overlap'))).toBe(true);
      expect(result.pass).toBe(false);
    });
  });
});

/** Evaluate a statement script (expression-wrapped evaluate, IIFE-wrapped call). */
async function runScript(view, statements) {
  return await view.evaluate(`(() => { ${statements} })()`);
}

/** Subscribe before the mutation, then require the actual start event. */
async function awaitViewStarts(view, eventType, selectors, trigger, action = null) {
  return view.evaluate(`(() => new Promise((resolve, reject) => {
    const pending = new Set(${JSON.stringify(selectors)});
    const finished = [];
    const action = ${JSON.stringify(action)};
    window.__thT3Finished = null;
    const timer = setTimeout(() => {
      document.removeEventListener(${JSON.stringify(eventType)}, onStart, true);
      reject(new Error('missing ${eventType}: ' + [...pending].join(', ')));
    }, 2500);
    function onStart(event) {
      const target = event.target;
      let capturedAnimation;
      for (const selector of pending) {
        if (!target.matches(selector)) continue;
        const animation = target.getAnimations().find(item =>
          ${JSON.stringify(eventType)} === 'animationstart'
            ? item instanceof CSSAnimation && item.animationName === event.animationName
            : item instanceof CSSTransition && item.transitionProperty === event.propertyName);
        if (!animation) {
          clearTimeout(timer);
          document.removeEventListener(${JSON.stringify(eventType)}, onStart, true);
          reject(new Error('missing animation at start: ' + selector));
          return;
        }
        finished.push(animation.finished);
        capturedAnimation = animation;
        if (action === 'finish') animation.finish();
        if (action === 'cancel') animation.cancel();
        pending.delete(selector);
      }
      if (pending.size === 0) {
        clearTimeout(timer);
        document.removeEventListener(${JSON.stringify(eventType)}, onStart, true);
        window.__thT3Finished = Promise.all(finished);
        window.__thT3Finished.catch(() => {});
        if (!action) {
          resolve(true);
          return;
        }
        const deadline = setTimeout(() => reject(new Error('animation completion after start deadline')), 2500);
        Promise.allSettled(finished).then(results => {
          clearTimeout(deadline);
          resolve({
            status: results.every(result => result.status === 'fulfilled') ? 'fulfilled' : 'rejected',
            absent: !target.getAnimations().includes(capturedAnimation),
          });
        }, reject);
      }
    }
    document.addEventListener(${JSON.stringify(eventType)}, onStart, true);
    try { ${trigger} } catch (error) {
      clearTimeout(timer);
      document.removeEventListener(${JSON.stringify(eventType)}, onStart, true);
      reject(error);
    }
  }))()`);
}

/** Await the completion captured by the in-page start listener, even if it
 * finished before this host evaluation is scheduled. */
async function awaitViewFinished(view) {
  return view.evaluate(`(() => {
    const finished = window.__thT3Finished;
    if (!finished) throw new Error('missing retained animation completion');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('animation.finished deadline')), 2500);
      finished.then(
        () => { clearTimeout(timer); resolve(true); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  })()`);
}

const SIDEBAR_BASELINE = page(`
<aside class="th-sidebar">
  <span class="th-sidebar-logo" style="font-family: var(--th-font-mono);">omo</span>
  <div class="th-sidebar-section-label" style="text-transform: uppercase;">Workspaces</div>
  <button type="button" class="th-btn-add" style="border: 1px dashed rgba(255,255,255,.10);">New workspace</button>
  <div class="th-tree" role="navigation">
    <div class="th-tree-workspace"><fieldset class="th-tree-children">
      <div class="th-tree-node">
        <button type="button" class="th-tree-activation"><span class="th-tree-label">Stored A</span></button>
        <span class="th-tree-count" style="font-family: var(--th-font-mono); border-radius: 999px;">2</span>
        <span class="th-tree-running" style="color: var(--th-success); border: 1px solid var(--th-success); border-radius: 999px;">
          <span class="th-tree-running-dot" style="width:5px;height:5px;border-radius:50%;background: var(--th-success);"></span>2
        </span>
      </div>
    </fieldset></div>
  </div>
</aside>`);

const SIDEBAR_REDESIGNED = page(`
<aside class="th-sidebar">
  <span class="th-sidebar-logo">omo</span>
  <div class="th-sidebar-section-label">Workspaces</div>
  <button type="button" class="th-btn-add" style="border: none;">New workspace</button>
  <div class="th-tree" role="navigation">
    <div class="th-tree-workspace"><fieldset class="th-tree-children">
      <div class="th-tree-node">
        <button type="button" class="th-tree-activation"><span class="th-tree-label">Stored A</span></button>
        <span class="th-tree-count" style="border-radius: 999px;">2</span>
        <span class="th-tree-running" style="border-radius: 999px;">
          <span class="th-tree-running-dot" style="width:5px;height:5px;border-radius:50%;background: var(--th-accent);"></span>2
        </span>
      </div>
    </fieldset></div>
  </div>
</aside>`);

describe('adversarial real-DOM proof: probeSidebarStatic + sidebarStaticVerdict (S10)', () => {
  test('the serialized probe fails the pre-redesign baseline DOM', async () => {
    await withView(SIDEBAR_BASELINE, async view => {
      const result = await runSerialized(view, probeSidebarStatic);
      const failures = sidebarStaticVerdict(result.measurements);
      expect(failures.some(f => f.includes('dashed'))).toBe(true);
      expect(failures.some(f => f.includes('th-tree-count') && f.includes('mono stack'))).toBe(true);
      expect(failures.some(f => f.includes('th-sidebar-logo') && f.includes('mono stack'))).toBe(true);
      expect(failures.some(f => f.includes('expected --th-accent'))).toBe(true);
      expect(failures.some(f => f.includes('uppercase'))).toBe(true);
      // The in-page facts carry the real computed values, not fixtures.
      expect(result.measurements.dots[0].background.toLowerCase()).toBe('#34d399');
      expect(result.measurements.addButton.borderStyles.every(style => style === 'dashed')).toBe(true);
    });
  });
  test('the serialized probe passes the redesigned DOM', async () => {
    await withView(SIDEBAR_REDESIGNED, async view => {
      const result = await runSerialized(view, probeSidebarStatic);
      expect(sidebarStaticVerdict(result.measurements)).toEqual([]);
      expect(result.measurements.dots[0].matchesAccent).toBe(true);
    });
  });
});

describe('serialized S10 focus probe', () => {
  const fixture = page(`
<aside class="th-sidebar" style="width:44px">
  <div class="th-sidebar-nav" style="display:none"><button class="th-sidebar-toggle">Collapse</button></div>
  <div class="th-sidebar-rail"><button class="th-sidebar-toggle">Expand</button></div>
</aside>
<main class="th-pane--focused" data-th-t3-focus-pane="s10-active">Pane</main>`);

  test('body focus fails despite a stable focused pane; the rail button passes', async () => {
    await withView(fixture, async view => {
      const button = await runSerialized(view, probeSidebarMotion);
      expect(sidebarFocusVerdict(button, 's10-active', true).join(' ')).toContain('sidebar focus');
      await runScript(view, `document.querySelector('.th-sidebar').classList.add('th-sidebar--collapsed');
document.querySelector('.th-sidebar-rail button').focus();`);
      const focused = await runSerialized(view, probeSidebarMotion);
      expect(focused.focusedPaneIdentity).toBe('s10-active');
      expect(sidebarFocusVerdict(focused, 's10-active', true)).toEqual([]);
      await runScript(view, `document.activeElement.blur();`);
      const lost = await runSerialized(view, probeSidebarMotion);
      expect(lost.activeElement).toBe('body');
      expect(lost.focusedPaneCount).toBe(1);
      expect(sidebarFocusVerdict(lost, 's10-active', true).join(' ')).toContain('sidebar focus');
    });
  });

  test('a hidden toolbar or changed pane identity fails', async () => {
    await withView(fixture, async view => {
      await runScript(view, `document.querySelector('.th-sidebar-rail button').focus();`);
      const focused = await runSerialized(view, probeSidebarMotion);
      expect(sidebarFocusVerdict(focused, 'different-pane', true).join(' ')).toContain('pane identity');
      await runScript(view, `document.querySelector('.th-sidebar-nav').style.display = 'block';
document.querySelector('.th-sidebar-nav button').focus();
document.querySelector('.th-sidebar-nav').style.visibility = 'hidden';`);
      const hidden = await runSerialized(view, probeSidebarMotion);
      expect(sidebarFocusVerdict(hidden, 's10-active', false).join(' ')).toContain('sidebar focus');
    });
  });
});

describe('serialized S10 keyboard reversal probe', () => {
  test('a fully settled ordinary collapse cannot satisfy the interruption verdict', async () => {
    await withView(page(`
<aside class="th-sidebar th-sidebar--collapsed" style="width:44px">
  <div class="th-sidebar-inner" style="opacity:0"></div>
  <div class="th-sidebar-nav"><button class="th-sidebar-toggle">Collapse</button></div>
</aside>`), async view => {
      await runScript(view, `document.querySelector('.th-sidebar-nav button').dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
      const settled = await runSerialized(view, probeSidebarMotion);
      expect(sidebarReversalVerdict(settled.reversingEvent)).toContain(
        'sidebar reversing Enter did not interrupt an intermediate paused opacity transition');
      await runScript(view, `window.__thT3SidebarReversal = { event: {
  key: 'Enter', trusted: true, started: true, collapsedBefore: false,
  playState: 'finished', currentTime: 200, duration: 200, progress: 1,
} };`);
      const completed = await runSerialized(view, probeSidebarMotion);
      expect(sidebarReversalVerdict(completed.reversingEvent)).not.toEqual([]);
      expect(sidebarReversalVerdict({
        ...completed.reversingEvent, playState: 'paused', currentTime: 100, progress: 0.5,
      })).toEqual([]);
    });
  });
  test('the in-page arming function serializes without module dependencies', () => {
    expect(() => new Function(`return (${armSidebarReversal.toString()});`)).not.toThrow();
  });
});

describe('adversarial real-DOM proof: probeSelectionFacts + selectionVerdict (S10)', () => {
  test('a coloured border on the newly selected row fails', async () => {
    await withView(page(`
<aside class="th-sidebar"><div class="th-tree" role="navigation">
  <div class="th-tree-workspace"><fieldset class="th-tree-children">
    <div class="th-tree-node th-tree-node--active">
      <button type="button" class="th-tree-activation" aria-current="true"><span class="th-tree-label">Stored A</span></button>
    </div>
    <div class="th-tree-node">
      <button type="button" class="th-tree-activation"><span class="th-tree-label">Newer</span></button>
    </div>
  </fieldset></div>
</div></aside>`), async view => {
      const before = await runSerialized(view, probeSelectionFacts);
      // Move the selection the way the app would, but encode state with a
      // coloured border - the exact violation S5/S10 exist to catch.
      await runScript(view, `
const rows = document.querySelectorAll('.th-tree-node');
rows[0].classList.remove('th-tree-node--active');
rows[0].querySelector('.th-tree-activation').removeAttribute('aria-current');
rows[1].classList.add('th-tree-node--active');
const activation = rows[1].querySelector('.th-tree-activation');
activation.setAttribute('aria-current', 'true');
activation.style.border = '1px solid var(--th-accent)';`);
      const after = await runSerialized(view, probeSelectionFacts);
      const verdict = selectionVerdict(before, after);
      expect(verdict.failures.join('\n')).toContain('coloured border');
      expect(verdict.failures.join('\n')).toContain('--th-accent');
    });
  });
  test('one moving indicator element passes', async () => {
    await withView(page(`
<aside class="th-sidebar"><div class="th-tree" role="navigation" style="position:relative;">
  <span class="th-tree-indicator" aria-hidden="true" style="position:absolute;top:0;left:0;width:200px;height:44px;transform: translateY(0px);background: var(--th-surface-raised);"></span>
  <div class="th-tree-workspace"><fieldset class="th-tree-children" style="margin:0;padding:0;border:0;">
    <div class="th-tree-node" style="width:200px;height:44px;"><button type="button" class="th-tree-activation" aria-current="true"><span class="th-tree-label">Stored A</span></button></div>
    <div class="th-tree-node" style="width:200px;height:44px;"><button type="button" class="th-tree-activation"><span class="th-tree-label">Newer</span></button></div>
  </fieldset></div>
</div></aside>`), async view => {
      const before = await runSerialized(view, probeSelectionFacts);
      await runScript(view, `
const rows = document.querySelectorAll('.th-tree-activation');
rows[0].removeAttribute('aria-current');
rows[1].setAttribute('aria-current', 'true');
document.querySelector('.th-tree-indicator').style.transform = 'translateY(44px)';`);
      const after = await runSerialized(view, probeSelectionFacts);
      const verdict = selectionVerdict(before, after);
      expect(verdict.mode).toBe('indicator');
      expect(verdict.failures).toEqual([]);
    });
  });
});

describe('serialized S10 selection counterexamples', () => {
  const fixture = indicator => page(`
<aside class="th-sidebar"><div class="th-tree" style="position:relative;">
  ${indicator}
  <div class="th-tree-workspace"><fieldset style="margin:0;padding:0;border:0;">
    <div class="th-tree-node" style="width:200px;height:44px;">
      <button class="th-tree-activation" aria-current="true"><span class="th-tree-label">Stored A</span></button>
    </div>
    <div class="th-tree-node" style="width:200px;height:44px;">
      <button class="th-tree-activation"><span class="th-tree-label">Newer</span></button>
    </div>
  </fieldset></div>
</div></aside>`);
  const indicator = '<span class="th-tree-indicator" style="position:absolute;top:0;left:0;width:200px;height:44px;transform:translateY(0px);background:var(--th-surface-raised);"></span>';
  const move = `
const rows = document.querySelectorAll('.th-tree-node');
rows[0].querySelector('button').removeAttribute('aria-current');
rows[1].querySelector('button').setAttribute('aria-current', 'true');`;

  test('transparent class-only selection fails; a painted row wash passes', async () => {
    await withView(fixture(''), async view => {
      const before = await runSerialized(view, probeSelectionFacts);
      await runScript(view, move);
      const after = await runSerialized(view, probeSelectionFacts);
      expect(selectionVerdict(before, after, 'Newer').failures.join(' ')).toContain('no visible');
      await runScript(view, `document.querySelectorAll('.th-tree-node')[1].style.background = 'var(--th-surface-raised)';`);
      expect(selectionVerdict(before, await runSerialized(view, probeSelectionFacts), 'Newer').failures).toEqual([]);
    });
  });

  for (const [name, mutation, expected] of [
    ['absent', `document.querySelector('.th-tree-indicator').remove();`, 'exactly one persistent'],
    ['hidden', `document.querySelector('.th-tree-indicator').style.visibility = 'hidden';`, 'hidden or has no painted'],
    ['duplicate', `document.querySelector('.th-tree').appendChild(document.querySelector('.th-tree-indicator').cloneNode());`, 'exactly one persistent'],
    ['replaced with the same description', `
const previous = document.querySelector('.th-tree-indicator');
previous.replaceWith(previous.cloneNode());`, 'replaced instead of moved'],
    ['misaligned', `document.querySelector('.th-tree-indicator').style.left = '400px';`, 'not aligned'],
  ]) {
    test(`${name} indicator fails after the real serialized selection probe`, async () => {
      await withView(fixture(indicator), async view => {
        const before = await runSerialized(view, probeSelectionFacts);
        await runScript(view, `${move}
document.querySelector('.th-tree-indicator').style.transform = 'translateY(44px)';
${mutation}`);
        const after = await runSerialized(view, probeSelectionFacts);
        expect(selectionVerdict(before, after, 'Newer').failures.join(' ')).toContain(expected);
      });
    });
  }
});

describe('adversarial real-DOM proof: probeEmptyState + emptyStateVerdict (S11)', () => {
  test('the serialized probe fails the pre-redesign glyph-box DOM', async () => {
    await withView(page(`
<main class="th-empty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:400px;">
  <div class="th-empty-glyph" style="border: 1px dashed rgba(255,255,255,.10); border-radius: 12px; font-family: var(--th-font-mono); padding: 12px 20px;">omo</div>
  <p class="th-empty-hint">Pick a chat session from the sidebar.</p>
  <button type="button" class="th-btn th-btn--primary">New chat session</button>
</main>`), async view => {
      const facts = await runSerialized(view, probeEmptyState);
      const failures = emptyStateVerdict(facts);
      expect(failures.some(f => f.includes('no orb'))).toBe(true);
      expect(failures.some(f => f.includes('no greeting'))).toBe(true);
      expect(facts.cta.found).toBe(true);
    });
  });
  test('the serialized probe passes the orb + greeting + CTA DOM', async () => {
    await withView(page(`
<main class="th-empty" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:400px;">
  <div class="th-empty-hero" style="display:flex;flex-direction:column;align-items:center;">
    <div class="th-empty-orb" aria-hidden="true" style="width:64px;height:64px;border-radius:50%;"></div>
    <h2 class="th-empty-title">Where should we start?</h2>
    <button type="button" class="th-btn th-btn--primary th-empty-cta">New chat</button>
  </div>
</main>`), async view => {
      const facts = await runSerialized(view, probeEmptyState);
      expect(emptyStateVerdict(facts)).toEqual([]);
      expect(facts.orb.circular).toBe(true);
      expect(facts.greeting.text).toBe('Where should we start?');
    });
  });
});

describe('adversarial real-DOM proof: probeStateColors on shell surfaces (S5)', () => {
  test('a success-coloured chip border and uppercase label fail the sweep', async () => {
    await withView(SIDEBAR_BASELINE, async view => {
      const result = await runSerialized(view, probeStateColors);
      expect(result.pass).toBe(false);
      expect(result.measurements.stateColorViolationCount).toBeGreaterThanOrEqual(1);
      expect(result.measurements.uppercaseCount).toBeGreaterThanOrEqual(1);
      const where = JSON.stringify(result.measurements.stateColorViolationSamples);
      expect(where).toContain('th-tree-running');
    });
  });
  test('the redesigned shell sweeps clean', async () => {
    await withView(SIDEBAR_REDESIGNED, async view => {
      const result = await runSerialized(view, probeStateColors);
      expect(result.pass).toBe(true);
      expect(result.measurements.stateColorViolationCount).toBe(0);
      expect(result.measurements.uppercaseCount).toBe(0);
    });
  });
});

describe('adversarial real-DOM proof: entrance recorder + entranceVerdict (S11)', () => {
  const ENTRANCE_HTML = page(`
<style>
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes pulse { from { opacity: 1; } to { opacity: .35; } }
.enter { animation: rise 480ms cubic-bezier(.16,1,.3,1) backwards; }
.pulse { animation: pulse 1280ms ease-in-out infinite alternate; }
.hovercolour { transition: background-color 120ms ease; padding: 8px; }
</style>
<main class="th-empty" style="height:300px;"><div id="host"></div></main>`);

  test('a finite entrance is recorded from real animation events and passes; infinite pulses do not count', async () => {
    await withView(ENTRANCE_HTML, async view => {
      await runScript(view, ENTRANCE_RECORDER_SOURCE);
      await awaitViewStarts(view, 'animationstart', ['.enter', '.pulse'],
        `document.getElementById('host').innerHTML = '<div class="enter">hello</div><div class="pulse" aria-hidden="true"></div>';`);
      const full = await view.evaluate('JSON.stringify(window.__thT3Entrance)');
      const parsed = JSON.parse(full);
      expect(parsed.events.length).toBeGreaterThanOrEqual(2);
      const enter = parsed.events.find(event => event.name === 'rise');
      expect(enter.iterations).toBe(1);
      expect(enter.properties).toEqual(expect.arrayContaining(['opacity', 'transform']));
      const pulse = parsed.events.find(event => event.name === 'pulse');
      expect(pulse.iterations).toBe(-1);
      expect(entranceVerdict(parsed)).toEqual([]);
      // The same real events fail the reduced-motion contract.
      expect(entranceVerdict(parsed, { reduced: true })[0]).toContain('under reduced motion');
    });
  });
  test('a replayed entrance fails the one-time rule', async () => {
    await withView(ENTRANCE_HTML, async view => {
      await runScript(view, ENTRANCE_RECORDER_SOURCE);
      await awaitViewStarts(view, 'animationstart', ['.enter'],
        `document.getElementById('host').innerHTML = '<div id="target" class="enter">hello</div>';`);
      await awaitViewFinished(view);
      // Remount the animated node: a genuine second start.
      await awaitViewStarts(view, 'animationstart', ['.enter'], `
const host = document.getElementById('host');
const target = document.getElementById('target');
target.remove();
host.appendChild(Object.assign(document.createElement('div'), { className: 'enter', textContent: 'hello' }));`);
      const parsed = JSON.parse(await view.evaluate('JSON.stringify(window.__thT3Entrance)'));
      const failures = entranceVerdict(parsed);
      expect(failures.some(f => f.includes('restarted 2 times'))).toBe(true);
    });
  });
  test('retains completion when the started animation ends before the host awaits it', async () => {
    await withView(ENTRANCE_HTML, async view => {
      const beforeHost = await awaitViewStarts(view, 'animationstart', ['#target'],
        `document.getElementById('host').innerHTML = '<div id="target" class="enter">hello</div>';`, 'finish');
      // The start handler finishes its captured Animation and observes its
      // retained completion before acknowledging this host evaluation.
      expect(beforeHost).toEqual({ status: 'fulfilled', absent: true });
      expect(await awaitViewFinished(view)).toBe(true);
    });
  });
  test('a missing start rejects instead of accepting an empty completion', async () => {
    await withView(ENTRANCE_HTML, async view => {
      await expect(awaitViewStarts(view, 'animationstart', ['#target'], `
document.getElementById('host').innerHTML = '<div id="target">hello</div>';`)).rejects.toThrow('missing animationstart');
    });
  });
  test('a cancelled animation rejects its retained completion', async () => {
    await withView(ENTRANCE_HTML, async view => {
      const beforeHost = await awaitViewStarts(view, 'animationstart', ['#target'],
        `document.getElementById('host').innerHTML = '<div id="target" class="enter">hello</div>';`, 'cancel');
      expect(beforeHost).toEqual({ status: 'rejected', absent: true });
      await expect(awaitViewFinished(view)).rejects.toThrow();
    });
  });
  test('a hover-colour-only transition is not an entrance, so alone it fails', async () => {
    await withView(ENTRANCE_HTML, async view => {
      await runScript(view, ENTRANCE_RECORDER_SOURCE);
      await view.evaluate('document.getElementById("host").innerHTML = \'<div id="hover" class="hovercolour">row</div>\'');
      await awaitViewStarts(view, 'transitionrun', ['#hover'], `
const target = document.getElementById('hover');
void target.offsetWidth;
target.style.backgroundColor = '#2c2d33';`);
      const parsed = JSON.parse(await view.evaluate('JSON.stringify(window.__thT3Entrance)'));
      expect(parsed.events[0].name).toBe('background-color');
      const failures = entranceVerdict(parsed);
      expect(failures[0]).toContain('no finite entrance animation');
    });
  });
  test('no events at all is the pre-redesign verdict: failure', async () => {
    await withView(ENTRANCE_HTML, async view => {
      await runScript(view, ENTRANCE_RECORDER_SOURCE);
      const parsed = JSON.parse(await view.evaluate('JSON.stringify(window.__thT3Entrance)'));
      expect(parsed.events).toEqual([]);
      expect(entranceVerdict(parsed)[0]).toContain('no finite entrance animation');
      expect(entranceVerdict(parsed, { reduced: true })).toEqual([]);
    });
  });
});

describe('emptyStateVerdict picker surface (S11 desktop)', () => {
  test('a missing picker pane fails closed', () => {
    expect(emptyStateVerdict({ surface: 'picker', rootCount: 0 })).toEqual(['no picker pane (.th-picker-pane) rendered']);
  });
  test('a picker without an orb or greeting fails even when a CTA exists', () => {
    const failures = emptyStateVerdict({
      surface: 'picker', rootCount: 1, requireDisplayTier: true, monoFirst: 'ui-monospace',
      orb: { found: false }, greeting: { found: false }, cta: { found: true, name: 'New chat session' },
    });
    expect(failures.some(f => f.includes('no orb'))).toBe(true);
    expect(failures.some(f => f.includes('no greeting'))).toBe(true);
    expect(failures.some(f => f.includes('CTA'))).toBe(false);
  });
  test('an orb whose greeting is not Display tier fails', () => {
    const failures = emptyStateVerdict({
      surface: 'picker', rootCount: 1, requireDisplayTier: true, monoFirst: 'ui-monospace',
      orb: { found: true, circular: true, borderStyle: 'none', label: 'div.th-empty-orb' },
      greeting: {
        found: true, label: 'h2.th-empty-title', text: 'Pick', textTransform: 'none', fontFamily: SANS,
        displayTier: false, fontSize: '12px', displaySize: '24px', fontWeight: '400', displayWeight: '590',
      },
      cta: { found: true, name: 'New chat session' },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Display tier');
  });
  test('circular orb plus Display greeting plus CTA passes', () => {
    expect(emptyStateVerdict({
      surface: 'picker', rootCount: 1, requireDisplayTier: true, monoFirst: 'ui-monospace',
      orb: { found: true, circular: true, borderStyle: 'none', label: 'div.th-empty-orb' },
      greeting: {
        found: true, label: 'h2.th-empty-title', text: 'What are we building today?', textTransform: 'none', fontFamily: SANS,
        displayTier: true, fontSize: '24px', displaySize: '24px', fontWeight: '590', displayWeight: '590',
      },
      cta: { found: true, name: 'New chat session' },
    })).toEqual([]);
  });
});

const PRESENCE_CSS = `
:root {
  --th-font-size: 14px;
  --th-type-display-size: calc(var(--th-font-size) * 1.7143);
  --th-type-display-line: 1.15;
  --th-type-display-tracking: -0.025em;
  --th-weight-announce: 590;
}`;
const presencePage = body => page(body).replace('</head>', `<style>${PRESENCE_CSS}</style></head>`);
const DISPLAY_HEADING = 'font-size: var(--th-type-display-size); font-weight: var(--th-weight-announce); line-height: var(--th-type-display-line); letter-spacing: var(--th-type-display-tracking);';

describe('adversarial real-DOM proof: probeShellStateColors (S5 shell scope)', () => {
  const outside = `
<div class="th-pane-wrap">
  <div class="th-chat-pane">
    <span class="th-tool-glyph th-tool-glyph--running" style="border: 1.5px solid var(--th-warning);">run</span>
    <span style="text-transform: uppercase;">Running</span>
  </div>
</div>
<div class="th-activity-shelf">
  <span class="th-activity-chip" style="text-transform: uppercase;">Active</span>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect id="shelf-rect" width="16" height="16" style="stroke: var(--th-warning); stroke-width: 2px; fill: none;"></rect></svg>
</div>`;
  test('chat-pane internals and the activity shelf are ignored, including non-rect strokes', async () => {
    await withView(page(`
<aside class="th-sidebar">
  <div class="th-sidebar-section-label">Workspaces</div>
  <span style="border-width: 0; border-style: solid; border-color: var(--th-warning);">quiet</span>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="8" cy="8" r="6" style="stroke: var(--th-warning); stroke-width: 2px; fill: none;"></circle></svg>
</aside>
${outside}`), async view => {
      const result = await runSerialized(view, probeShellStateColors);
      expect(result.pass).toBe(true);
      expect(result.measurements.stateColorViolationCount).toBe(0);
      expect(result.measurements.uppercaseCount).toBe(0);
      const blob = JSON.stringify(result.measurements);
      expect(blob).not.toContain('th-tool-glyph');
      expect(blob).not.toContain('th-activity-chip');
    });
  });
  test('a painted border, a rect stroke, and uppercase inside the shell fail', async () => {
    await withView(page(`
<aside class="th-sidebar">
  <div class="th-sidebar-section-label" style="text-transform: uppercase;">Workspaces</div>
  <span class="th-tree-running" style="border: 1px solid var(--th-warning);">2</span>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect id="shell-rect" width="16" height="16" style="stroke: var(--th-accent); stroke-width: 2px; fill: none;"></rect></svg>
</aside>
<hr class="th-divider" style="display: block; width: 4px; height: 48px; border-top: 4px solid var(--th-accent);">
${outside}`), async view => {
      const result = await runSerialized(view, probeShellStateColors);
      expect(result.pass).toBe(false);
      expect(result.measurements.stateColorViolationCount).toBeGreaterThanOrEqual(3);
      expect(result.measurements.uppercaseCount).toBeGreaterThanOrEqual(1);
      const blob = JSON.stringify(result);
      expect(blob).toContain('th-tree-running');
      expect(blob).toContain('shell-rect');
      expect(blob).not.toContain('shelf-rect');
      expect(blob).toContain('th-divider');
      expect(blob).not.toContain('th-tool-glyph');
      expect(blob).not.toContain('th-activity-chip');
    });
  });
  test('the chat pane box is chrome, so its own state border fails while a child does not', async () => {
    await withView(page(`
<div class="th-pane-wrap">
  <div class="th-chat-pane" style="border: 1px solid var(--th-accent);">
    <span class="th-tool-glyph" style="border: 2px solid var(--th-warning);">hidden</span>
  </div>
</div>`), async view => {
      const result = await runSerialized(view, probeShellStateColors);
      expect(result.pass).toBe(false);
      expect(result.measurements.stateColorViolationCount).toBeGreaterThanOrEqual(1);
      expect(result.measurements.stateColorViolationSamples.every(sample => sample.where.includes('th-chat-pane'))).toBe(true);
      expect(JSON.stringify(result.measurements)).not.toContain('th-tool-glyph');
    });
  });
});

describe('adversarial real-DOM proof: picker presence probe (S11 desktop)', () => {
  test('a picker without an orb fails even when the hero sits in a sibling empty state', async () => {
    await withView(presencePage(`
<div class="th-empty" style="height: 200px;">
  <div class="th-empty-orb" aria-hidden="true" style="width: 64px; height: 64px; border-radius: 50%;"></div>
  <h2 class="th-empty-title" style="${DISPLAY_HEADING}">Elsewhere</h2>
  <button type="button">New chat</button>
</div>
<div class="th-picker-pane" style="display: flex; flex-direction: column; height: 320px;">
  <div class="th-picker-pane-title">Pick a session</div>
  <button type="button">New chat session</button>
</div>`), async view => {
      const facts = await runSerialized(view, probeEmptyState, JSON.stringify({ root: '.th-picker-pane', requireDisplayTier: true }));
      const failures = emptyStateVerdict(facts);
      expect(facts.surface).toBe('picker');
      expect(facts.orb.found).toBe(false);
      expect(failures.some(f => f.includes('no orb'))).toBe(true);
      expect(failures.some(f => f.includes('no greeting'))).toBe(true);
    });
  });
  test('a 50% radius resolves against the box and a Display greeting passes', async () => {
    await withView(presencePage(`
<div class="th-picker-pane" style="display: flex; flex-direction: column; align-items: center; height: 420px;">
  <div class="th-empty-orb" aria-hidden="true" style="width: 64px; height: 64px; border-radius: 50%;"></div>
  <h2 class="th-empty-title" style="${DISPLAY_HEADING}">What are we building today?</h2>
  <button type="button">New chat session</button>
</div>`), async view => {
      const facts = await runSerialized(view, probeEmptyState, JSON.stringify({ root: '.th-picker-pane' }));
      expect(facts.orb.circular).toBe(true);
      expect(facts.orb.radiusPx).toBeGreaterThanOrEqual(30);
      expect(facts.orb.radiusPx).toBeLessThanOrEqual(34);
      expect(facts.greeting.displayTier).toBe(true);
      expect(emptyStateVerdict(facts)).toEqual([]);
    });
  });
  test('a picker greeting below the Display tier fails', async () => {
    await withView(presencePage(`
<div class="th-picker-pane" style="display: flex; flex-direction: column; align-items: center; height: 420px;">
  <div class="th-empty-orb" aria-hidden="true" style="width: 64px; height: 64px; border-radius: 50%;"></div>
  <h2 class="th-picker-greeting" style="font-size: 12px; font-weight: 400;">Pick a session</h2>
  <button type="button">New chat session</button>
</div>`), async view => {
      const facts = await runSerialized(view, probeEmptyState, JSON.stringify({ root: '.th-picker-pane', requireDisplayTier: true }));
      expect(facts.orb.circular).toBe(true);
      expect(facts.greeting.displayTier).toBe(false);
      expect(emptyStateVerdict(facts).join('\n')).toContain('Display tier');
    });
  });
});

describe('adversarial real-DOM proof: entrance recorder on the picker pane', () => {
  test('a finite entrance inside .th-picker-pane is recorded and one outside it is not', async () => {
    await withView(page(`
<style>
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.enter { animation: rise 480ms cubic-bezier(.16,1,.3,1) backwards; }
.outside-enter { animation: rise 480ms cubic-bezier(.16,1,.3,1) backwards; }
</style>
<div class="th-picker-pane" style="height: 200px;"><div id="host"></div></div>
<div id="outside"></div>`), async view => {
      await runScript(view, ENTRANCE_RECORDER_SOURCE);
      await awaitViewStarts(view, 'animationstart', ['.enter'],
        `document.getElementById('host').innerHTML = '<div class="enter">hello</div>';`);
      await awaitViewStarts(view, 'animationstart', ['.outside-enter'],
        `document.getElementById('outside').innerHTML = '<div class="outside-enter">nope</div>';`);
      const parsed = JSON.parse(await view.evaluate('JSON.stringify(window.__thT3Entrance)'));
      expect(parsed.events.some(event => event.name === 'rise' && event.label === 'div.enter')).toBe(true);
      expect(parsed.events.some(event => event.label === 'div.outside-enter')).toBe(false);
      expect(entranceVerdict(parsed)).toEqual([]);
    });
  });
});
