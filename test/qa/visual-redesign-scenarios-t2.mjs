/** T2 chat-surface QA scenario probes for the visual-redesign harness.
 *
 * Governing sources (binding):
 *   .omo/plans/visual-redesign.md         - QA scenarios S4..S22, task table
 *   .omo/plans/visual-redesign-tokens.md  - token contract v2
 *   DESIGN.md (v2)                        - state encoding, mono scope, motion
 *
 * This module is a per-task scenario plugin (see the contract in
 * visual-redesign.mjs): the CLI auto-loads `visual-redesign-scenarios-*.mjs`
 * and merges the exported `scenarios` object over the built-in registry.
 * It owns the T2 chat surface ids S4, S5, S6, S7, S8, S9 and S22. Where a
 * built-in driver already existed (S4/S6/S8) this override keeps every
 * built-in assertion and adds the T2-specific gates. S5 keeps the shared
 * painted-border and uppercase rules but measures only .th-chat-pane,
 * excluding T4-owned activity shelf, GoalBar, activity chips, and
 * activity-graph nodes, plus anything outside the pane (T3). S8 keeps
 * the running-glyph accent and reduced-motion gates for every other
 * glyph (tool, tree, overview) and does not judge those same T4 elements.
 *
 * Every probe below can FAIL and includes at least one assertion the
 * pre-redesign baseline fails (pinned by visual-redesign-scenarios-t2.test.mjs
 * over the pure decisions): composer radius 24 vs the old hard-coded 26,
 * borderless user bubble, accent (not amber) running glyphs, hidden raw cwd,
 * sans header metadata, timeline rail, overflow fade, palette glass + hint
 * row, accent-solid send fill, view-transition session-switch continuity.
 *
 * T2 selector contracts this file measures (S7/S9 - the markup the
 * redesign must ship; alternatives are listed so the contract is a shape,
 * not a single spelling):
 *   - Timeline rail (S7): a real ELEMENT matching
 *     .th-chat-record-rail | .th-tool-rail | .th-timeline-rail |
 *     .th-chat-rail | [data-th-tool-rail] | [class*="record-rail"] |
 *     [class*="tool-rail"] | [class*="timeline-rail"],
 *     inside the tool record or within 3 ancestors, VISIBLE, <= 6px wide,
 *     vertically covering the record's center, LEFT of the record's title
 *     text (.th-tool-name, falling back to the header box) - the v2 Golo
 *     grammar overlays the rail on the transparent header at the glyph
 *     center, so the anchor is the text, not the header's border box.
 *   - Overflow fade (S7): on/around the expanded overflowing output
 *     (.th-tool-output or its wrapper): computed mask-image (incl.
 *     -webkit-) non-none, or an ::after/::before with a gradient
 *     background-image.
 *   - Palette keyboard hint row (S9): a visible non-option element inside
 *     .th-chat-slash whose text names at least one confirm key (Enter/Esc)
 *     AND one navigation key (Arrow/↑/↓/Tab).
 */
import { prose } from './design-workbench-fixture.mjs';
import { summaryFrame } from './dag-summary-fixture.mjs';
import {
  colorEquals, parseColor, probeHeader, probeSeparation,
} from './visual-redesign-probes.mjs';

const STALE_KOREAN_MARKER = prose.slice(0, 12); // unique to the stored-a design seed
const NEWER_NAME = 'Newer';
const STORED_MARKER = '긴 세션 이름'; // longLabels renames stored-a in the seed

// ---------------------------------------------------------------------------
// 1. Pure decisions (unit-tested; facts come from the in-page probes)
// ---------------------------------------------------------------------------

/** S9: does this text read as a palette keyboard-hint row? Needs a confirm
 * key AND a navigation key; command descriptions ("…then press Enter your
 * text") must not match, so both families are required. ↵ counts as a
 * confirm symbol (the shipped hint chips render the glyph, not the word). */
export function keyboardHintRowText(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0 || value.length > 160) return false;
  const confirm = /(enter|return|esc(ape)?|↵)/i.test(value);
  const move = /(↑|↓|\barrow(s| (up|down|keys?))?|\btab\b)/i.test(value);
  return confirm && move;
}

/** Pull every concrete colour string out of a computed value list
 * (box-shadow and friends). Handles rgb()/rgba()/color()/hex. */
export function extractColorStrings(value) {
  const source = String(value ?? '');
  const out = [];
  const re = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8})/g;
  let match;
  while ((match = re.exec(source))) out.push(match[1]);
  return out;
}

/** S9: the focus-within ring resolves --th-ring on a scratch element (the
 * raw custom property is an unresolvable color-mix), so both sides arrive
 * as computed colour strings; the ring counts when one of the capsule's
 * shadow colours equals the token colour (alpha included). */
export function ringColorDecision({ boxShadow, ringShadow }) {
  const ring = extractColorStrings(ringShadow).map(parseColor).filter(Boolean);
  if (ring.length === 0) return false;
  return extractColorStrings(boxShadow).map(parseColor).filter(Boolean)
    .some(colour => ring.some(target => colorEquals(colour, target)));
}

/** S9: enabled Send slot facts -> failures. The pre-redesign white/black
 * send fails the accent-solid comparison (pinned by unit test). */
export function composerDecision(facts) {
  const failures = [];
  if (!facts.sendFound) {
    failures.push('send/stop slot button .th-chat-send-btn not found');
    return { pass: false, failures, measurements: { ...facts } };
  }
  if (facts.sendDisabled) failures.push('send button is disabled in the enabled-state check');
  if (facts.sendIsDanger) failures.push('send slot still shows the Stop (danger) control; the enabled Send state was expected');
  const background = parseColor(facts.sendBackground), accent = parseColor(facts.accentSolidRaw);
  if (!background || !accent || !colorEquals(background, accent)) {
    failures.push(`send button background ${facts.sendBackground} != --th-accent-solid ${facts.accentSolidRaw}`);
  }
  if (facts.ringMatches !== true) failures.push(`composer focus-within ring does not use the accent-alpha --th-ring token (${facts.boxShadow})`);
  return { pass: failures.length === 0, failures, measurements: { ...facts } };
}

/** S9: palette glass + hint row facts -> failures. The pre-redesign plain
 * raised palette (no backdrop-filter, no hints) fails both gates. */
export function paletteDecision(facts) {
  const failures = [];
  const hints = (facts.nonOptionTexts ?? []).filter(text => keyboardHintRowText(text));
  const measurements = {
    backdropFilter: facts.backdropFilter ?? null, optionCount: facts.optionCount ?? 0,
    hintRowCount: hints.length, hintTexts: hints,
  };
  if (!facts.paletteFound) failures.push('slash palette .th-chat-slash did not render');
  else {
    if (!facts.backdropFilter || facts.backdropFilter === 'none') failures.push(`slash palette backdrop-filter is ${facts.backdropFilter ?? 'none'} (glass required)`);
    if (hints.length < 1) failures.push('slash palette shows no keyboard hint row (navigate/select/dismiss hints)');
  }
  return { pass: failures.length === 0, failures, measurements };
}

/** S9: ArrowDown+Enter must insert the command into the composer without
 * sending (existing behavior; pinned in ChatComposer tests, re-measured
 * here against the real built SPA). */
export function commandInsertDecision(facts) {
  const failures = [];
  const value = String(facts.inserted ?? '');
  if (!/^\/[A-Za-z0-9_-]+\s?$/.test(value)) failures.push(`ArrowDown+Enter did not insert a command into the composer (value "${value}")`);
  if (facts.paletteClosed !== true) failures.push('slash palette still open after Enter selection');
  if (facts.focusedAfterInsert !== true) failures.push('composer textarea lost focus after command insertion');
  if (facts.sendFrameCount !== 0) failures.push(`command selection sent ${facts.sendFrameCount} chat.send frame(s); selecting a command must not send`);
  return { pass: failures.length === 0, failures, measurements: { ...facts } };
}

/** S7: per-record rail facts -> failures. The pre-redesign transcript has
 * no rail element at all, so every record fails (pinned by unit test). */
