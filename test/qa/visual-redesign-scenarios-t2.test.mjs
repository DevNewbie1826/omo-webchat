/** Unit tests for the T2 chat-surface scenario plugin.
 *
 * Covers the pure decision helpers the in-page probes feed (each pinned
 * against the PRE-REDESIGN BASELINE facts it must reject), the serialized
 * in-page probes against a controlled jsdom DOM (so a leaked module
 * identifier surfaces as a ReferenceError here, not as a silent in-page
 * crash - the D6 defect class), and the plugin registration contract over
 * the shared harness loader. Run: bun test test/qa/visual-redesign-scenarios-t2.test.mjs */
import { describe, expect, test } from 'bun:test';
import { buildScenarioRegistry, loadScenarioPlugins, selectScenarioIds } from './visual-redesign.mjs';
import { pageKit, parseColor, probeRunningGlyphs } from './visual-redesign-probes.mjs';
import {
  commandInsertDecision, composerDecision, dagCatalogPayloads, disclosureConsistency, extractColorStrings,
  fadeDecision, headerTextDecision, keyboardHintRowText, outputFadeDecision, paletteDecision,
  probeChatRunningGlyphs, probeChatRunningReducedMotion, probeChatStateColors, probeComposerFacts, probeDisclosureState, probeHeaderTexts, probeOutputFade, probePaletteFacts,
  probeToolMaterial, probeToolRail, probeBorderedSamples, probeTranscriptRows, railFactsDecision, ringColorDecision, scenarios,
  probeThinkingDisclosure, thinkingDisclosureDecision, settleEnterAnimations, switchOutcomeDecision, toolMaterialDecision, transcriptRowsDecision,
} from './visual-redesign-scenarios-t2.mjs';

import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';

// ---------------------------------------------------------------------------
// Plugin registration (the harness contract this file exists for)
// ---------------------------------------------------------------------------