export function railFactsDecision(result) {
  const failures = [];
  const facts = (result?.facts ?? []).filter(fact => fact.recordVisible);
  const measurements = { toolCount: result?.toolCount ?? 0, visibleToolCount: facts.length, records: [] };
  if (measurements.visibleToolCount === 0) failures.push('no visible tool records found to measure the timeline rail');
  for (const fact of facts) {
    const thin = typeof fact.railWidth === 'number' && fact.railWidth <= 6;
    const left = typeof fact.railRight === 'number' && typeof fact.anchorLeft === 'number' && fact.railRight <= fact.anchorLeft + 1;
    const ok = fact.railFound && fact.railVisible && fact.railCoversRecord && thin && left;
    measurements.records.push({ id: fact.id, ok, railFound: fact.railFound, railVisible: fact.railVisible, railWidth: fact.railWidth, railRight: fact.railRight, anchorLeft: fact.anchorLeft });
    if (!ok) failures.push(`tool ${fact.id} has no qualifying timeline rail (found=${fact.railFound} visible=${fact.railVisible} covers=${fact.railCoversRecord} width=${fact.railWidth} railRight=${fact.railRight} anchorLeft=${fact.anchorLeft})`);
  }
  return { pass: failures.length === 0, failures, measurements };
}

/** S7: one expanded output fact -> has a bottom fade or not. */
export function fadeDecision(fact) {
  const mask = [fact.maskImage, fact.webkitMaskImage, fact.parentMaskImage]
    .some(value => value && value !== 'none');
  const pseudo = [fact.ownAfter, fact.ownBefore, fact.parentAfter, fact.parentBefore]
    .some(value => value && value !== 'none' && String(value).includes('gradient'));
  return { hasFade: mask || pseudo, mask, pseudo };
}

/** S7: overflowing expanded outputs must carry the fade (pre-redesign
 * output hard-clips with no mask; pinned by unit test). */
export function outputFadeDecision(outputs) {
  const failures = [];
  const measurements = { outputs: [] };
  if ((outputs ?? []).length === 0) failures.push('no expanded tool output found to measure the overflow fade');
  for (const fact of outputs ?? []) {
    const verdict = fadeDecision(fact);
    measurements.outputs.push({ id: fact.id, overflows: fact.overflows, scrollHeight: fact.scrollHeight, clientHeight: fact.clientHeight, ...verdict });
    if (fact.overflows && !verdict.hasFade) failures.push(`expanded output of ${fact.id} overflows (${fact.scrollHeight}>${fact.clientHeight}) without a bottom fade (mask and gradient pseudo both none)`);
  }
  return { pass: failures.length === 0, failures, measurements };
}

/** S7/S22: aria-expanded must agree with the rendered body. */
export function disclosureConsistency(state) {
  const expanded = state?.ariaExpanded === 'true';
  const visible = state?.bodyPresent === true && state?.bodyVisible === true;
  const ok = state?.found === true && expanded === visible;
  return {
    ok, expanded, visible,
    reason: ok ? 'consistent' : `aria-expanded=${state?.ariaExpanded} while bodyPresent=${state?.bodyPresent} bodyVisible=${state?.bodyVisible}`,
  };
}

/** S6: visible header text must be sans. Mono is reserved for code, paths,
 * tool I/O and identifiers (DESIGN.md "Type scale"); badges and chrome
 * labels are not paths. Path carriers are skipped here - the no-visible-cwd
 * gate in probeHeader owns them. The pre-redesign mono provider badge and
 * raw path fail this (pinned by unit test). */
export function headerTextDecision(texts, arg = {}) {
  const failures = [];
  const mono = [];
  for (const fact of texts ?? []) {
    if (!fact.visible) continue;
    if (arg.cwd && fact.text === arg.cwd) continue;
    if (/monospace/i.test(fact.fontFamily ?? '')) mono.push(fact);
  }
  if (mono.length > 0) failures.push(`${mono.length} visible header text run(s) use the mono stack (first: "${mono[0].text}" ${mono[0].fontFamily})`);
  return { pass: failures.length === 0, failures, measurements: { monoRuns: mono.slice(0, 8) } };
}

/** S4: every visible EXPANDED tool body sits on the scoped tool material
 * behind the tool hairline (v2 grammar: collapsed rows are transparent). */
export function toolMaterialDecision(result) {
  const failures = [];
  const border = parseColor(result?.toolBorderRaw), surface = parseColor(result?.toolSurfaceRaw);
  const measurements = { toolBorderRaw: result?.toolBorderRaw ?? null, toolSurfaceRaw: result?.toolSurfaceRaw ?? null, records: [] };
  const expanded = (result?.facts ?? []).filter(fact => fact.expanded);
  if (expanded.length === 0) failures.push('no expanded tool body found for the tool-material check');
  for (const fact of expanded) {
    const borderOk = !!border && colorEquals(parseColor(fact.borderTopColor), border);
    const surfaceOk = !!surface && colorEquals(parseColor(fact.backgroundColor), surface);
    measurements.records.push({ id: fact.id, borderOk, surfaceOk, borderTopColor: fact.borderTopColor, backgroundColor: fact.backgroundColor });
    if (!borderOk) failures.push(`expanded body of ${fact.id} border ${fact.borderTopColor} != --th-tool-border ${result?.toolBorderRaw}`);
    if (!surfaceOk) failures.push(`expanded body of ${fact.id} fill ${fact.backgroundColor} != --th-tool-surface ${result?.toolSurfaceRaw}`);
  }
  return { pass: failures.length === 0, failures, measurements };
}

/** S22: the pane ended on the last-clicked session with no stale content. */
export function switchOutcomeDecision(facts) {
  const failures = [];
  if (facts.expectedHeader && facts.headerName !== facts.expectedHeader) failures.push(`pane header shows "${facts.headerName}", expected "${facts.expectedHeader}"`);
  if (facts.requiresTranscriptMarker === true && facts.transcriptMarkerPresent !== true) failures.push('pane does not show the final session transcript marker');
  for (const marker of facts.staleMarkers ?? []) {
    if (marker.present) failures.push(`stale ${marker.kind} content from a previous session is still visible ("${marker.text}")`);
  }
  return { pass: failures.length === 0, failures, measurements: { ...facts } };
}

// ---------------------------------------------------------------------------
// 2. In-page probes (serialized into the page with the shared kit ahead;
//    they may reference kit helpers and DOM APIs only - never module names)
// ---------------------------------------------------------------------------

/** S7: per-record rail facts (see the selector contract in the header
 * comment). The left anchor is the record's TITLE TEXT (.th-tool-name),
 * because the v2 grammar paints the rail over the transparent header at
 * the glyph center rather than outside the header box. */
export function probeToolRail() {
  const railSelector = '.th-chat-record-rail, .th-tool-rail, .th-timeline-rail, .th-chat-rail, [data-th-tool-rail], [class*="record-rail"], [class*="tool-rail"], [class*="timeline-rail"]';
  const records = [...document.querySelectorAll('[data-tool-call-id]')];
  const facts = [];
  for (const record of records) {
    const head = record.querySelector('.th-tool-head');
    const anchor = record.querySelector('.th-tool-name') ?? head;
    const recordRect = record.getBoundingClientRect();
    const centerY = recordRect.top + recordRect.height / 2;
    let rail = null;
    let scope = record;
    for (let depth = 0; depth < 4 && scope && !rail; depth += 1) {
      for (const candidate of scope.querySelectorAll(railSelector)) {
        const rect = candidate.getBoundingClientRect();
        if (rect.top <= centerY && rect.bottom >= centerY) { rail = candidate; break; }
      }
      scope = scope.parentElement;
    }
    const railRect = rail ? rail.getBoundingClientRect() : null;
    const anchorRect = anchor ? anchor.getBoundingClientRect() : null;
    facts.push({
      id: record.getAttribute('data-tool-call-id'),
      label: describeElement(record),
      recordVisible: isVisibleElement(record),
      headFound: !!head,
      railFound: !!rail,
      railVisible: !!rail && isVisibleElement(rail),
      railWidth: railRect ? Math.round(railRect.width * 100) / 100 : null,
      railRight: railRect ? Math.round(railRect.right * 100) / 100 : null,
      anchorLeft: anchorRect ? Math.round(anchorRect.left * 100) / 100 : null,
      railCoversRecord: !!railRect && railRect.top <= centerY && railRect.bottom >= centerY,
    });
  }
  return { toolCount: records.length, facts };
}

/** S7: expanded output fade facts for every visible .th-tool-output. */
export function probeOutputFade() {
  const outputs = [];
  for (const output of document.querySelectorAll('.th-tool-output')) {
    const record = output.closest('[data-tool-call-id]');
    if (!record || !isVisibleElement(output)) continue;
    const style = getComputedStyle(output);
    const parent = output.parentElement;
    const parentStyle = parent ? getComputedStyle(parent) : null;
    const pseudoImage = (element, pseudo) => {
      if (!element) return 'none';
      const value = getComputedStyle(element, pseudo).backgroundImage;
      return value && value !== 'none' ? value : 'none';
    };
    outputs.push({
      id: record.getAttribute('data-tool-call-id'),
      clientHeight: output.clientHeight,
      scrollHeight: output.scrollHeight,
      overflows: output.scrollHeight > output.clientHeight + 2 && output.clientHeight > 0,
      maskImage: style.maskImage || 'none',
      webkitMaskImage: style.webkitMaskImage || 'none',
      parentMaskImage: parentStyle ? parentStyle.maskImage || 'none' : 'none',
      ownAfter: pseudoImage(output, '::after'),
      ownBefore: pseudoImage(output, '::before'),
      parentAfter: pseudoImage(parent, '::after'),
      parentBefore: pseudoImage(parent, '::before'),
    });
  }
  return { outputs };
}

/** S7/S22: disclosure state of one tool record. arg: { id } */
export function probeDisclosureState(arg) {
  const record = document.querySelector(`[data-tool-call-id="${arg.id}"]`);
  if (!record) return { found: false, id: arg.id };
  const head = record.querySelector('.th-tool-head');
  const body = record.querySelector('.th-tool-body');
  return {
    found: true, id: arg.id,
    ariaExpanded: head ? head.getAttribute('aria-expanded') : null,
    bodyPresent: !!body,
    bodyVisible: !!body && isVisibleElement(body),
  };
}

/** S9: composer slot facts. The ring token is RESOLVED on a scratch element
 * because the raw custom property is a color-mix() that parseColor cannot
 * evaluate in Node; both sides therefore arrive as computed strings. */
export function probeComposerFacts() {
  const button = document.querySelector('.th-chat-input .th-chat-send-btn');
  const inner = document.querySelector('.th-chat-input-inner');
  const textarea = document.querySelector('.th-chat-input textarea');
  const root = getComputedStyle(document.documentElement);
  const scratch = document.createElement('div');
  scratch.style.boxShadow = '0 0 0 3px var(--th-ring)';
  document.body.appendChild(scratch);
  const ringShadow = getComputedStyle(scratch).boxShadow;
  scratch.remove();
  return {
    sendFound: !!button,
    sendDisabled: button ? button.disabled : null,
    sendIsDanger: button ? button.classList.contains('th-btn--danger') : null,
    sendBackground: button ? getComputedStyle(button).backgroundColor : null,
    sendForeground: button ? getComputedStyle(button).color : null,
    accentSolidRaw: root.getPropertyValue('--th-accent-solid').trim(),
    boxShadow: inner ? getComputedStyle(inner).boxShadow : null,
    ringShadow,
    textareaFocused: document.activeElement === textarea,
  };
}

/** S9: slash palette glass + non-option text runs (hint row candidates).
 * The shipped hint row splits its copy across kbd chips and label spans
 * ("<kbd>↑</kbd><kbd>↓</kbd> to navigate <kbd>↵</kbd> … <kbd>esc</kbd> …"),
 * so LEAF runs alone never name both key families; candidates are the
 * combined texts of option-free subtrees (the hint row itself qualifies). */
export function probePaletteFacts() {
  const palette = document.querySelector('.th-chat-slash');
  if (!palette) return { paletteFound: false };
  const style = getComputedStyle(palette);
  const optionCount = palette.querySelectorAll('[role="option"]').length;
  const texts = [];
  for (const element of palette.querySelectorAll('*')) {
    if (element === palette) continue;
    if (element.closest('[role="option"]')) continue;
    if (element.querySelector('[role="option"]')) continue;
    if (!isVisibleElement(element)) continue;
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 160) continue;
    if (!texts.includes(text)) texts.push(text);
  }
  return {
    paletteFound: true,
    backdropFilter: style.backdropFilter || style.webkitBackdropFilter || null,
    optionCount,
    nonOptionTexts: texts.slice(0, 24),
  };
}

/** S6: every text run inside the pane header with its font stack. */
export function probeHeaderTexts() {
  const header = document.querySelector('.th-termhead');
  if (!header) return { found: false, texts: [] };
  const texts = [];
  const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    const parent = node.parentElement;
    texts.push({
      text: text.slice(0, 60),
      fontFamily: getComputedStyle(parent).fontFamily,
      visible: isVisibleElement(parent),
    });
  }
  return { found: true, texts };
}

/** S4: the v2 Golo timeline grammar keeps COLLAPSED records transparent
 * (timeline rows on Canvas); the scoped tool material belongs to the
 * EXPANDED body. Gates every visible expanded body on the scoped tokens. */
export function probeToolMaterial() {
  const root = getComputedStyle(document.documentElement);
  const facts = [];
  for (const record of document.querySelectorAll('[data-tool-call-id]')) {
    if (!isVisibleElement(record)) continue;
    const body = record.querySelector('.th-tool-body');
    facts.push({
      id: record.getAttribute('data-tool-call-id'),
      expanded: !!body && isVisibleElement(body),
      borderTopColor: body ? getComputedStyle(body).borderTopColor : null,
      backgroundColor: body ? getComputedStyle(body).backgroundColor : null,
    });
  }
  return {
    toolBorderRaw: root.getPropertyValue('--th-tool-border').trim(),
    toolSurfaceRaw: root.getPropertyValue('--th-tool-surface').trim(),
    facts,
  };
}


/** S4: name every bordered element in the pane so the evidence shows
 * exactly which hairlines exist in each theme. Same predicate as the
 * shared census (a visible, non-input/non-focus element with at least one
 * border side width > 0 and colour alpha > 0.02); records describeElement
 * plus the painted sides' widths and colours, capped at 30. */
export function probeBorderedSamples() {
  const pane = document.querySelector('.th-chat-pane');
  if (!pane) return { borderedSamples: [], borderedSampleCount: 0 };
  const samples = [];
  for (const element of pane.querySelectorAll('*')) {
    if (samples.length >= 30) break;
    if (/^(input|textarea|select)$/i.test(element.tagName) || element.matches(':focus-visible')) continue;
    if (!isVisibleElement(element)) continue;
    const style = getComputedStyle(element);
    const sides = {};
    let bordered = false;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const width = parseFloat(style['border' + side + 'Width']) || 0;
      if (width <= 0) continue;
      const color = style['border' + side + 'Color'];
      const parsed = parseColor(color);
      sides[side.toLowerCase()] = { width, color, counts: !!parsed && parsed.a > 0.02 };
      if (parsed && parsed.a > 0.02) bordered = true;
    }
    if (!bordered) continue;
    samples.push({ label: describeElement(element), sides });
  }
  return { borderedSamples: samples, borderedSampleCount: samples.length };
}

/** S8: localized status words currently visible on tool records (the
 * non-colour state signal). */
export function probeToolStatusWords() {
  const words = [];
  for (const element of document.querySelectorAll('.th-tool-status')) {
    if (!isVisibleElement(element)) continue;
    const text = (element.textContent || '').trim();
    if (text && !words.includes(text)) words.push(text);
  }
  return { words };
}

/** S5 chat scope. Same violation rules as the shared probeStateColors
 * (painted borders only: width > 0 and style not none/hidden; SVG stroke
 * only on a <rect> enclosure, never a glyph circle; :focus-visible,
 * focused .th-input, and .th-alert stay exempt) but the census is only
 * elements inside every .th-chat-pane. Anything outside the pane is T3.
 * Elements matching or inside the T4 selectors below are not judged:
 * .th-activity-shelf, GoalBar's root section.th-goal-shelf (GoalBar.tsx),
 * the summary button .th-goal-bar, .th-activity-chip, and activity-graph
 * classes .th-activity-g* (gnode, gstatus, gedge, glabel, graph). */