describe('T2 plugin registration', () => {
  test('registers T2 stub owners and chat-scoped variants without replacing built-ins', async () => {
    const plugins = await loadScenarioPlugins(import.meta.dir);
    const mine = plugins.find(plugin => plugin.file === 'visual-redesign-scenarios-t2.mjs');
    expect(mine?.skipped).toBeUndefined();
    const registry = buildScenarioRegistry(plugins);
    for (const id of ['S7', 'S9', 'S22']) {
      const entry = registry.find(candidate => candidate.id === id);
      expect(entry?.origin, `${id} origin`).toBe('plugin:visual-redesign-scenarios-t2.mjs');
      expect(entry?.stub, `${id} stub`).toBe(false);
      expect(entry?.reason, `${id} reason`).toBe(null);
      expect(entry?.run, `${id} run`).toBe(scenarios[id]);
    }
    for (const id of ['S4', 'S5', 'S6', 'S8']) {
      const entry = registry.find(candidate => candidate.id === id);
      expect(entry?.origin, `${id} stays the built-in app-wide driver`).toBe('builtin');
      expect(entry?.run, `${id} run`).not.toBe(scenarios[`${id}:chat`]);
    }
    for (const [id, title] of [
      ['S4:chat', 'Tonal separation vs stacked borders (chat scope)'],
      ['S5:chat', 'No state encoded by coloured border/stroke (chat scope)'],
      ['S6:chat', 'Pane header label discipline (chat scope)'],
      ['S8:chat', 'Running indicator accent + reduced motion (chat scope)'],
    ]) {
      const entry = registry.find(candidate => candidate.id === id);
      expect(entry, id).toMatchObject({
        id, title, origin: 'plugin:visual-redesign-scenarios-t2.mjs', stub: false, reason: null,
      });
      expect(entry.run, `${id} run`).toBe(scenarios[id]);
    }
    expect(Object.keys(scenarios).sort()).toEqual(['S22', 'S4:chat', 'S5:chat', 'S6:chat', 'S7', 'S8:chat', 'S9']);
    expect(selectScenarioIds(registry, ['S4', 'S6'])).toEqual(['S4', 'S4:chat', 'S6', 'S6:chat']);
  });

  test('selecting S5 yields the builtin driver and both scoped variants', async () => {
    const plugins = await loadScenarioPlugins(import.meta.dir);
    const registry = buildScenarioRegistry(plugins);
    expect(selectScenarioIds(registry, ['S5'])).toEqual(['S5', 'S5:chat', 'S5:shell']);
    expect(registry.find(entry => entry.id === 'S5').origin).toBe('builtin');
    expect(registry.find(entry => entry.id === 'S5:chat').run).toBe(scenarios['S5:chat']);
    expect(registry.find(entry => entry.id === 'S5:shell').origin).toBe('plugin:visual-redesign-scenarios-t3.mjs');
  });

  test('probes that fail or throw are possible: each scenario is a real function', () => {
    for (const [id, run] of Object.entries(scenarios)) {
      expect(typeof run, `${id}`).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// Serialized-probe execution in jsdom (D6 regression for the new probes)
// ---------------------------------------------------------------------------

/** Evaluate a kit-augmented probe inside a controlled jsdom document.
 * `patch(window, document)` runs after construction, before the probe - used
 * to force geometry jsdom cannot compute (clientHeight/scrollHeight) so the
 * ADVERSARIAL fixtures drive the real serialized probe, per the T1 review
 * lesson: every probe must be proven able to FAIL through its own code. */
function serializedProbeInDom(probeFn, arg, { html = '<body></body>', tokens = {}, patch = null } = {}) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://qa.local/' });
  const { window } = dom;
  window.Element.prototype.getClientRects = function () { return [{ width: 10, height: 10 }]; };
  for (const [name, value] of Object.entries(tokens)) {
    window.document.documentElement.style.setProperty(name, value);
  }
  if (patch) patch(window, window.document);
  const source = `(function(){\n${pageKit()}\nreturn (${probeFn.toString()})(${JSON.stringify(arg)});\n})()`;
  return window.eval(source);
}

describe('serialized probeToolRail', () => {
  const geometry = ({ offset = 0 } = {}) => (window, document) => {
    const boxes = {
      record: { left: 24, right: 224, top: 100, bottom: 148, width: 200, height: 48 },
      rail: { left: 65.5 + offset, right: 66.5 + offset, top: 100, bottom: 148, width: 1, height: 48 },
      glyph: { left: 60, right: 72, top: 114, bottom: 126, width: 12, height: 12 },
      title: { left: 80, right: 130, top: 110, bottom: 130, width: 50, height: 20 },
    };
    for (const [selector, box] of [
      ['.th-tool', boxes.record],
      ['.th-chat-record-rail', boxes.rail],
      ['.th-tool-glyph', boxes.glyph],
      ['.th-tool-name', boxes.title],
    ]) document.querySelector(selector).getBoundingClientRect = () => box;
  };
  test('records a glyph-centered rail spanning its record and passes', () => {
    const result = serializedProbeInDom(probeToolRail, {}, {
      html: `<body><div class="th-chat-pane"><div class="th-tool th-chat-record" data-tool-call-id="t1">
        <span class="th-chat-record-rail"></span>
        <button class="th-tool-head" aria-expanded="false"><span class="th-tool-glyph"></span><span class="th-tool-name">bash</span></button>
      </div></div></body>`,
      patch: geometry(),
    });
    const verdict = railFactsDecision(result);
    expect(verdict.pass).toBe(true);
    expect(verdict.measurements.visibleToolCount).toBe(1);
  });
  test('a rail shifted onto the chevron fails despite staying left of the title', () => {
    const result = serializedProbeInDom(probeToolRail, {}, {
      html: `<body><div class="th-tool th-chat-record" data-tool-call-id="t1">
        <span class="th-chat-record-rail"></span>
        <button class="th-tool-head"><span class="th-tool-chevron"></span><span class="th-tool-glyph"></span><span class="th-tool-name">bash</span></button>
      </div></body>`,
      patch: geometry({ offset: -24 }),
    });
    expect(railFactsDecision(result).pass).toBe(false);
  });
  test('the pre-redesign transcript (no rail element at all) fails every record', () => {
    const result = serializedProbeInDom(probeToolRail, {}, {
      html: `<body><div class="th-chat-pane">
        <div class="th-tool th-chat-record" data-tool-call-id="t1">
          <button class="th-tool-head"><span class="th-tool-name">bash</span></button>
        </div>
      </div></body>`,
    });
    const verdict = railFactsDecision(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('t1 has no qualifying timeline rail');
  });
  test('a consecutive thinking record joins its previous tool without jumping', () => {
    const result = serializedProbeInDom(probeToolRail, {}, {
      html: `<body><section class="th-chat-pane">
        <div class="th-tool th-chat-record" data-tool-call-id="t1"><span class="th-chat-record-rail"></span>
          <button class="th-tool-head"><span class="th-tool-glyph"></span></button></div>
        <div class="th-chat-thinking th-chat-record th-chat-record--continue"><span class="th-chat-record-rail"></span>
          <button class="th-chat-thinking-head"><span class="th-chat-thinking-dot"></span></button></div>
      </section></body>`,
      patch: (window, document) => {
        const rects = [
          [document.querySelectorAll('.th-chat-record')[0], { top: 100, bottom: 148 }],
          [document.querySelectorAll('.th-chat-record-rail')[0], { top: 100, bottom: 148, left: 65.5, right: 66.5, width: 1 }],
          [document.querySelector('.th-tool-glyph'), { top: 114, bottom: 126, left: 60, right: 72 }],
          [document.querySelectorAll('.th-chat-record')[1], { top: 164, bottom: 200 }],
          [document.querySelectorAll('.th-chat-record-rail')[1], { top: 148, bottom: 200, left: 65.5, right: 66.5, width: 1 }],
          [document.querySelector('.th-chat-thinking-dot'), { top: 172, bottom: 184, left: 60, right: 72 }],
        ];
        for (const [element, rect] of rects) element.getBoundingClientRect = () => rect;
      },
    });
    const verdict = railFactsDecision(result);
    expect(verdict.pass).toBe(true);
    expect(verdict.measurements.visibleThinkingCount).toBe(1);
    expect(verdict.measurements.records[1].joined).toBe(true);
  });
  test('a lateral jump or a vertical gap breaks a continued mixed rail', () => {
    const good = {
      id: 'thinking:1', kind: 'thinking', recordVisible: true,
      railFound: true, railVisible: true, glyphFound: true, railSpansRecord: true,
      railWidth: 1, railCenter: 66, glyphCenter: 66, continues: true,
      previousVisible: true, previousRailCenter: 66, railTop: 148, previousRailBottom: 148,
    };
    expect(railFactsDecision({ toolCount: 1, facts: [good, { ...good, id: 't1', kind: 'tool', continues: false }] }).pass).toBe(true);
    expect(railFactsDecision({ toolCount: 1, facts: [{ ...good, previousRailCenter: 42 }] }).pass).toBe(false);
    expect(railFactsDecision({ toolCount: 1, facts: [{ ...good, railTop: 156 }] }).pass).toBe(false);
  });
});

describe('serialized transcript row geometry', () => {
  const html = `<body><div class="th-chat-body">
    <div class="th-chat-row" data-index="0"><div class="th-chat-record" data-tool-call-id="a"></div></div>
    <div class="th-chat-row" data-index="1"><div class="th-chat-record" data-tool-call-id="b"></div></div>
  </div></body>`;
  test('rejects overlap between two visible virtual rows', () => {
    const result = serializedProbeInDom(probeTranscriptRows, {}, {
      html,
      patch: (window, document) => {
        document.querySelector('.th-chat-body').getBoundingClientRect = () => ({ top: 0, bottom: 300 });
        const rows = document.querySelectorAll('.th-chat-row');
        rows[0].getBoundingClientRect = () => ({ top: 40, bottom: 120 });
        rows[1].getBoundingClientRect = () => ({ top: 110, bottom: 170 });
        const records = document.querySelectorAll('.th-chat-record');
        records[0].getBoundingClientRect = () => ({ top: 50, bottom: 100 });
        records[1].getBoundingClientRect = () => ({ top: 120, bottom: 160 });
      },
    });
    expect(transcriptRowsDecision(result).failures[0]).toContain('overlap by 10px');
  });
  test('rejects overlapping records even when both live in one tall virtual row', () => {
    const result = serializedProbeInDom(probeTranscriptRows, {}, {
      html: `<body><div class="th-chat-body"><div class="th-chat-row" data-index="0">
        <div class="th-chat-record" data-tool-call-id="a"></div>
        <div class="th-chat-record" data-tool-call-id="b"></div>
      </div></div></body>`,
      patch: (window, document) => {
        document.querySelector('.th-chat-body').getBoundingClientRect = () => ({ top: 0, bottom: 300 });
        document.querySelector('.th-chat-row').getBoundingClientRect = () => ({ top: 40, bottom: 250 });
        const records = document.querySelectorAll('.th-chat-record');
        records[0].getBoundingClientRect = () => ({ top: 50, bottom: 130 });
        records[1].getBoundingClientRect = () => ({ top: 125, bottom: 170 });
      },
    });
    expect(transcriptRowsDecision(result).failures[0]).toContain('records a/b overlap by 5px');
  });
});

describe('serialized probeOutputFade (adversarial: overflowing output, no fade)', () => {
  const overflowingHtml = `<body><div class="th-tool" data-tool-call-id="t1">
    <div class="th-tool-body"><pre class="th-tool-output">line</pre></div>
  </div></body>`;
  const forceOverflow = window => {
    const pre = window.document.querySelector('.th-tool-output');
    Object.defineProperty(pre, 'clientHeight', { value: 360, configurable: true });
    Object.defineProperty(pre, 'scrollHeight', { value: 2400, configurable: true });
  };
  test('the real probe + no fade FAILS the overflowing record', () => {
    const result = serializedProbeInDom(probeOutputFade, {}, { html: overflowingHtml, patch: forceOverflow });
    expect(result.outputs[0].overflows).toBe(true);
    const verdict = outputFadeDecision(result.outputs);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('without a bottom fade');
  });
  test('no expanded output at all also fails (never a silent pass)', () => {
    const result = serializedProbeInDom(probeOutputFade, {}, { html: '<body><div class="th-chat-pane"></div></body>' });
    expect(outputFadeDecision(result.outputs).pass).toBe(false);
  });
});

describe('serialized probeDisclosureState', () => {
  test('reads aria-expanded and body facts', () => {
    const html = `<body><div class="th-tool" data-tool-call-id="t1">
      <button class="th-tool-head" aria-expanded="true"></button>
      <div class="th-tool-body">output</div>
    </div></body>`;
    const state = serializedProbeInDom(probeDisclosureState, { id: 't1' }, { html });
    expect(state).toMatchObject({ found: true, ariaExpanded: 'true', bodyPresent: true, bodyVisible: true });
    expect(disclosureConsistency(state).ok).toBe(true);
  });
  test('adversarial: expanded header with no rendered body FAILS consistency', () => {
    const html = `<body><div class="th-tool" data-tool-call-id="t1">
      <button class="th-tool-head" aria-expanded="true"></button>
    </div></body>`;
    const state = serializedProbeInDom(probeDisclosureState, { id: 't1' }, { html });
    expect(state.bodyPresent).toBe(false);
    expect(disclosureConsistency(state).ok).toBe(false);
  });
});

describe('serialized thinking disclosure rendering (S7)', () => {
  const marker = 'QA historical reasoning remains readable.';
  const html = `<body><section class="th-chat-history"><div class="th-chat-thinking th-chat-record th-chat-thinking--open">
    <button class="th-chat-thinking-head" aria-expanded="true" aria-controls="reasoning"><span class="th-chat-thinking-chevron th-chat-thinking-chevron--open"></span></button>
    <div id="reasoning" class="th-chat-thinking-body"><div class="th-chat-thinking-body-inner"><pre>${marker}</pre></div></div>
  </div></section></body>`;
  const measured = ({ clipped = false, track = null } = {}) => (window, document) => {
    const body = document.querySelector('.th-chat-thinking-body');
    const record = document.querySelector('.th-chat-thinking');
    const original = window.getComputedStyle.bind(window);
    window.getComputedStyle = element => {
      const style = original(element);
      if (element === body) return new Proxy(style, { get(target, key) {
        if (key === 'gridTemplateRows') return track !== null ? `${track}px` : !clipped && record.classList.contains('th-chat-thinking--open') ? '36px' : '0px';
        return Reflect.get(target, key, target);
      } });
      return style;
    };
    body.getBoundingClientRect = () => ({ height: track !== null ? track : !clipped && record.classList.contains('th-chat-thinking--open') ? 36 : 0 });
    document.querySelector('.th-chat-thinking-body-inner').getBoundingClientRect = () => ({ height: track !== null ? track : 36 });
    document.querySelector('.th-chat-thinking-body pre').getBoundingClientRect = () => ({ height: 36 });
  };
  const inspect = (markup, options) => {
    const fact = serializedProbeInDom(probeThinkingDisclosure, { kind: 'historical' }, {
      html: markup, patch: measured(options),
    });
    return { fact, verdict: thinkingDisclosureDecision(fact, { open: true, marker, accessibilitySnapshot: `- text: ${marker}` }) };
  };
  test('expanded historical reasoning has body geometry and an accessible text target', () => {
    const { fact, verdict } = inspect(html);
    expect(fact).toMatchObject({ ariaExpanded: 'true', controlsTarget: true, openClass: true, chevronOpen: true, bodyHeight: 36, trackHeight: 36 });
    expect(verdict.pass).toBe(true);
    expect(verdict.measurements.accessibleTextPresent).toBe(true);
  });
  test('removing the open class fails even with aria-expanded and text still present', () => {
    const { fact, verdict } = inspect(html.replace('th-chat-record th-chat-thinking--open', 'th-chat-record'));
    expect(fact.bodyHeight).toBe(0);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('expanded thinking body is clipped');
  });
  test('forcing an expanded body to grid-template-rows 0fr fails', () => {
    const { fact, verdict } = inspect(html, { clipped: true });
    expect(fact.trackHeight).toBe(0);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('expanded thinking body is clipped');
  });
  test('a nonzero but clipped expanded track (1px) fails through the real probe', () => {
    const { fact, verdict } = inspect(html, { track: 1 });
    expect(fact.trackHeight).toBe(1);
    expect(fact.textClipped).toBe(true);
    expect(fact.textReadable).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('expanded thinking body is clipped');
  });
  test('a fully exposed text box inside the clip passes', () => {
    const { fact, verdict } = inspect(html, { track: 36 });
    expect(fact.textClipped).toBe(false);
    expect(verdict.pass).toBe(true);
  });
  test('closed content must be inert or hidden and excluded from the accessibility snapshot', () => {
    const closed = html.replace('th-chat-record th-chat-thinking--open', 'th-chat-record')
      .replace('aria-expanded="true"', 'aria-expanded="false"')
      .replace('th-chat-thinking-chevron--open', 'th-chat-thinking-chevron')
      .replace('id="reasoning" class=', 'id="reasoning" inert aria-hidden="true" class=');
    const fact = serializedProbeInDom(probeThinkingDisclosure, { kind: 'historical' }, { html: closed, patch: measured() });
    expect(thinkingDisclosureDecision(fact, { open: false, marker, accessibilitySnapshot: '- button: Thinking' }).pass).toBe(true);
    expect(thinkingDisclosureDecision(fact, { open: false, marker, accessibilitySnapshot: `- text: ${marker}` }).pass).toBe(false);
    const exposed = serializedProbeInDom(probeThinkingDisclosure, { kind: 'historical' }, {
      html: closed.replace(' inert aria-hidden="true"', ''), patch: measured(),
    });
    expect(thinkingDisclosureDecision(exposed, { open: false, marker, accessibilitySnapshot: '- button: Thinking' }).pass).toBe(false);
  });
});

describe('serialized probePaletteFacts and probeComposerFacts', () => {
  test('palette facts collect non-option texts and glass state', () => {
    const result = serializedProbeInDom(probePaletteFacts, {}, {
      html: `<body><div class="th-chat-input-inner">
        <div class="th-chat-slash" role="listbox">
          <button role="option"><strong>/compact</strong> — Compact the session</button>
          <div class="th-chat-slash-hints">↑↓ navigate · Enter select · Esc close</div>
        </div>
      </div></body>`,
    });
    expect(result.paletteFound).toBe(true);
    expect(result.optionCount).toBe(1);
    expect(result.nonOptionTexts).toContain('↑↓ navigate · Enter select · Esc close');
    expect(paletteDecision(result).pass).toBe(false); // jsdom: no backdrop-filter -> glass gate fails
    expect(paletteDecision(result).failures[0]).toContain('backdrop-filter');
  });
  test('palette facts collect the shipped hint row (kbd chips + label spans)', () => {
    const result = serializedProbeInDom(probePaletteFacts, {}, {
      html: `<body><div class="th-chat-input-inner">
        <div class="th-chat-slash" role="listbox">
          <button role="option"><strong>/compact</strong> — Compact the session</button>
          <div class="th-chat-slash-hints">
            <span class="th-chat-slash-hint"><kbd aria-hidden="true">↑</kbd><kbd aria-hidden="true">↓</kbd><span>to navigate</span></span>
            <span class="th-chat-slash-hint"><kbd aria-hidden="true">↵</kbd><span>to select</span></span>
            <span class="th-chat-slash-hint th-chat-slash-hint--end"><kbd aria-hidden="true">esc</kbd><span>to dismiss</span></span>
          </div>
        </div>
      </div></body>`,
    });
    const verdict = paletteDecision(result);
    expect(verdict.measurements.hintRowCount).toBeGreaterThanOrEqual(1);
    // jsdom cannot compute backdrop-filter; only the hint gate is provable
    // here - the glass gate is measured by the real-browser run.
    expect(verdict.failures.join(' ')).not.toContain('keyboard hint row');
    expect(verdict.failures.join(' ')).toContain('backdrop-filter');
  });
  test('adversarial: palette without a hint row FAILS the hint gate through the real probe', () => {
    const result = serializedProbeInDom(probePaletteFacts, {}, {
      html: `<body><div class="th-chat-slash" role="listbox">
        <button role="option"><strong>/compact</strong> — Compact the session</button>
      </div></body>`,
    });
    const verdict = paletteDecision(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.measurements.hintRowCount).toBe(0);
    expect(verdict.failures.join(' ')).toContain('keyboard hint row');
  });
  test('composer facts resolve tokens and the scratch ring without leaking module names', () => {
    const result = serializedProbeInDom(probeComposerFacts, {}, {
      html: `<body><form class="th-chat-input"><div class="th-chat-input-inner">
        <button class="th-btn th-chat-send-btn" type="submit"><span class="th-chat-send-label">Send</span></button>
      </div></form></body>`,
      tokens: { '--th-accent-solid': '#6d5bd0', '--th-ring': 'rgba(139, 124, 246, 0.55)' },
    });
    expect(result.sendFound).toBe(true);
    expect(result.sendDisabled).toBe(false);
    expect(result.accentSolidRaw).toBe('#6d5bd0');
    expect(result.ringShadow).toBeTruthy();
  });
  test('adversarial: the pre-redesign white send FAILS through the real probe facts', () => {
    const result = serializedProbeInDom(probeComposerFacts, {}, {
      html: `<body><form class="th-chat-input"><div class="th-chat-input-inner">
        <button class="th-btn th-chat-send-btn" type="submit" style="background-color: rgb(255, 255, 255)"><span class="th-chat-send-label">Send</span></button>
      </div></form></body>`,
      tokens: { '--th-accent-solid': '#6d5bd0' },
    });
    const verdict = composerDecision({ ...result, ringMatches: true });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('!= --th-accent-solid');
  });
  test('adversarial: the Stop (danger) slot FAILS the enabled-Send check through the real probe', () => {
    const result = serializedProbeInDom(probeComposerFacts, {}, {
      html: `<body><form class="th-chat-input"><div class="th-chat-input-inner">
        <button class="th-btn th-chat-send-btn th-btn--danger" type="button" style="background-color: rgb(109, 91, 208)"><span class="th-chat-send-label">Stop</span></button>
      </div></form></body>`,
      tokens: { '--th-accent-solid': '#6d5bd0' },
    });
    expect(composerDecision({ ...result, ringMatches: true }).failures.join(' ')).toContain('Stop (danger) control');
  });
});

describe('serialized probeHeaderTexts and probeToolMaterial', () => {
  test('header text runs carry font stacks and visibility', () => {
    const result = serializedProbeInDom(probeHeaderTexts, {}, {
      html: `<body><header class="th-termhead">
        <span class="th-termhead-name" style="font-family: 'Pretendard Variable', sans-serif">Stored A</span>
        <span class="th-provider-badge" style="font-family: ui-monospace, monospace">omo</span>
        <span class="th-termhead-path" style="font-family: ui-monospace, monospace">/fixture</span>
      </header></body>`,
    });
    const verdict = headerTextDecision(result.texts, { cwd: '/fixture' });
    expect(verdict.pass).toBe(false);
    // The cwd carrier is owned by the no-visible-cwd gate; the badge still fails.
    expect(verdict.measurements.monoRuns).toHaveLength(1);
    expect(verdict.measurements.monoRuns[0].text).toBe('omo');
  });
  test('tool material facts parse against the scoped tokens (expanded body)', () => {
    const result = serializedProbeInDom(probeToolMaterial, {}, {
      html: `<body><div class="th-tool" data-tool-call-id="t1">
        <div class="th-tool-body" style="border-top: 1px solid rgba(255, 255, 255, 0.06); background-color: rgb(29, 30, 34)">body</div>
      </div></body>`,
      tokens: { '--th-tool-border': 'rgba(255, 255, 255, 0.06)', '--th-tool-surface': '#1d1e22' },
    });
    const verdict = toolMaterialDecision(result);
    expect(verdict.pass).toBe(true);
    expect(verdict.measurements.records[0]).toMatchObject({ id: 't1', borderOk: true, surfaceOk: true });
  });
  test('adversarial: a pre-redesign bordered card body FAILS through the real probe', () => {
    const result = serializedProbeInDom(probeToolMaterial, {}, {
      html: `<body><div class="th-tool" data-tool-call-id="t1">
        <div class="th-tool-body" style="border-top: 1px solid rgb(64, 64, 64); background-color: rgb(38, 38, 38)">body</div>
      </div></body>`,
      tokens: { '--th-tool-border': 'rgba(255, 255, 255, 0.06)', '--th-tool-surface': '#1d1e22' },
    });
    const verdict = toolMaterialDecision(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.length).toBe(2);
  });
  test('no expanded body at all fails (the material gate never silently passes)', () => {
    const result = serializedProbeInDom(probeToolMaterial, {}, {
      html: `<body><div class="th-tool" data-tool-call-id="t1"></div></body>`,
      tokens: { '--th-tool-border': 'rgba(255, 255, 255, 0.06)', '--th-tool-surface': '#1d1e22' },
    });
    expect(toolMaterialDecision(result).failures[0]).toContain('no expanded tool body');
  });
});

describe('serialized probeBorderedSamples (S4 evidence: names every bordered element)', () => {
  const run = html => serializedProbeInDom(probeBorderedSamples, {}, { html });
  const pane = inner => `<body><section class="th-chat-pane">${inner}</section></body>`;
  test('names a bordered element with its painted sides, widths and colours', () => {
    const result = run(pane('<div class="th-box" style="border: 1px solid rgba(24, 24, 27, 0.07)">boxed</div><p>plain</p>'));
    expect(result.borderedSampleCount).toBe(1);
    expect(result.borderedSamples[0].label).toContain('th-box');
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(result.borderedSamples[0].sides[side]).toMatchObject({ width: 1, counts: true });
      expect(result.borderedSamples[0].sides[side].color).toBeTruthy();
    }
  });
  test('a transparent hairline (alpha <= 0.02) does not count, matching the census predicate', () => {
    const result = run(pane('<div class="th-capsule" style="border: 1px solid rgba(0, 0, 0, 0)">borderless</div>'));
    expect(result.borderedSampleCount).toBe(0);
    expect(result.borderedSamples).toEqual([]);
  });
  test('invisible elements and form fields are skipped', () => {
    const result = run(pane('<div style="display: none; border: 1px solid rgba(24, 24, 27, 0.07)">hidden</div><input style="border: 1px solid rgba(24, 24, 27, 0.07)" value="x" />'));
    expect(result.borderedSampleCount).toBe(0);
  });
  test('the sample list caps at 30 entries', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `<div class="th-row-${i}" style="border: 1px solid rgba(24, 24, 27, 0.07)">r${i}</div>`).join('');
    const result = run(pane(rows));
    expect(result.borderedSampleCount).toBe(30);
    expect(result.borderedSamples).toHaveLength(30);
  });
  test('a missing chat pane reports an empty census, never a throw', () => {
    expect(run('<body><div style="border: 1px solid rgba(24, 24, 27, 0.07)">orphan</div></body>')).toEqual({ borderedSamples: [], borderedSampleCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Pure decisions, pinned against the pre-redesign baseline
// ---------------------------------------------------------------------------

describe('keyboardHintRowText (S9)', () => {
  test('accepts real hint rows in several spellings', () => {
    expect(keyboardHintRowText('↑↓ navigate · Enter select · Esc close')).toBe(true);
    expect(keyboardHintRowText('Arrow keys to move, Enter selects, Escape dismisses')).toBe(true);
    expect(keyboardHintRowText('Tab cycles · Enter opens · Esc closes')).toBe(true);
    expect(keyboardHintRowText('↓↑ 이동 · Enter 선택 · Esc 닫기')).toBe(true);
    // The shipped row: kbd glyphs (↑ ↓ ↵ esc) with label spans - the
    // combined row text names both families through the symbols.
    expect(keyboardHintRowText('↑↓ to navigate ↵ to select esc to dismiss')).toBe(true);
  });
  test('rejects command descriptions and empty or oversized text', () => {
    expect(keyboardHintRowText('/compact — Compact the session history')).toBe(false);
    expect(keyboardHintRowText('Enter your prompt below')).toBe(false);
    expect(keyboardHintRowText('Press Escape')).toBe(false); // confirm-only, no navigation key
    expect(keyboardHintRowText('↑↓')).toBe(false); // navigation-only, no confirm key
    expect(keyboardHintRowText('')).toBe(false);
    expect(keyboardHintRowText('x'.repeat(200))).toBe(false);
    expect(keyboardHintRowText(null)).toBe(false);
  });
});

describe('extractColorStrings + ringColorDecision (S9)', () => {
  test('extracts rgb, color() and hex from computed value lists', () => {
    expect(extractColorStrings('rgba(139, 124, 246, 0.55) 0px 0px 0px 3px')).toEqual(['rgba(139, 124, 246, 0.55)']);
    expect(extractColorStrings('color(srgb 0.545 0.486 0.965 / 0.55) 0px 0px 0px 3px, rgb(0 0 0 / 10%) 0px 1px 2px')).toHaveLength(2);
    expect(extractColorStrings('')).toEqual([]);
    expect(extractColorStrings(null)).toEqual([]);
  });
  test('the accent-alpha ring matches the resolved token; a neutral ring does not', () => {
    const ring = 'rgba(139, 124, 246, 0.55) 0px 0px 0px 3px';
    expect(ringColorDecision({ boxShadow: 'rgba(139, 124, 246, 0.551) 0px 0px 0px 3px', ringShadow: ring })).toBe(true);
    expect(ringColorDecision({ boxShadow: 'rgba(255, 255, 255, 0.14) 0px 0px 0px 2px', ringShadow: ring })).toBe(false);
    expect(ringColorDecision({ boxShadow: 'none', ringShadow: ring })).toBe(false);
  });
});

describe('composerDecision (S9, baseline: white send, neutral ring)', () => {
  const contractFacts = {
    sendFound: true, sendDisabled: false, sendIsDanger: false,
    sendBackground: 'rgb(109, 91, 208)', accentSolidRaw: '#6d5bd0',
    boxShadow: 'rgba(139, 124, 246, 0.55) 0px 0px 0px 3px', ringMatches: true,
  };
  test('contract facts pass', () => {
    expect(composerDecision(contractFacts).pass).toBe(true);
  });
  test('the pre-redesign white send fails the accent-solid gate', () => {
    const verdict = composerDecision({ ...contractFacts, sendBackground: 'rgb(255, 255, 255)' });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('!= --th-accent-solid');
  });
  test('a neutral focus ring and the Stop control each fail', () => {
    expect(composerDecision({ ...contractFacts, ringMatches: false }).pass).toBe(false);
    expect(composerDecision({ ...contractFacts, sendIsDanger: true }).pass).toBe(false);
    expect(composerDecision({ ...contractFacts, sendDisabled: true }).pass).toBe(false);
    expect(composerDecision({ sendFound: false }).failures[0]).toContain('not found');
  });
});

describe('paletteDecision (S9, baseline: plain raised box without glass or hints)', () => {
  const glassy = {
    paletteFound: true, backdropFilter: 'blur(20px) saturate(1.5)', optionCount: 4,
    nonOptionTexts: ['↑↓ navigate · Enter select · Esc close'],
  };
  test('glass + hint row passes', () => {
    const verdict = paletteDecision(glassy);
    expect(verdict.pass).toBe(true);
    expect(verdict.measurements.hintRowCount).toBe(1);
  });
  test('the pre-redesign palette fails both gates', () => {
    const verdict = paletteDecision({ paletteFound: true, backdropFilter: 'none', optionCount: 4, nonOptionTexts: [] });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join(' ')).toContain('backdrop-filter');
    expect(verdict.failures.join(' ')).toContain('keyboard hint row');
  });
  test('a missing palette reports itself', () => {
    expect(paletteDecision({ paletteFound: false }).failures[0]).toContain('did not render');
  });
});

describe('commandInsertDecision (S9)', () => {
  const good = { inserted: '/compact ', paletteClosed: true, focusedAfterInsert: true, sendFrameCount: 0 };
  test('a clean ArrowDown+Enter selection passes', () => {
    expect(commandInsertDecision(good).pass).toBe(true);
    expect(commandInsertDecision({ ...good, inserted: '/new ' }).pass).toBe(true);
  });
  test('an empty insert, an open palette, lost focus or a send each fail', () => {
    expect(commandInsertDecision({ ...good, inserted: '' }).pass).toBe(false);
    expect(commandInsertDecision({ ...good, paletteClosed: false }).pass).toBe(false);
    expect(commandInsertDecision({ ...good, focusedAfterInsert: false }).pass).toBe(false);
    expect(commandInsertDecision({ ...good, sendFrameCount: 1 }).pass).toBe(false);
  });
});

describe('railFactsDecision (S7, baseline: no rail)', () => {
  const record = overrides => ({
    id: 'design-read', kind: 'tool', recordVisible: true, railFound: true, railVisible: true,
    glyphFound: true, railSpansRecord: true, railWidth: 1, railCenter: 300, glyphCenter: 300,
    continues: false, previousVisible: false,
    ...overrides,
  });
  test('a thin, full-height glyph-centered rail passes', () => {
    expect(railFactsDecision({ toolCount: 1, facts: [record()] }).pass).toBe(true);
  });
  test('the pre-redesign transcript (no rail anywhere) fails', () => {
    const verdict = railFactsDecision({ toolCount: 3, facts: [record({ railFound: false, railVisible: false, railWidth: null, railCenter: null })] });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('no qualifying timeline rail');
  });
  test('an invisible, wide, offset or short rail each fail', () => {
    expect(railFactsDecision({ toolCount: 1, facts: [record({ railVisible: false })] }).pass).toBe(false);
    expect(railFactsDecision({ toolCount: 1, facts: [record({ railWidth: 14 })] }).pass).toBe(false);
    expect(railFactsDecision({ toolCount: 1, facts: [record({ railCenter: 276 })] }).pass).toBe(false);
    expect(railFactsDecision({ toolCount: 1, facts: [record({ railSpansRecord: false })] }).pass).toBe(false);
  });
  test('no visible tool records at all is a failure, not a pass', () => {
    const verdict = railFactsDecision({ toolCount: 0, facts: [] });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('no visible tool records');
  });
});

describe('fadeDecision / outputFadeDecision (S7, baseline: hard cutoff)', () => {
  const overflowing = {
    id: 'design-failed', overflows: true, scrollHeight: 2400, clientHeight: 360,
    maskImage: 'none', webkitMaskImage: 'none', parentMaskImage: 'none',
    ownAfter: 'none', ownBefore: 'none', parentAfter: 'none', parentBefore: 'none',
  };
  test('the pre-redesign overflowing output without any fade fails', () => {
    const verdict = outputFadeDecision([overflowing]);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toContain('without a bottom fade');
  });
  test('a mask-image satisfies the fade', () => {
    expect(fadeDecision({ ...overflowing, maskImage: 'linear-gradient(to bottom, black 82%, transparent)' }).hasFade).toBe(true);
    expect(outputFadeDecision([{ ...overflowing, maskImage: 'linear-gradient(to bottom, black 82%, transparent)' }]).pass).toBe(true);
  });
  test('a gradient pseudo-element on the wrapper satisfies the fade', () => {
    expect(fadeDecision({ ...overflowing, parentAfter: 'linear-gradient(to bottom, rgba(0,0,0,0), rgb(23 24 27))' }).hasFade).toBe(true);
  });
  test('a non-overflowing output is not gated, but an empty measurement is', () => {
    expect(outputFadeDecision([{ ...overflowing, overflows: false }]).pass).toBe(true);
    expect(outputFadeDecision([]).pass).toBe(false);
  });
});

describe('disclosureConsistency (S7/S22)', () => {
  test('agreement passes in both states', () => {
    expect(disclosureConsistency({ found: true, ariaExpanded: 'true', bodyPresent: true, bodyVisible: true }).ok).toBe(true);
    expect(disclosureConsistency({ found: true, ariaExpanded: 'false', bodyPresent: false, bodyVisible: false }).ok).toBe(true);
  });
  test('disagreement fails in both directions', () => {
    expect(disclosureConsistency({ found: true, ariaExpanded: 'true', bodyPresent: false, bodyVisible: false }).ok).toBe(false);
    expect(disclosureConsistency({ found: true, ariaExpanded: 'false', bodyPresent: true, bodyVisible: true }).ok).toBe(false);
    expect(disclosureConsistency({ found: false, ariaExpanded: 'true', bodyPresent: true, bodyVisible: true }).ok).toBe(false);
  });
});

describe('headerTextDecision (S6, baseline: mono badge and raw path)', () => {
  const run = (text, fontFamily, overrides = {}) => ({ text, fontFamily, visible: true, ...overrides });
  test('sans-only headers pass', () => {
    expect(headerTextDecision([
      run('Stored A', '"Pretendard Variable", Pretendard, sans-serif'),
      run('Resync', '"Pretendard Variable", Pretendard, sans-serif'),
    ]).pass).toBe(true);
  });
  test('the pre-redesign mono provider badge fails', () => {
    const verdict = headerTextDecision([
      run('Stored A', '"Pretendard Variable", sans-serif'),
      run('omo', 'ui-monospace, "SF Mono", monospace'),
    ]);
    expect(verdict.pass).toBe(false);
    expect(verdict.measurements.monoRuns[0].text).toBe('omo');
  });
  test('hidden runs and cwd carriers are skipped; their gates live elsewhere', () => {
    expect(headerTextDecision([
      run('omo', 'monospace', { visible: false }),
      run('/fixture', 'ui-monospace, monospace'),
    ], { cwd: '/fixture' }).pass).toBe(true);
  });
});

describe('toolMaterialDecision (S4)', () => {
  const material = {
    toolBorderRaw: 'rgba(255, 255, 255, 0.06)', toolSurfaceRaw: '#1d1e22',
    facts: [{ id: 'design-read', expanded: true, borderTopColor: 'rgba(255, 255, 255, 0.06)', backgroundColor: 'rgb(29, 30, 34)' }],
  };
  test('records on the scoped material pass', () => {
    expect(toolMaterialDecision(material).pass).toBe(true);
  });
  test('a foreign border or fill fails, and no expanded bodies at all fails', () => {
    expect(toolMaterialDecision({ ...material, facts: [{ ...material.facts[0], borderTopColor: 'rgb(64, 64, 64)' }] }).pass).toBe(false);
    expect(toolMaterialDecision({ ...material, facts: [{ ...material.facts[0], backgroundColor: 'rgb(38, 38, 38)' }] }).pass).toBe(false);
    expect(toolMaterialDecision({ ...material, facts: [] }).pass).toBe(false);
    expect(toolMaterialDecision({ ...material, facts: [{ ...material.facts[0], expanded: false }] }).pass).toBe(false);
  });
});

describe('switchOutcomeDecision (S22)', () => {
  const good = {
    headerName: 'Newer', expectedHeader: 'Newer',
    requiresTranscriptMarker: true, transcriptMarkerPresent: true, staleMarkers: [],
  };
  test('ending on the last session with its marker and no stale rows passes', () => {
    expect(switchOutcomeDecision(good).pass).toBe(true);
  });
  test('wrong final session, missing marker or stale content each fail', () => {
    expect(switchOutcomeDecision({ ...good, headerName: 'Stored A' }).pass).toBe(false);
    expect(switchOutcomeDecision({ ...good, transcriptMarkerPresent: false }).pass).toBe(false);
    const stale = switchOutcomeDecision({ ...good, staleMarkers: [{ kind: 'tool', text: 'design-failed', present: true }] });
    expect(stale.pass).toBe(false);
    expect(stale.failures[0]).toContain('stale tool content');
  });
});

// ---------------------------------------------------------------------------
// parseColor sanity reused by the decisions (keeps the contract values
// honest: the pinned accent-solid resolves exactly in both themes)
// ---------------------------------------------------------------------------

describe('token anchors used by the T2 decisions', () => {
  test('--th-accent-solid resolves in both themes and differs from the icon-era #8b7cf6', () => {
    const dark = parseColor('#6d5bd0');
    expect(dark).toEqual({ r: 109, g: 91, b: 208, a: 1 });
    // The plan pins #8b7cf6 as the AGENT-ALIVE accent, never the send fill
    // (white on #8b7cf6 fails 4.5) - the decisions must not accept it.
    const accent = parseColor('#8b7cf6');
    expect(Math.abs(accent.r - dark.r)).toBeGreaterThan(10);
  });
});

describe('dagCatalogPayloads (S5/S8 fixture route payloads)', () => {
  test('document counts mirror the exact node-state histogram parseCompleteDag recomputes', () => {
    const { catalog, document } = dagCatalogPayloads();
    const run = document.run;
    const histogram = run.nodes.reduce((acc, node) => { acc[node.state] = (acc[node.state] ?? 0) + 1; return acc; }, {});
    for (const [state, count] of Object.entries(histogram)) {
      expect(run.counts[state], `counts.${state}`).toBe(count);
    }
    expect(run.counts.total).toBe(run.nodes.length);
    // Edges mirror dependencies exactly.
    for (const node of run.nodes) {
      for (const dep of node.depends_on) expect(run.edges).toContainEqual({ from: dep, to: node.id });
    }
    expect(catalog.runs).toHaveLength(1);
    expect(catalog.runs[0]).toMatchObject({ run_id: run.run_id, status: 'running', total: 2, content_token: document.content_token });
    expect(catalog.next_cursor).toBeNull();
  });
});

const chatStateTokens = {
  '--th-success': '#146c43',
  '--th-warning': '#a15c07',
  '--th-error': '#b3252e',
  '--th-accent': '#8b7cf6',
};

describe('serialized probeChatStateColors (S5 chat scope)', () => {
  const outOfScopeHtml = `<body>
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

  test('sidebar and activity-shelf violations are ignored', () => {
    const result = serializedProbeInDom(probeChatStateColors, {}, { html: outOfScopeHtml, tokens: chatStateTokens });
    expect(result.pass).toBe(true);
    expect(result.measurements.stateColorViolationCount).toBe(0);
    expect(result.measurements.uppercaseCount).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test('a painted error border inside the pane still fails, and the shelf sample is absent', () => {
    const html = outOfScopeHtml.replace(
      '<div class="th-chat-msg">plain transcript</div>',
      '<span id="chat-status" class="th-tool-status" style="border: 1px solid #b3252e">failed</span>',
    );
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.measurements.stateColorViolationSamples.length).toBeGreaterThan(0);
    expect(result.measurements.stateColorViolationSamples.every(sample => sample.token === 'error')).toBe(true);
    expect(result.measurements.stateColorViolationSamples.every(sample => sample.where.includes('th-tool-status'))).toBe(true);
    expect(result.measurements.stateColorViolationSamples.some(sample => sample.where.includes('th-activity-chip'))).toBe(false);
    expect(result.measurements.stateColorViolationSamples.some(sample => sample.where.includes('th-sidebar'))).toBe(false);
    expect(result.measurements.uppercaseCount).toBe(0);
  });

  test('uppercase inside the pane still fails', () => {
    const html = outOfScopeHtml.replace(
      '<div class="th-chat-msg">plain transcript</div>',
      '<span class="th-chat-kicker" style="text-transform: uppercase">Running</span>',
    );
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.measurements.uppercaseCount).toBe(1);
    expect(result.measurements.uppercaseSamples[0].text).toBe('Running');
    expect(result.measurements.uppercaseSamples[0].where).toContain('th-chat-kicker');
    expect(result.measurements.stateColorViolationCount).toBe(0);
  });

  test('error text and a zero-width border inside the pane pass', () => {
    const html = `<body><section class="th-chat-pane">
      <span class="th-tool-status" style="color: #b3252e; border-width: 0; border-style: solid; border-color: #b3252e">failed</span>
    </section></body>`;
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(true);
    expect(result.measurements.stateColorViolationCount).toBe(0);
  });

  test('an in-pane svg rect accent stroke fails and a circle glyph stroke does not', () => {
    const rect = serializedProbeInDom(probeChatStateColors, {}, {
      html: '<body><section class="th-chat-pane"><svg><rect style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></rect></svg></section></body>',
      tokens: chatStateTokens,
    });
    expect(rect.pass).toBe(false);
    expect(rect.measurements.stateColorViolationSamples[0].token).toBe('accent');
    expect(rect.measurements.stateColorViolationSamples[0].where).toBe('rect');
    const circle = serializedProbeInDom(probeChatStateColors, {}, {
      html: '<body><section class="th-chat-pane"><svg><circle class="th-tool-glyph" style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></circle></svg></section></body>',
      tokens: chatStateTokens,
    });
    expect(circle.pass).toBe(true);
    expect(circle.measurements.stateColorViolationCount).toBe(0);
  });

  test('a missing chat pane fails closed', () => {
    const result = serializedProbeInDom(probeChatStateColors, {}, {
      html: '<body><div style="border: 1px solid #b3252e">orphan</div></body>',
      tokens: chatStateTokens,
    });
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(['.th-chat-pane not found']);
  });

  test('a body-level question/approval portal fails for a painted state border and uppercase label', () => {
    const html = `<body><section class="th-chat-pane">chat</section>
      <div class="th-modal-overlay"><div class="th-modal"><div class="th-question-window">
        <div class="th-approval-options"><button style="border: 1px solid #b3252e; text-transform: uppercase">Approve</button></div>
      </div></div></div></body>`;
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.measurements).toMatchObject({ portalMeasured: true, portalCount: 1, questionPortalCount: 1 });
    expect(result.measurements.portalElementCount).toBeGreaterThanOrEqual(4);
    expect(result.measurements.stateColorViolationSamples[0]).toMatchObject({ token: 'error' });
    expect(result.measurements.uppercaseSamples[0].text).toBe('Approve');
  });

  test('a valid body portal passes, including its enclosing overlay and panel', () => {
    const html = `<body><section class="th-chat-pane">chat</section>
      <div class="th-modal-overlay" style="border: 1px solid #999"><div class="th-modal">
        <div class="th-question-window"><button style="border: 1px solid #999">Approve</button></div>
      </div></div><div class="th-model-picker-popover"><span>Model</span></div></body>`;
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(true);
    expect(result.measurements).toMatchObject({
      portalMeasured: true, portalCount: 2, questionPortalCount: 1, modelPickerPortalCount: 1,
      stateColorViolationCount: 0, uppercaseCount: 0,
    });
    expect(result.measurements.portalElementCount).toBeGreaterThanOrEqual(5);
  });
});

const t2ExcludedSelectors = [
  '.th-activity-shelf',
  '.th-goal-shelf',
  '.th-goal-bar',
  '.th-activity-chip',
  '.th-activity-g*',
];

/** GoalBar's real root is section.th-goal-shelf; the chip sits on the
 * summary button.th-goal-bar. The objective is in the panel, which is
 * inside the root and outside the button. */
const goalBarHtml = (extra = '') => `<body><section class="th-chat-pane">
  <section class="th-goal-shelf">
    <div class="th-activity-bar-row" role="status">
      <button type="button" class="th-activity-bar th-goal-bar">
        <span id="goal-chip" class="th-activity-chip" style="text-transform: uppercase; border: 1px solid #146c43">Active</span>
      </button>
    </div>
    <div class="th-goal-panel">
      <p class="th-goal-objective-full" style="text-transform: uppercase">Objective</p>
    </div>
  </section>
  ${extra}
</section></body>`;

const runningGlyphHtml = (glyphStyle) => `<body><section class="th-chat-pane">
  <span class="th-tool-glyph th-tool-glyph--running" style="${glyphStyle}"></span>
  <span class="th-tool-status">Running</span>
  <svg>
    <g id="dag-node" class="th-activity-gnode th-activity-gnode--running" style="stroke: #ededf0; fill: #000000; color: #ededf0">
      <circle id="dag-status" class="th-activity-gstatus th-activity-gstatus--running" style="stroke: #ededf0; fill: none; color: #ededf0"></circle>
    </g>
  </svg>
</section></body>`;

describe('serialized T2 S5/S8 exclusion of T4-owned elements', () => {
  test('S5 and both S8 probes inline the same ownership predicate', () => {
    // bun reprints function source (comments dropped, quotes normalised).
    // The reprinted predicate is what the page actually receives.
    const slice = fn => {
      const source = fn.toString();
      const start = source.indexOf('excludedSelectors');
      const marker = 'node = node.parentElement';
      const end = source.indexOf(marker);
      expect(start, fn.name).toBeGreaterThan(-1);
      expect(end, fn.name).toBeGreaterThan(start);
      return source.slice(start, end + marker.length);
    };
    const canonical = slice(probeChatStateColors);
    expect(slice(probeChatRunningGlyphs)).toBe(canonical);
    expect(slice(probeChatRunningReducedMotion)).toBe(canonical);
    expect(canonical).toContain('.th-goal-shelf');
    expect(canonical).toContain('.th-goal-bar');
    expect(canonical).toContain('.th-activity-chip');
    expect(canonical).toContain('.th-activity-shelf');
    expect(canonical).toContain('th-activity-g');
  });

  test('uppercase activity chip inside the goal bar is ignored, including the shelf panel', () => {
    const result = serializedProbeInDom(probeChatStateColors, {}, { html: goalBarHtml(), tokens: chatStateTokens });
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.measurements.uppercaseCount).toBe(0);
    expect(result.measurements.stateColorViolationCount).toBe(0);
    expect(result.measurements.excludedSelectors).toEqual(t2ExcludedSelectors);
    // shelf, row, button, chip, panel, objective
    expect(result.measurements.excludedElementCount).toBe(6);
    expect(result.measurements.excludedSamples).toContain('span#goal-chip.th-activity-chip');
    expect(result.measurements.excludedSamples).toContain('section.th-goal-shelf');
    expect(result.measurements.excludedSamples).toContain('p.th-goal-objective-full');
  });

  test('uppercase text in a T2-owned element still fails, and so does its painted border', () => {
    const html = goalBarHtml('<span class="th-chat-kicker" style="text-transform: uppercase">Running</span><span class="th-tool-status" style="border: 1px solid #b3252e">failed</span>');
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.measurements.uppercaseCount).toBe(1);
    expect(result.measurements.uppercaseSamples[0].text).toBe('Running');
    expect(result.measurements.uppercaseSamples[0].where).toContain('th-chat-kicker');
    expect(result.measurements.uppercaseSamples.some(sample => sample.where.includes('th-activity-chip'))).toBe(false);
    expect(result.measurements.uppercaseSamples.some(sample => sample.where.includes('th-goal-objective'))).toBe(false);
    expect(result.measurements.stateColorViolationSamples.every(sample => sample.where.includes('th-tool-status'))).toBe(true);
    expect(result.measurements.stateColorViolationCount).toBeGreaterThan(0);
    expect(result.failures.some(failure => failure.includes('th-chat-kicker'))).toBe(true);
    expect(result.failures.some(failure => failure.includes('th-activity-chip'))).toBe(false);
  });

  test('an accent-stroked rect inside a DAG gnode is ignored and a sibling rect still fails', () => {
    const html = `<body><section class="th-chat-pane">
      <svg>
        <g class="th-activity-gnode th-activity-gnode--running">
          <rect style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></rect>
        </g>
      </svg>
      <svg><rect id="chat-rect" style="stroke: #8b7cf6; stroke-width: 2px; fill: none"></rect></svg>
    </section></body>`;
    const result = serializedProbeInDom(probeChatStateColors, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.measurements.stateColorViolationSamples).toHaveLength(1);
    expect(result.measurements.stateColorViolationSamples[0].where).toBe('rect#chat-rect');
    expect(result.measurements.excludedElementCount).toBeGreaterThan(0);
  });

  test('a non-accent running tool glyph still fails S8', () => {
    const html = runningGlyphHtml('background-color: #ededf0; color: #ededf0; border-color: #ededf0');
    const result = serializedProbeInDom(probeChatRunningGlyphs, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.scenario).toBe('S8');
    expect(result.failures.some(failure => failure.includes('.th-tool-glyph--running'))).toBe(true);
    expect(result.failures.some(failure => failure.includes('th-activity-g'))).toBe(false);
    expect(result.measurements.glyphs.map(glyph => glyph.selector)).toEqual(['.th-tool-glyph--running']);
    expect(result.measurements.excludedSelectors).toEqual(t2ExcludedSelectors);
    expect(result.measurements.excludedElementCount).toBe(2);
    expect(result.measurements.excludedSamples).toContain('g#dag-node');
    expect(result.measurements.excludedSamples).toContain('circle#dag-status');
  });

  test('a non-accent DAG gnode is ignored by T2 S8 while the shared probe still fails it', () => {
    const html = runningGlyphHtml('background-color: #8b7cf6');
    const scoped = serializedProbeInDom(probeChatRunningGlyphs, {}, { html, tokens: chatStateTokens });
    expect(scoped.pass).toBe(true);
    expect(scoped.failures).toEqual([]);
    expect(scoped.measurements.glyphsFound).toBe(1);
    expect(scoped.measurements.glyphs[0].matchesAccent).toBe(true);
    expect(scoped.measurements.glyphs[0].selector).toBe('.th-tool-glyph--running');
    expect(scoped.measurements.excludedElementCount).toBe(2);
    const shared = serializedProbeInDom(probeRunningGlyphs, {}, { html, tokens: chatStateTokens });
    expect(shared.pass).toBe(false);
    expect(shared.failures.some(failure => failure.includes('.th-activity-gnode--running'))).toBe(true);
    expect(shared.failures.some(failure => failure.includes('.th-activity-gstatus--running'))).toBe(true);
  });

  test('a non-accent tree running dot and overview dot still fail S8', () => {
    const html = `<body>
      <span class="th-tree-running-dot" style="background-color: #ededf0"></span>
      <span class="th-overview-card-running-dot" style="background-color: #ededf0"></span>
      <g id="dag-node" class="th-activity-gnode th-activity-gnode--running" style="stroke: #ededf0"></g>
    </body>`;
    const result = serializedProbeInDom(probeChatRunningGlyphs, {}, { html, tokens: chatStateTokens });
    expect(result.pass).toBe(false);
    expect(result.failures.some(failure => failure.includes('.th-tree-running-dot'))).toBe(true);
    expect(result.failures.some(failure => failure.includes('.th-overview-card-running-dot'))).toBe(true);
    expect(result.failures.some(failure => failure.includes('th-activity-g'))).toBe(false);
    expect(result.measurements.excludedElementCount).toBe(1);
  });

  test('reduced motion ignores an animating DAG gnode and still fails an animating tool glyph', () => {
    const html = `<body>
      <span class="th-tool-glyph th-tool-glyph--running animating" style="background-color: #8b7cf6"></span>
      <span class="th-tool-status">Running</span>
      <g id="dag-node" class="th-activity-gnode th-activity-gnode--running"></g>
    </body>`;
    const patch = window => {
      window.Element.prototype.getAnimations = function () {
        const raw = this.getAttribute ? (this.getAttribute('class') || '') : '';
        if (raw.includes('animating') || raw.includes('th-activity-gnode--running')) return [{ playState: 'running' }];
        return [];
      };
    };
    const failing = serializedProbeInDom(probeChatRunningReducedMotion, {}, { html, tokens: chatStateTokens, patch });
    expect(failing.pass).toBe(false);
    expect(failing.failures.some(failure => failure.includes('.th-tool-glyph--running') && failure.includes('still animates'))).toBe(true);
    expect(failing.failures.some(failure => failure.includes('th-activity-g'))).toBe(false);
    expect(failing.measurements.excludedElementCount).toBe(1);
    expect(failing.measurements.excludedSelectors).toEqual(t2ExcludedSelectors);
    const quiet = html.replace(' animating', '');
    const passing = serializedProbeInDom(probeChatRunningReducedMotion, {}, { html: quiet, tokens: chatStateTokens, patch });
    expect(passing.pass).toBe(true);
    expect(passing.measurements.glyphStates).toHaveLength(1);
    expect(passing.measurements.glyphStates[0].animationCount).toBe(0);
    expect(passing.measurements.excludedElementCount).toBe(1);
  });
});

describe('question window enter settle', () => {
  test('deadline fails the cell when captured enter animations never finish', async () => {
    let reads = 0;
    const finished = new Promise(() => {});
    const animation = { effect: { getTiming: () => ({ iterations: 1 }) } };
    Object.defineProperty(animation, 'finished', {
      get() {
        reads += 1;
        return finished;
      },
    });
    const root = { getAnimations: () => [animation] };
    const pending = settleEnterAnimations([root], { deadlineMs: 25 });
    // .finished is captured in the same turn as getAnimations, before the deadline wait.
    expect(reads).toBe(1);
    await expect(pending).rejects.toThrow('question window enter animations did not settle within 25ms');
    expect(reads).toBe(1);
  });

  test('resolves once finite enter animations finish and the panel is opacity 1 / transform none', async () => {
    const root = {
      getAnimations: () => [
        { finished: Promise.resolve(), effect: { getTiming: () => ({ iterations: 1 }) } },
        { finished: new Promise(() => {}), effect: { getTiming: () => ({ iterations: Infinity }) } },
      ],
    };
    const result = await settleEnterAnimations([root], {
      deadlineMs: 50,
      readStyle: () => ({ opacity: '1', transform: 'none', overlayOpacity: '1' }),
    });
    expect(result.animationCount).toBe(1);
    expect(result.opacity).toBe('1');
    expect(result.transform).toBe('none');
    expect(result.overlayOpacity).toBe('1');
  });

  test('fails when the settled panel is not opacity 1 and transform none', async () => {
    const root = { getAnimations: () => [] };
    await expect(settleEnterAnimations([root], {
      deadlineMs: 50,
      readStyle: () => ({ opacity: '0.4', transform: 'matrix(0.98, 0, 0, 0.98, 0, 4)' }),
    })).rejects.toThrow('question window panel unsettled (opacity 0.4, transform matrix(0.98, 0, 0, 0.98, 0, 4))');
  });
});