export function probeChatStateColors() {
  const excludedSelectors = [
    '.th-activity-shelf',
    '.th-goal-shelf',
    '.th-goal-bar',
    '.th-activity-chip',
    '.th-activity-g*',
  ];
  const isExcluded = element => {
    const structural = ['.th-activity-shelf', '.th-goal-shelf', '.th-goal-bar', '.th-activity-chip'];
    if (structural.some(selector => element.closest(selector))) return true;
    let node = element;
    while (node && node.nodeType === 1) {
      const raw = node.getAttribute ? (node.getAttribute('class') || '') : '';
      if (raw.trim().split(/\s+/).some(token => token.startsWith('th-activity-g'))) return true;
      node = node.parentElement;
    }
    return false;
  };
  // end T4 ownership exclusion
  const panes = [...document.querySelectorAll('.th-chat-pane')];
  if (panes.length === 0) {
    return {
      scenario: 'S5', pass: false,
      measurements: { excludedSelectors, excludedElementCount: 0, excludedSamples: [] },
      failures: ['.th-chat-pane not found'],
    };
  }
  const tokens = {
    success: tokenColor('--th-success'), warning: tokenColor('--th-warning'),
    error: tokenColor('--th-error'), accent: tokenColor('--th-accent'),
  };
  const violations = [];
  const uppercaseFacts = [];
  const excludedSamples = [];
  let excludedElementCount = 0;
  const seen = new Set();
  for (const pane of panes) {
    for (const element of [pane, ...pane.querySelectorAll('*')]) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (isExcluded(element)) {
        excludedElementCount += 1;
        if (excludedSamples.length < 12) excludedSamples.push(describeElement(element));
        continue;
      }
      if (element.matches(':focus-visible')) continue;
      if (element.closest('.th-alert')) continue;
      if (element.classList.contains('th-input') && element.matches(':focus')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const colours = [];
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const width = parseFloat(style['border' + side + 'Width']) || 0;
        const lineStyle = style['border' + side + 'Style'];
        if (width > 0 && lineStyle !== 'none' && lineStyle !== 'hidden') colours.push(style['border' + side + 'Color']);
      }
      if (element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName === 'rect'
        && style.stroke && style.stroke !== 'none' && (parseFloat(style.strokeWidth) || 0) > 0) colours.push(style.stroke);
      const where = describeElement(element);
      for (const raw of colours) {
        const colour = parseColor(raw);
        if (!colour) continue;
        for (const [name, token] of Object.entries(tokens)) {
          if (token && colorEquals(colour, token) && violations.length < 400) {
            violations.push({ where, token: name, colour: hexOf(colour), alpha: Number(colour.a.toFixed(3)) });
          }
        }
      }
      if (style.textTransform === 'uppercase') {
        const text = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join(' ').trim();
        if (text && isVisibleElement(element)) uppercaseFacts.push({ textTransform: style.textTransform, text, where });
      }
    }
  }
  const uppercaseCensus = uppercaseOf(uppercaseFacts);
  const measurements = {
    tokens: { success: hexOf(tokens.success), warning: hexOf(tokens.warning), error: hexOf(tokens.error), accent: hexOf(tokens.accent) },
    stateColorViolationCount: violations.length,
    stateColorViolationSamples: violations.slice(0, 25),
    uppercaseCount: uppercaseCensus.uppercaseCount,
    uppercaseSamples: uppercaseCensus.uppercase.slice(0, 12).map(index => uppercaseFacts[index]),
    excludedSelectors, excludedElementCount, excludedSamples,
  };
  const failures = [];
  if (violations.length > 0) failures.push(`${violations.length} elements carry a state/accent coloured border or stroke (first: ${violations[0].where} ${violations[0].token})`);
  if (uppercaseCensus.uppercaseCount > 0) failures.push(`${uppercaseCensus.uppercaseCount} visible elements use text-transform: uppercase (first: ${uppercaseFacts[uppercaseCensus.uppercase[0]].where})`);
  return { scenario: 'S5', pass: failures.length === 0, measurements, failures };
}

/** S8 colour census for the T2 chat surface. Same accent rule as
 * probeRunningGlyphs, but elements matching or inside the T4 selectors
 * (activity shelf, GoalBar root .th-goal-shelf, .th-goal-bar, activity
 * chip, .th-activity-g*) are counted and skipped. Tool, tree, and
 * overview running glyphs stay in the census. */
export function probeChatRunningGlyphs() {
  const excludedSelectors = [
    '.th-activity-shelf',
    '.th-goal-shelf',
    '.th-goal-bar',
    '.th-activity-chip',
    '.th-activity-g*',
  ];
  const isExcluded = element => {
    const structural = ['.th-activity-shelf', '.th-goal-shelf', '.th-goal-bar', '.th-activity-chip'];
    if (structural.some(selector => element.closest(selector))) return true;
    let node = element;
    while (node && node.nodeType === 1) {
      const raw = node.getAttribute ? (node.getAttribute('class') || '') : '';
      if (raw.trim().split(/\s+/).some(token => token.startsWith('th-activity-g'))) return true;
      node = node.parentElement;
    }
    return false;
  };
  // end T4 ownership exclusion
  const accent = tokenColor('--th-accent');
  const glyphs = [];
  const excludedElements = new Set();
  for (const selector of runningGlyphSelectors()) {
    for (const element of document.querySelectorAll(selector)) {
      if (isExcluded(element)) {
        excludedElements.add(element);
        continue;
      }
      if (!isVisibleElement(element)) continue;
      const style = getComputedStyle(element);
      const colourFacts = {
        stroke: style.stroke && style.stroke !== 'none' ? hexOf(parseColor(style.stroke)) : null,
        border: hexOf(parseColor(style.borderTopColor)), background: hexOf(parseColor(style.backgroundColor)),
        fill: style.fill && style.fill !== 'none' ? hexOf(parseColor(style.fill)) : null, color: hexOf(parseColor(style.color)),
      };
      const matchesAccent = [
        parseColor(style.stroke), parseColor(style.borderTopColor), parseColor(style.backgroundColor), parseColor(style.fill),
      ].some(colour => colour && colorEquals(colour, accent));
      glyphs.push({ selector, where: describeElement(element), colourFacts, matchesAccent });
    }
  }
  const measurements = {
    accent: hexOf(accent), glyphsFound: glyphs.length, glyphs,
    excludedSelectors, excludedElementCount: excludedElements.size,
    excludedSamples: [...excludedElements].slice(0, 12).map(element => describeElement(element)),
  };
  const failures = [];
  if (glyphs.length === 0) failures.push('no running glyphs found (fixture must expose a running tool, tree, or overview glyph)');
  for (const glyph of glyphs) if (!glyph.matchesAccent) failures.push(`running glyph ${glyph.selector} at ${glyph.where} is not accent-coloured: ${JSON.stringify(glyph.colourFacts)}`);
  return { scenario: 'S8', pass: failures.length === 0, measurements, failures };
}

/** S8 reduced-motion census for the T2 chat surface. Same animation and
 * textual-label rules as probeRunningReducedMotion. T4-owned glyphs are
 * not judged and cannot satisfy the "glyph present" or label gates. */
export function probeChatRunningReducedMotion() {
  const excludedSelectors = [
    '.th-activity-shelf',
    '.th-goal-shelf',
    '.th-goal-bar',
    '.th-activity-chip',
    '.th-activity-g*',
  ];
  const isExcluded = element => {
    const structural = ['.th-activity-shelf', '.th-goal-shelf', '.th-goal-bar', '.th-activity-chip'];
    if (structural.some(selector => element.closest(selector))) return true;
    let node = element;
    while (node && node.nodeType === 1) {
      const raw = node.getAttribute ? (node.getAttribute('class') || '') : '';
      if (raw.trim().split(/\s+/).some(token => token.startsWith('th-activity-g'))) return true;
      node = node.parentElement;
    }
    return false;
  };
  // end T4 ownership exclusion
  const failures = [];
  const glyphStates = [];
  const excludedElements = new Set();
  let labelSamples = [];
  for (const selector of runningGlyphSelectors()) {
    for (const element of document.querySelectorAll(selector)) {
      if (isExcluded(element)) {
        excludedElements.add(element);
        continue;
      }
      if (!isVisibleElement(element)) continue;
      const animations = element.getAnimations({ subtree: true });
      glyphStates.push({ selector, where: describeElement(element), animationCount: animations.length });
      if (animations.length > 0) failures.push(`running glyph ${selector} still animates under reduced motion (${animations.length})`);
    }
  }
  const labelPattern = /(running|responding|executing|streaming|live|진행|실행|응답)/i;
  for (const element of document.querySelectorAll('[aria-label], [title], button, [role="status"], [class*="tool-status"], [class*="termhead"], [class*="status"]')) {
    if (isExcluded(element)) continue;
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
  const measurements = {
    glyphStates, runningLabels: labelSamples,
    excludedSelectors, excludedElementCount: excludedElements.size,
    excludedSamples: [...excludedElements].slice(0, 12).map(element => describeElement(element)),
  };
  return { scenario: 'S8', pass: failures.length === 0, measurements, failures };
}

// ---------------------------------------------------------------------------
// 3. Browser-side helpers (run in Node against the Playwright page)
// ---------------------------------------------------------------------------

const errLine = error => (error instanceof Error ? error.message.split('\n')[0] : String(error));

const withErrors = (env, measurements) => ({ ...measurements, pageErrors: env.errors.slice(0, 5) });

/** True when the viewport collapses the sidebar into the mobile drawer. */
async function isNarrow(page) {
  return page.locator('.th-termhead .th-mobile-menu').first().isVisible().catch(() => false);
}

/** Open the mobile drawer through its real entry point (hamburger). Drawer
 * state is read from the inert/aria-hidden attributes React sets
 * immediately, never from CSS visibility (same discipline as the harness). */
async function openMobileDrawer(page) {
  if (!(await isNarrow(page))) return;
  const drawerHidden = () => page.evaluate(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true';
  }).catch(() => true);
  if (!(await drawerHidden())) return;
  const menu = page.locator('.th-mobile-menu').first();
  if (!(await menu.isVisible().catch(() => false))) throw new Error('mobile drawer entry (.th-mobile-menu) is not visible at this viewport');
  await menu.click();
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !!sidebar && !sidebar.hasAttribute('inert') && sidebar.getAttribute('aria-hidden') !== 'true';
  }, undefined, { timeout: 4000 });
}

async function closeMobileDrawer(page) {
  const backdrop = page.locator('.th-backdrop');
  if (!(await backdrop.isVisible().catch(() => false))) return;
  const width = page.viewportSize()?.width ?? 390;
  await backdrop.click({ timeout: 2000, position: { x: Math.max(1, width - 24), y: 60 } }).catch(() => {});
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true';
  }, undefined, { timeout: 4000 }).catch(() => {});
}

/** Clear the composer the way a real user does (D3 discipline). */
async function clearComposer(page) {
  await page.focus('.th-chat-input textarea');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
}

/** Wait out in-flight transitions on one element (composer capsule, send
 * slot) so a fact read is not the START or MID-FLIGHT colour of a change:
 * .th-btn animates background over --th-dur-fast, so a Stop->Send swap
 * read in the same frame returns an interpolated fill (observed
 * rgb(145,92,173) between --th-error and --th-accent-solid). Same pattern
 * as the harness's G27 wizard facts. */
async function settleElement(page, selector) {
  await page.evaluate(target => {
    const element = document.querySelector(target);
    if (!element) return;
    return Promise.race([
      Promise.allSettled(element.getAnimations({ subtree: true }).map(animation => animation.finished)),
      new Promise(done => setTimeout(done, 1200)),
    ]);
  }, selector).catch(() => {});
}

/** Serve the DAG catalog/document endpoints CompleteDagSection fetches.
 * The pane-workspace-ui fixture does not serve them (the documented T4
 * reachability gap): without routes the tab renders only a catalog error
 * and `.th-activity-gnode--running` can never appear, so S5/S8 would
 * structurally fail. The document's counts mirror the exact node-state
 * histogram because parseCompleteDag recomputes and rejects mismatches. */
export function dagCatalogPayloads() {
  const contentToken = 'qa-t2-dag-content-1';
  const run = {
    run_id: 'summary-run', run_key: 'summary', name: 'Summary fixture', status: 'running',
    created_at: '2026-09-26T10:00:00.000Z', updated_at: '2026-09-26T10:04:00.000Z',
    counts: { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 2, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
    nodes: [
      { id: 'a', prompt: 'Description a', state: 'running', depends_on: [], attempt: 1 },
      { id: 'b', prompt: 'Description b', state: 'running', depends_on: ['a'], attempt: 1 },
    ],
    edges: [{ from: 'a', to: 'b' }],
    waves: [{ index: 0, node_ids: ['a'] }, { index: 1, node_ids: ['b'] }],
  };
  return {
    document: { complete: true, content_token: contentToken, run },
    catalog: {
      runs: [{ run_id: run.run_id, run_key: run.run_key, name: run.name, status: run.status, total: run.counts.total, content_token: contentToken }],
      next_cursor: null,
    },
  };
}

async function serveDagCatalog(env) {
  const payloads = dagCatalogPayloads();
  // The catalog is fetched as `.../dag-runs?limit=...` and the document as
  // `.../dag-runs/<id>` (both may carry query strings), so the patterns
  // match the path with a query-or-end boundary - a `$` anchor alone lets
  // the query slip past and the tab falls back to the catalog error alert.
  await env.context.route(/\/api\/workspaces\/[^/]+\/chats\/[^/]+\/dag-runs(?:\?|$)/, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payloads.catalog),
  }));
  await env.context.route(/\/dag-runs\/[^/?]+(?:\?|$)/, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payloads.document),
  }));
}

/** Push the running-DAG activity frame on both sockets (chat + all_live)
 * and reach the running graph through its real tab entry. Returns false
 * when the graph surface could not be reached - a required interaction,
 * never a swallowed note. */
async function deliverRunningDag(env) {
  const notes = [];
  await serveDagCatalog(env);
  const frame = summaryFrame('complete2');
  await env.fixture.deliver('stored-a', frame);
  const peers = env.fixture.overview(frame);
  notes.push(`overview frame reached ${peers.length} all_live subscriber(s)`);
  try {
    await env.page.waitForSelector('[data-activity-tab="dag"]', { timeout: 8000 });
    await env.page.click('[data-activity-tab="dag"]');
    await env.page.waitForSelector('.th-activity-gnode--running', { timeout: 8000 });
    return { reached: true, notes };
  } catch (error) {
    return { reached: false, notes, error: errLine(error) };
  }
}

/** Deliver an approval frame; the surface must render (required
 * interaction for the S5 census). */
async function deliverApproval(env) {
  await env.fixture.deliver('stored-a', {
    type: 'approval', id: 'qa-t2-approval-1', method: 'shell.exec',
    title: 'QA approval', message: 'Approve the QA harness action?',
  });
  try {
    await env.page.waitForSelector('.th-approval-form, .th-question-window, [class*="approval"]', { timeout: 8000 });
    return { reached: true };
  } catch (error) {
    return { reached: false, error: errLine(error) };
  }
}

/** S7/S22 shared: N rapid Enter toggles on one tool header, then wait for
 * the disclosure to settle consistent (aria-expanded == body visibility). */
async function rapidDisclosureToggles(page, id, count) {
  const record = { id, count };
  try {
    const head = page.locator(`[data-tool-call-id="${id}"] .th-tool-head`);
    await head.scrollIntoViewIfNeeded();
    await head.focus();
    for (let i = 0; i < count; i += 1) await page.keyboard.press('Enter');
  } catch (error) {
    record.settled = false;
    record.error = errLine(error);
    return record;
  }
  try {
    await page.waitForFunction(needle => {
      const element = document.querySelector(`[data-tool-call-id="${needle}"]`);
      const header = element ? element.querySelector('.th-tool-head') : null;
      const body = element ? element.querySelector('.th-tool-body') : null;
      if (!header) return false;
      const expanded = header.getAttribute('aria-expanded') === 'true';
      return expanded === (!!body && body.getClientRects().length > 0);
    }, id, { timeout: 4000 });
    record.settled = true;
  } catch (error) {
    record.settled = false;
    record.error = errLine(error);
  }
  return record;
}

/** S22: pane identity + stale markers, read from the real DOM. */
async function paneFacts(page) {
  return page.evaluate(() => {
    const text = document.querySelector('.th-chat-scrollport')?.textContent ?? '';
    return {
      headerName: (document.querySelector('.th-termhead-name')?.textContent ?? '').trim(),
      transcriptMarkerPresent: text.includes('Synthetic turn'),
      toolRecords: document.querySelectorAll('[data-tool-call-id]').length,
      staleKorean: text.includes('대화의 흐름과 도구'),
      staleTools: document.querySelectorAll('[data-tool-call-id="design-failed"], [data-tool-call-id="design-running"]').length,
    };
  });
}

/** S22: observe whether a session switch runs as a view transition
 * (session-switch continuity, DESIGN.md "Motion"). The rAF sampler watches
 * document.getAnimations() for ::view-transition pseudo animations; the
 * flag poll is event-shaped (bounded) rather than a fixed sleep. */
async function observeViewTransition(page, action) {
  const capability = await page.evaluate(() => ({
    apiPresent: typeof document.startViewTransition === 'function',
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  await page.evaluate(() => {
    window.__qaVtSeen = false;
    window.__qaVtStop = false;
    const sample = () => {
      if (window.__qaVtStop) return;
      try {
        for (const animation of document.getAnimations()) {
          const name = String(animation.animationName ?? '');
          if (name.includes('view-transition')) window.__qaVtSeen = true;
        }
      } catch { /* sampler must never throw into the page */ }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await action();
  await page.waitForFunction(() => window.__qaVtSeen === true, undefined, { timeout: 1500 }).catch(() => {});
  const seen = await page.evaluate(() => {
    const value = window.__qaVtSeen === true;
    window.__qaVtStop = true;
    return value;
  });
  return { ...capability, seen };
}

/** S22: modal open -> Escape -> open churn through the real entry point
 * (workspace row delete action). Returns failures + record. */
async function modalChurn(page, ctx) {
  const failures = [];
  const record = {};
  const open = async () => {
    if (!(await page.locator('.th-tree-workspace .th-tree-node').first().isVisible().catch(() => false))) {
      await openMobileDrawer(page);
    }
    await page.locator('.th-tree-workspace .th-tree-node').first().hover().catch(() => {});
    await page.locator('button[title="Delete workspace"]').first().click({ timeout: 4000 });
    await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 3000 });
  };
  try {
    await open();
    record.afterOpen = await page.locator('.th-modal-overlay').count();
    await close();
    await open();
    record.afterRapidCycle = await page.locator('.th-modal-overlay').count();
    if (record.afterRapidCycle !== 1) failures.push(`modal churn: ${record.afterRapidCycle} overlays after open-close-open, expected exactly 1`);
    record.interactiveButtons = await page.locator('.th-modal-overlay button:visible').count();
    if (record.interactiveButtons < 1) failures.push('modal churn: the reopened modal exposes no interactive control');
    await settleElement(page, '.th-modal');
    const shots = [await ctx.save(page, '-modal-churn')];
    try { await close(); } catch (error) { failures.push(`modal churn: close failed (${errLine(error)})`); await page.keyboard.press('Escape').catch(() => {}); }
    await closeMobileDrawer(page);
    return { record, failures, shots };
  } catch (error) {
    failures.push(`modal churn: harness error ${errLine(error)}`);
    await page.keyboard.press('Escape').catch(() => {});
    await closeMobileDrawer(page);
    return { record, failures, shots: [] };
  }
}

// ---------------------------------------------------------------------------
// 4. Scenario drivers. Each returns { pass, measurements, failures,
//    screenshots, teardown }; scenario/theme/viewport are filled by the
//    runner. Every driver closes its fixture even when a step throws.
// ---------------------------------------------------------------------------

/** S4 - tonal separation (T2 chat surface): the built-in border census
 * inside .th-chat-pane (baseline-relative), composer radius 24px,
 * borderless user bubble with radius >= 16, PLUS the scoped tool material
 * every tool record must sit on. */
async function separationT2(ctx) {
  const env = await ctx.setupDesign();
  try {
    const base = await ctx.probe(env.page, probeSeparation, {
      baselineBordered: typeof ctx.baseline?.borderedCount === 'number' ? ctx.baseline.borderedCount : undefined,
    });
    const material = await ctx.probe(env.page, probeToolMaterial);
    const materialVerdict = toolMaterialDecision(material);
    // Name every bordered element so the evidence shows exactly which
    // hairlines each theme carries inside the pane.
    const bordered = await ctx.probe(env.page, probeBorderedSamples);
    const failures = [...base.failures, ...materialVerdict.failures.map(f => `tool material: ${f}`)];
    const shot = await ctx.save(env.page, '');
    return {
      pass: failures.length === 0,
      measurements: withErrors(env, {
        ...base.measurements, ...bordered, toolMaterial: materialVerdict.measurements,
      }),
      failures, screenshots: [shot], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

/** S5 - no state encoded by coloured border/stroke, no uppercase, measured
 * only inside .th-chat-pane. Elements matching or inside .th-activity-shelf,
 * GoalBar's root .th-goal-shelf, .th-goal-bar, .th-activity-chip, or
 * .th-activity-g* are T4 and excluded; anything outside the pane is T3.
 * The live fixture still opens the running DAG, an expanded tool record,
 * the model picker, the slash palette and the approval so every
 * chat-surface selection state is mounted for that census. */
async function stateColorsT2(ctx) {
  const env = await ctx.setupLive();
  try {
    const page = env.page;
    const notes = [];
    const failures = [];
    const dag = await deliverRunningDag(env);
    notes.push(...dag.notes);
    if (!dag.reached) failures.push(`running DAG graph not reached through its real entry: ${dag.error}`);
    // Surfaces that need an unobstructed pane come BEFORE the approval: the
    // approval auto-opens a modal question window that covers the shelf, the
    // picker and the transcript (observed on the mid-flight build), so
    // delivering it last keeps every other surface mounted for one census.
    try {
      await page.locator('[data-tool-call-id="design-bash"] .th-tool-head').click({ timeout: 8000 });
      await page.waitForSelector('[data-tool-call-id="design-bash"] .th-tool-body', { timeout: 8000 });
    } catch (error) {
      failures.push(`tool record did not expand through its real entry: ${errLine(error)}`);
    }
    try {
      await page.click('.th-model-picker-btn', { timeout: 8000 });
      await page.waitForSelector('.th-model-picker-popover', { timeout: 8000 });
    } catch (error) {
      failures.push(`model picker not reached through its real entry: ${errLine(error)}`);
    }
    let paletteOpened = true;
    try {
      await page.focus('.th-chat-input textarea');
      await page.keyboard.press('/');
      await page.waitForSelector('.th-chat-slash', { timeout: 8000 });
      await settleElement(page, '.th-chat-slash');
    } catch (error) {
      paletteOpened = false;
      failures.push(`slash palette not reached through its real entry: ${errLine(error)}`);
    }
    const approval = await deliverApproval(env);
    if (!approval.reached) failures.push(`approval surface did not render: ${approval.error}`);
    const result = await ctx.probe(page, probeChatStateColors);
    result.measurements.surfaceNotes = notes;
    result.measurements.motion = await ctx.motionSweep(page);
    const shot = await ctx.save(page, '');
    if (paletteOpened) {
      await page.keyboard.press('Escape').catch(() => {});
      await clearComposer(page).catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    return {
      pass: result.pass && failures.length === 0,
      failures: [...result.failures, ...failures],
      measurements: withErrors(env, result.measurements),
      screenshots: [shot], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

/** S6 - pane header discipline (T2): built-in cwd/clipping/overflow gates
 * PLUS the mono-scope gate (visible header chrome text must be sans; mono
 * is for code/paths/identifiers only, and the raw cwd is gated invisible). */
async function headerT2(ctx) {
  const env = await ctx.setupDesign();
  try {
    const base = await ctx.probe(env.page, probeHeader, { cwd: ctx.constants.SEED_CWD });
    const texts = await ctx.probe(env.page, probeHeaderTexts);
    const textVerdict = headerTextDecision(texts.texts ?? [], { cwd: ctx.constants.SEED_CWD });
    const failures = [...base.failures, ...textVerdict.failures.map(f => `header text: ${f}`)];
    const shot = await ctx.save(env.page, '');
    return {
      pass: failures.length === 0,
      measurements: withErrors(env, { ...base.measurements, headerMonoScan: textVerdict.measurements, headerTextRuns: texts.texts ?? [] }),
      failures, screenshots: [shot], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

/** S7 - transcript timeline + disclosure: rail per tool record, Enter/Space
 * keyboard disclosure with content visibility, bottom fade on expanded
 * overflowing output, 5 rapid toggles ending consistent. */
async function timelineT2(ctx) {
  const env = await ctx.setupDesign();
  try {
    const page = env.page;
    const failures = [];
    const measurements = { narrowViewport: await isNarrow(page) };
    await page.locator('[data-tool-call-id="design-failed"]').scrollIntoViewIfNeeded().catch(() => {});

    const rail = await ctx.probe(page, probeToolRail);
    const railVerdict = railFactsDecision(rail);
    measurements.timelineRail = railVerdict.measurements;
    failures.push(...railVerdict.failures.map(f => `rail: ${f}`));

    // Enter expands, Space collapses - keyboard disclosure with visibility.
    const disclosure = {};
    const head = page.locator('[data-tool-call-id="design-read"] .th-tool-head');
    try {
      await head.scrollIntoViewIfNeeded();
      await head.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(id => {
        const element = document.querySelector(`[data-tool-call-id="${id}"]`);
        const header = element ? element.querySelector('.th-tool-head') : null;
        return header ? header.getAttribute('aria-expanded') === 'true' : false;
      }, 'design-read', { timeout: 3000 });
      disclosure.afterEnter = await ctx.probe(page, probeDisclosureState, { id: 'design-read' });
      if (disclosure.afterEnter.ariaExpanded !== 'true' || !disclosureConsistency(disclosure.afterEnter).ok) {
        failures.push(`Enter did not expand the tool disclosure consistently (${disclosureConsistency(disclosure.afterEnter).reason})`);
      }
      await page.keyboard.press('Space');
      await page.waitForFunction(id => {
        const element = document.querySelector(`[data-tool-call-id="${id}"]`);
        const header = element ? element.querySelector('.th-tool-head') : null;
        return header ? header.getAttribute('aria-expanded') !== 'true' : false;
      }, 'design-read', { timeout: 3000 });
      disclosure.afterSpace = await ctx.probe(page, probeDisclosureState, { id: 'design-read' });
      if (disclosure.afterSpace.ariaExpanded === 'true' || !disclosureConsistency(disclosure.afterSpace).ok) {
        failures.push(`Space did not collapse the tool disclosure consistently (${disclosureConsistency(disclosure.afterSpace).reason})`);
      }
    } catch (error) {
      failures.push(`keyboard disclosure through Enter/Space failed: ${errLine(error)}`);
    }
    measurements.disclosure = disclosure;

    // The failed record auto-expands; make sure some record is expanded so
    // the fade measurement sees a body, then measure the overflow fade.
    const expanded = await page.evaluate(() => document.querySelectorAll('[data-tool-call-id] .th-tool-body').length);
    if (expanded === 0) {
      await page.locator('[data-tool-call-id="design-failed"] .th-tool-head').click().catch(() => {});
    }
    const fade = await ctx.probe(page, probeOutputFade);
    const fadeVerdict = outputFadeDecision(fade.outputs);
    measurements.outputFade = fadeVerdict.measurements;
    failures.push(...fadeVerdict.failures.map(f => `fade: ${f}`));

    // 5 rapid toggles end with aria-expanded consistent with visible content.
    const rapid = await rapidDisclosureToggles(page, 'design-bash', 5);
    measurements.rapidToggles = rapid;
    if (!rapid.settled) failures.push(`rapid toggles: disclosure did not settle consistent (${rapid.error})`);
    else {
      const after = await ctx.probe(page, probeDisclosureState, { id: 'design-bash' });
      measurements.rapidToggles.after = after;
      if (!disclosureConsistency(after).ok) failures.push(`rapid toggles: ${disclosureConsistency(after).reason}`);
    }

    measurements.motion = await ctx.motionSweep(page);
    const shot = await ctx.save(page, '');
    return {
      pass: failures.length === 0, measurements: withErrors(env, measurements),
      failures, screenshots: [shot], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

/** S8 - running indicator (T2 chat surface): accent colour and the
 * reduced-motion collapse for T2-owned running glyphs (tool, tree,
 * overview). Activity-shelf, GoalBar, activity-chip, and activity-graph
 * glyphs are T4: the probes record them as excluded and do not judge
 * them. The live fixture still reaches the running DAG through its real
 * tab, and the localized tool status word is still required. */
async function runningT2(ctx) {
  const env = await ctx.setupLive();
  try {
    const page = env.page;
    const notes = [];
    const failures = [];
    const dag = await deliverRunningDag(env);
    notes.push(...dag.notes);
    if (!dag.reached) failures.push(`running DAG graph not reached through its real entry: ${dag.error}`);
    const colours = await ctx.probe(page, probeChatRunningGlyphs);
    const words = await ctx.probe(page, probeToolStatusWords);
    const shotColour = await ctx.save(page, '');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await ctx.probe(page, probeChatRunningReducedMotion);
    const shotReduced = await ctx.save(page, '-reduced');
    failures.push(...colours.failures.map(f => `colours: ${f}`), ...reduced.failures.map(f => `reduced-motion: ${f}`));
    if (!(words.words ?? []).some(word => /(running|진행|실행|응답)/i.test(word))) {
      failures.push(`no textual running status word beside the running tool glyph (words: ${JSON.stringify(words.words)})`);
    }
    return {
      pass: failures.length === 0,
      measurements: withErrors(env, {
        colours: colours.measurements, reducedMotion: reduced.measurements,
        toolStatusWords: words.words, surfaceNotes: notes,
      }),
      failures, screenshots: [shotColour, shotReduced], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

/** S9 - composer + palette + send states: enabled send fill ==
 * --th-accent-solid, accent-alpha focus-within ring, '/' palette with
 * glass + keyboard hint row, ArrowDown+Enter inserts without sending.
 * Send/stop behavior itself is pinned by the existing vitest suites
 * (ChatPane.commands.submit, ChatComposer.queue, ChatPane.release). */
async function composerT2(ctx) {
  const env = await ctx.setupLive();
  try {
    const page = env.page;
    const failures = [];
    const measurements = { narrowViewport: await isNarrow(page) };

    // The live fixture arrives running (streaming); stop the run through
    // the real control so the shared slot shows the ENABLED SEND state.
    // The pointer then moves OFF the slot before the fill is read: the
    // stop click leaves the mouse hovering the slot, and :hover resolves
    // --th-send-hover - a different state than the enabled-at-rest fill
    // the scenario pins (observed rgb(91,73,194) = --th-accent-solid-hover).
    try {
      await page.click('.th-chat-send-btn.th-btn--danger', { timeout: 4000 });
      await page.waitForFunction(() => !document.querySelector('.th-chat-send-btn.th-btn--danger'), undefined, { timeout: 4000 });
      const size = page.viewportSize() ?? { width: 1280, height: 900 };
      await page.mouse.move(size.width / 2, Math.round(size.height * 0.3));
      await settleElement(page, '.th-chat-send-btn');
    } catch (error) {
      failures.push(`could not reach the enabled Send state (stop click): ${errLine(error)}`);
    }

    const idle = await ctx.probe(page, probeComposerFacts);
    await page.focus('.th-chat-input textarea');
    await settleElement(page, '.th-chat-input-inner');
    const focused = await ctx.probe(page, probeComposerFacts);
    const composerVerdict = composerDecision({
      sendFound: idle.sendFound,
      sendDisabled: idle.sendDisabled,
      sendIsDanger: idle.sendIsDanger,
      sendBackground: idle.sendBackground,
      accentSolidRaw: idle.accentSolidRaw,
      boxShadow: focused.boxShadow,
      ringMatches: ringColorDecision({ boxShadow: focused.boxShadow, ringShadow: focused.ringShadow }),
    });
    measurements.composer = composerVerdict.measurements;
    measurements.textareaFocusedAfterFocus = focused.textareaFocused;
    failures.push(...composerVerdict.failures.map(f => `composer: ${f}`));

    // '/' opens the palette: glass + keyboard hint row.
    let paletteFacts = { paletteFound: false };
    try {
      await page.keyboard.press('/');
      await page.waitForSelector('.th-chat-slash', { timeout: 4000 });
      // D7: capture the palette settled, never a mid-enter frame (the T2
      // glass layer will carry an enter transition).
      await settleElement(page, '.th-chat-slash');
      paletteFacts = await ctx.probe(page, probePaletteFacts);
    } catch (error) {
      failures.push(`slash palette did not open on '/': ${errLine(error)}`);
    }
    const paletteVerdict = paletteDecision(paletteFacts);
    measurements.palette = paletteVerdict.measurements;
    failures.push(...paletteVerdict.failures.map(f => `palette: ${f}`));
    const shot = paletteFacts.paletteFound ? await ctx.save(page, '-palette') : await ctx.save(page, '');

    // ArrowDown + Enter selects the second curated command (/compact):
    // inserts into the composer, closes the palette, keeps focus, sends
    // nothing (controlled fixture records every outbound frame).
    if (paletteFacts.paletteFound) {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const insertFacts = await page.evaluate(() => ({
        inserted: document.querySelector('.th-chat-input textarea')?.value ?? '',
        paletteClosed: !document.querySelector('.th-chat-slash'),
        focusedAfterInsert: document.activeElement === document.querySelector('.th-chat-input textarea'),
      }));
      insertFacts.sendFrameCount = (env.fixture.traffic ?? [])
        .filter(row => row.frame && row.frame.type === 'chat.send').length;
      const insertVerdict = commandInsertDecision(insertFacts);
      measurements.commandInsert = insertVerdict.measurements;
      failures.push(...insertVerdict.failures.map(f => `command insert: ${f}`));
      await clearComposer(page).catch(() => {});
    } else {
      measurements.commandInsert = { skipped: 'palette did not open' };
    }

    return {
      pass: failures.length === 0, measurements: withErrors(env, measurements),
      failures, screenshots: [shot], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

/** S22 - rapid interruption consistency: 3 session switches (within 100ms
 * on desktop; through successive real drawer entries on narrow, where the
 * product intentionally closes the drawer per selection) end on the last
 * session with no stale content; one clean switch must run as a view
 * transition (session-switch continuity); disclosure rapid toggles stay
 * consistent; modal open-close-open leaves exactly one interactive modal. */
async function interruptionT2(ctx) {
  const env = await ctx.setupDesign();
  try {
    const page = env.page;
    const failures = [];
    const narrow = await isNarrow(page);
    const measurements = { narrowViewport: narrow };
    const newerRow = () => page.locator('.th-tree-activation').filter({ hasText: NEWER_NAME }).first();
    const storedRow = () => page.locator('.th-tree-activation').filter({ hasText: STORED_MARKER }).first();

    // 3 rapid switches: newer -> stored-a -> newer (end on the last click).
    if (!narrow) {
      const a = await newerRow().boundingBox();
      const b = await storedRow().boundingBox();
      if (!a || !b) throw new Error('session rows not measurable for the rapid switch sequence');
      const click = box => page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 14));
      const startedAt = Date.now();
      await click(a);
      await click(b);
      await click(a);
      measurements.rapidWindowMs = Date.now() - startedAt;
    } else {
      // The drawer closes per selection by design; keep the real entry
      // per click. The latest-wins/no-stale contract is still exercised.
      for (const row of [newerRow(), storedRow(), newerRow()]) {
        await openMobileDrawer(page);
        await row.click({ timeout: 4000 });
        await closeMobileDrawer(page);
      }
      measurements.rapidWindowMs = null;
      measurements.rapidWindowNote = 'narrow viewport: drawer closes per selection; switches driven through successive real entries';
    }

    let rapidFacts = null;
    try {
      await page.waitForFunction(() => {
        const name = (document.querySelector('.th-termhead-name')?.textContent ?? '').trim();
        const text = document.querySelector('.th-chat-scrollport')?.textContent ?? '';
        return name === 'Newer' && text.includes('Synthetic turn')
          && !document.querySelector('[data-tool-call-id]') && !text.includes('대화의 흐름과 도구');
      }, undefined, { timeout: 8000 });
      rapidFacts = await paneFacts(page);
    } catch (error) {
      rapidFacts = await paneFacts(page).catch(() => null);
      failures.push(`rapid switches: pane did not end on the last session without stale content (${errLine(error)})`);
    }
    if (rapidFacts) {
      const verdict = switchOutcomeDecision({
        headerName: rapidFacts.headerName,
        expectedHeader: NEWER_NAME,
        requiresTranscriptMarker: true,
        transcriptMarkerPresent: rapidFacts.transcriptMarkerPresent,
        staleMarkers: [
          { kind: 'transcript', text: STALE_KOREAN_MARKER, present: rapidFacts.staleKorean },
          { kind: 'tool', text: 'design-failed / design-running records', present: rapidFacts.staleTools > 0 },
        ],
      });
      measurements.afterRapid = verdict.measurements;
      failures.push(...verdict.failures.map(f => `rapid switches: ${f}`));
    }

    // Continuity: one clean switch back runs as a view transition and lands
    // on the target session with no stale content from the previous one.
    const vt = await observeViewTransition(page, async () => {
      if (narrow) {
        await openMobileDrawer(page);
        await storedRow().click({ timeout: 4000 });
        await closeMobileDrawer(page);
      } else {
        await storedRow().click({ timeout: 4000 });
      }
    });
    measurements.viewTransition = vt;
    if (vt.apiPresent && !vt.reducedMotion && !vt.seen) {
      failures.push('session switch ran without a view transition (continuity motion missing)');
    }
    let continuityFacts = null;
    try {
      await page.waitForFunction(() => {
        const name = document.querySelector('.th-termhead-name')?.textContent ?? '';
        const text = document.querySelector('.th-chat-scrollport')?.textContent ?? '';
        return name.includes('긴 세션 이름') && !!document.querySelector('[data-tool-call-id="design-failed"]')
          && !text.includes('Synthetic turn');
      }, undefined, { timeout: 8000 });
      continuityFacts = await paneFacts(page);
    } catch (error) {
      continuityFacts = await paneFacts(page).catch(() => null);
      failures.push(`continuity switch: pane did not show the target session (${errLine(error)})`);
    }
    if (continuityFacts) {
      const verdict = switchOutcomeDecision({
        headerName: continuityFacts.headerName,
        transcriptMarkerPresent: continuityFacts.transcriptMarkerPresent,
        staleMarkers: [
          { kind: 'transcript', text: 'Synthetic turn (previous session)', present: continuityFacts.transcriptMarkerPresent },
        ],
      });
      // The stored session legitimately carries its own tool records; only
      // the transcript marker of the previous session is stale here.
      measurements.afterContinuity = { ...verdict.measurements, toolRecords: continuityFacts.toolRecords };
      failures.push(...verdict.failures.map(f => `continuity switch: ${f}`));
    }

    // Disclosure rapid toggles stay consistent (3 rapid Enter toggles).
    const disclosure = await rapidDisclosureToggles(page, 'design-bash', 3);
    measurements.disclosureChurn = disclosure;
    if (!disclosure.settled) failures.push(`disclosure churn: did not settle consistent (${disclosure.error})`);
    else {
      const after = await ctx.probe(page, probeDisclosureState, { id: 'design-bash' });
      measurements.disclosureChurn.after = after;
      if (!disclosureConsistency(after).ok) failures.push(`disclosure churn: ${disclosureConsistency(after).reason}`);
    }

    // Modal open-close-open churn through the real workspace action.
    const modal = await modalChurn(page, ctx);
    measurements.modalChurn = modal.record;
    failures.push(...modal.failures);

    const shot = await ctx.save(page, '');
    return {
      pass: failures.length === 0, measurements: withErrors(env, measurements),
      failures, screenshots: [shot, ...modal.shots], teardown: await env.close(),
    };
  } catch (error) {
    await env.close().catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 5. Plugin export
// ---------------------------------------------------------------------------

export const scenarios = {
  S4: separationT2,
  S5: stateColorsT2,
  S6: headerT2,
  S7: timelineT2,
  S8: runningT2,
  S9: composerT2,
  S22: interruptionT2,
};
