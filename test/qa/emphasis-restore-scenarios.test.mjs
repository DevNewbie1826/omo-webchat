/** Serialized negative controls: execute the SAME function source the browser
 * harness sends to page.evaluate, then feed its facts to the actual verdict.
 * No test paints the production SPA or substitutes a successful result. */
import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import english from '../../frontend/src/i18n/locales/en.json' with { type: 'json' };
import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';
import { buildScenarioRegistry, loadScenarioPlugins } from './visual-redesign.mjs';
import { pageKit } from './visual-redesign-probes.mjs';
import { t4StageSpec } from './visual-redesign-scenarios-t4.mjs';
import {
  scenarios, probeToolEmphasis, toolVerdict, probeStatusEmphasis, statusVerdict,
  dagVerdict, probeSidebarEmphasis, sidebarVerdict, probeHeadingRunningCount, headingRunningCountVerdict,
  probeHeadings, headingVerdict,
  probeLiveCardInk, liveCardInkVerdict,
  probeDagRunningPaint, dagRunningPaintVerdict,
  sidebarStatesVerdict,
  probeActionSurface, actionVerdict, probeOverlayEmphasis, overlayVerdict,
  probeSecondary, secondaryVerdict, probeEmptyPane, probeSplitApplicability, emptyVerdict, probeMobileDag,
  mobileDagVerdict, dagAncestorVerdict, dagTypographyVerdict, dagGraphScaleVerdict, dagListScaleVerdict,
  compactDagPaddingVerdict,
  probeDagListText, phoneToolVerdict, probeDisclosureGeometry, disclosureVerdict,
  probeWorkspaceLabels, workspaceLabelVerdict,
  probeWorkspaceContinuity, workspaceContinuityVerdict,
  probeWorkspaceColumns, workspaceColumnsVerdict,
} from './emphasis-restore-scenarios.mjs';

const tokens = {
  '--th-bg': '#17181b',
  '--th-accent': '#8b7cf6', '--th-accent-ink': '#9d90f8', '--th-accent-bg': 'rgba(139,124,246,.12)',
  '--th-success': '#3fc084', '--th-success-bg': 'rgba(63,192,132,.12)',
  '--th-error': '#f98085', '--th-error-bg': 'rgba(249,128,133,.12)',
  '--th-warning': '#f5a623', '--th-active': '#34353c',
  '--th-text': '#ededf0', '--th-border-surface': 'rgba(255,255,255,.06)',
  '--th-tool-record-border': 'rgba(255,255,255,.16)',
  '--th-font-mono': 'ui-monospace, monospace', '--th-weight-emphasize': '600',
};

function serialized(probe, html, patch = () => {}, arg = {}) {
  const dom = new JSDOM(`<html><body>${html}</body></html>`,
    { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://qa.local/' });
  const { window } = dom;
  window.Element.prototype.getClientRects = function () { return [{ width: 20, height: 20 }]; };
  const browserRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    const result = browserRect.call(this);
    return { ...result, left: result.left, right: result.right, top: result.top, bottom: result.bottom,
      width: result.width, height: result.height, toJSON() { return this; } };
  };
  window.Element.prototype.getAnimations = () => [];
  window.matchMedia = () => ({ matches: false });
  window.Range.prototype.getBoundingClientRect = function () {
    const result = this.startContainer.parentElement.getBoundingClientRect();
    return { ...result, toJSON() { return this; } };
  };
  for (const [name, value] of Object.entries(tokens))
    window.document.documentElement.style.setProperty(name, value);
  patch(window, window.document);
  try {
    const facts = window.eval(`(function(){${pageKit()}\nreturn (${probe.toString()})(${JSON.stringify(arg)});})()`);
    if (facts instanceof window.Promise) return facts.finally(() => window.close());
    window.close();
    return facts;
  } catch (error) { window.close(); throw error; }
}

describe('emphasis scenario registry', () => {
  test('all requested Q ids are real registered plugin drivers', async () => {
    const plugins = await loadScenarioPlugins(import.meta.dir);
    const mine = plugins.find(item => item.file === 'emphasis-restore-scenarios.mjs');
    expect(mine?.skipped).toBeUndefined();
    const ids = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10',
      'Q14', 'Q15', 'Q17', 'Q23', 'Q24', 'Q25', 'Q26', 'Q27'];
    for (const id of ids) expect(typeof scenarios[id]).toBe('function');
    const registry = buildScenarioRegistry(plugins);
    for (const id of ids) {
      expect(registry.find(row => row.id === id)).toMatchObject({
        id, origin: 'plugin:emphasis-restore-scenarios.mjs', stub: false, run: scenarios[id],
      });
    }
  });
});

function unusedUndocumentedTokens(css, design, source) {
  const defined = [...new Set([...css.matchAll(/^\s*(--th-[\w-]+)\s*:/gm)].map(match => match[1]))];
  return defined.filter(name => !design.includes(name)
    && !new RegExp(`var\\(\\s*${name}(?![\\w-])|(?:getPropertyValue|setProperty)\\(\\s*['"]${name}['"]`).test(source));
}

test('Q11 every defined token has a consumer or DESIGN.md entry', async () => {
  expect(unusedUndocumentedTokens('--th-tool-surface: #222;', '', '')).toEqual(['--th-tool-surface']);
  expect(unusedUndocumentedTokens('--th-tool-surface: #222;', '', 'background: var(--th-tool-surface);')).toEqual([]);
  const root = resolve(import.meta.dir, '../..');
  const files = [];
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) await visit(path);
      else if (/\.(?:css|tsx?|mjs)$/.test(item.name) && !/\.(?:test|spec)\./.test(item.name)
        && item.name !== 'tokens.css') files.push(path);
    }
  }
  await visit(resolve(root, 'frontend/src'));
  const [css, design, ...source] = await Promise.all([
    readFile(resolve(root, 'frontend/src/styles/tokens.css'), 'utf8'),
    readFile(resolve(root, 'DESIGN.md'), 'utf8'),
    ...files.map(file => readFile(file, 'utf8')),
  ]);
  expect(unusedUndocumentedTokens(css, design, source.join('\n'))).toEqual([]);
});

describe('serialized negative controls (old drained/overflowing state)', () => {
  test('Q1 a borderless tool with an invocation under its rail fails', () => {
    const data = serialized(probeToolEmphasis, `<section class="th-chat-pane">
      <div class="th-tool" data-tool-call-id="design-read">
        <span class="th-chat-record-rail"></span>
        <button class="th-tool-head" aria-expanded="false">
          <span class="th-tool-glyph"></span><span class="th-tool-invocation">read</span>
          <span class="th-tool-status">Done</span><span class="th-tool-chevron"></span>
        </button>
      </div></section>`, (_window, document) => {
      const boxes = {
        '.th-tool': { left: 10, right: 180, top: 10, bottom: 60 },
        '.th-chat-record-rail': { left: 20, right: 21, top: 10, bottom: 60 },
        '.th-tool-invocation': { left: 18, right: 80, top: 20, bottom: 40 },
      };
      for (const [selector, box] of Object.entries(boxes))
        document.querySelector(selector).getBoundingClientRect = () =>
          ({ ...box, width: box.right - box.left, height: box.bottom - box.top, toJSON() { return this; } });
    });
    const result = toolVerdict(data, ['design-read']);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('rail intersects'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('card tint'))).toBe(true);
  });

  test('Q1 accepts a 24px card indent and rejects the old 48px indent', () => {
    const probeAt = indent => serialized(probeToolEmphasis,
      `<div class="th-chat-row"><div class="th-chat-msg">
        <div class="th-tool" data-tool-call-id="design-read"><span class="th-chat-record-rail"></span>
          <button class="th-tool-head" aria-expanded="false">
            <span class="th-tool-glyph"></span><span class="th-tool-status">Done</span>
          </button>
        </div></div></div>`,
      (_window, document) => {
        const bounds = {
          '.th-chat-row': [10, 390], '.th-tool': [10 + indent, 350],
          '.th-chat-record-rail': [21.5, 22.5], '.th-tool-glyph': [16, 28],
        };
        for (const [selector, [left, right]] of Object.entries(bounds))
          document.querySelector(selector).getBoundingClientRect = () => ({
            left, right, top: 0, bottom: 60, width: right - left, height: 60,
            toJSON() { return this; },
          });
      });
    expect(toolVerdict(probeAt(24), ['design-read']).failures
      .some(reason => reason.includes('indent'))).toBe(false);
    expect(toolVerdict(probeAt(48), ['design-read']).failures)
      .toContain('Q1 design-read indent 48.0px != 24px');
  });

  test('Q2 actual grey-on-neutral goal/todo/agents/DAG chips fail state contract', () => {
    const data = serialized(probeStatusEmphasis, `<span class="th-goal-bar">
      <span class="th-activity-chip th-activity-chip--running" style="color:#999;background:#333">Active</span></span>
      <span class="th-activity-todo-task"><span class="th-activity-chip th-activity-chip--ok"
        style="color:#999;background:#333">Complete</span></span>
      <span class="th-activity-agent"><span class="th-activity-chip th-activity-chip--error"
        style="color:#999;background:#333">Failed</span></span>
      <span class="th-activity-dag-head"><span class="th-activity-chip th-activity-chip--running"
        style="color:#999;background:#333">Running</span></span>`);
    const result = statusVerdict(data, ['goal', 'todo', 'agents', 'dag-head']);
    expect(result.pass).toBe(false);
    expect(result.failures.filter(reason => reason.includes('tint/ink')).length).toBe(4);
  });

  test('Q2 a valid chip elsewhere cannot replace a missing state in its own section', () => {
    const data = serialized(probeStatusEmphasis, `<div style="background:#17181b"><span class="th-goal-bar">
      <span class="th-activity-chip th-activity-chip--running"
        style="color:#9d90f8;background:rgba(139,124,246,.12)">Active</span></span>
      <span class="th-activity-agent"><span class="th-activity-chip th-activity-chip--ok"
        style="color:#3fc084;background:rgba(63,192,132,.12)">Complete</span></span></div>`);
    // jsdom leaves scratch-element var() colours unresolved; keep the
    // serialized DOM rows and supply the same resolved palette Chrome reads.
    const resolved = { ...data, tokens: { ...data.tokens, ...tokens } };
    expect(statusVerdict(resolved, ['goal'], ['success']).failures).toContain('Q2 success state not seeded');
    expect(statusVerdict(resolved, ['goal'], ['accent']).pass).toBe(true);
  });

  test('Q3 grey DAG cards/low-contrast edges are rejected even with all nodes present', () => {
    const data = serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><rect class="th-activity-gnode-card"></rect><text class="th-activity-glabel">k0</text></g>
      </svg></div>`);
    const facts = { found: true, scroller: data.reel, tokens,
      nodes: [{ id: 'k0', cls: 'th-activity-gnode--ok', cardFound: true,
        stroke: '#999', strokeOpacity: '1', strokeWidth: '1', fill: '#333' }],
      edges: [], arrowheads: [], graphBackground: '#17181b', halos: [], footer: null };
    const result = dagVerdict(facts, { completed: ['k0'], failed: ['f'], running: ['k6'] }, 1280);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('strokes'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('fulfilled'))).toBe(true);
  });

  async function paintedWords(ids, backgrounds) {
    return serialized(probeDagRunningPaint, `<svg>${ids.map(id =>
      `<g class="th-activity-gnode th-activity-gnode--running" data-node="${id}">
        <text class="th-activity-gstate" style="fill:rgb(157,144,248)">running</text>
      </g>`).join('')}</svg>`, (window, document) => {
      const targetY = ids.map((_, index) => 350 + index * 41);
      document.querySelectorAll('text').forEach((word, index) => {
        word.getBoundingClientRect = () => ({ left: 170, right: 195,
          top: targetY[index] - 8, bottom: targetY[index] + 8 });
      });
      window.Image = class { width = 390; height = 844; decode() { return Promise.resolve(); } };
      window.HTMLCanvasElement.prototype.getContext = () => ({
        drawImage(image) { this.normal = image.src.includes('normal'); },
        getImageData() {
          const normal = this.normal;
          return { data: new Proxy({}, { get(_target, property) {
            const offset = Number(property);
            if (!Number.isInteger(offset)) return undefined;
            const x = Math.floor(offset / 4) % 390, y = Math.floor(offset / 4 / 390);
            const channel = offset % 4;
            if (channel === 3) return 255;
            const index = targetY.indexOf(y);
            const background = backgrounds[index] ?? [29, 30, 34];
            return normal && x === 180 && index >= 0
              ? Math.round(background[channel] + 0.824 * ([157, 144, 248][channel] - background[channel]))
              : background[channel];
          } }) };
        },
      });
    }, { normalPng: 'normal', hiddenPng: 'hidden' });
  }

  test('Q3 serialized glyph-pixel probe rejects the old filled halo', async () => {
    const words = await paintedWords(['k6'], [[65, 60, 102]]);
    expect(words[0].glyphPixels).toBe(1);
    expect(words[0].sample).toMatchObject({ x: 180, y: 350 });
    expect(dagRunningPaintVerdict([0, 350, 700].map(time => ({ time, words }))).failures)
      .toContain('Q3 mixed k6 glyph contrast 3.7705:1 at halo 700ms');
  });

  test('Q3 adjacent dense running words reject the overlapping ring at their glyphs', async () => {
    const ids = ['w1n0', 'w1n1', 'w1n2'];
    const overlapping = await paintedWords(ids, [[54, 51, 81], [48, 46, 70], [48, 46, 70]]);
    const frame = words => [0, 350, 700].map(time => ({ time, words }));
    expect(overlapping.map(word => word.glyphPixels)).toEqual([1, 1, 1]);
    expect(dagRunningPaintVerdict(frame(overlapping), 'dense64').failures)
      .toContain('Q3 dense64 w1n0 glyph contrast 4.4468:1 at halo 700ms');
    expect(dagRunningPaintVerdict(frame(overlapping.slice(0, 2)), 'dense64').failures.join(' '))
      .toContain('only 2 painted running words');
    expect(dagRunningPaintVerdict(frame([{ ...overlapping[0], glyphPixels: 0 }, ...overlapping.slice(1)]),
      'dense64').failures.join(' ')).toContain('w1n0 glyph contrast');
    const separated = await paintedWords(ids, [[48, 46, 70], [48, 46, 70], [48, 46, 70]]);
    expect(dagRunningPaintVerdict(frame(separated), 'dense64').pass).toBe(true);
  });

  test('Q4 a grey nonmoving running count and weak selection fail', () => {
    const data = serialized(probeSidebarEmphasis, `<div class="th-sidebar-live">
      <div class="th-sidebar-live-count" style="color:#999">2</div></div>
      <span class="th-tree-running--count" style="color:#999">2</span>
      <div class="th-tree"><button aria-current="true"><span class="th-tree-label"
        style="font-weight:400">Selected</span></button></div>`);
    const result = sidebarVerdict(data);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('motion'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('selected'))).toBe(true);
  });

  test('Q4 a connected row that only changes its title fails the visual-state gate', () => {
    const running = serialized(probeSidebarEmphasis, `<div class="th-tree-node">
      <span class="th-tree-icon"><span class="th-tree-live"></span></span>
      <span class="th-tree-running"></span><button class="th-tree-activation"><span class="th-tree-label">Stored A</span></button></div>`);
    const connected = serialized(probeSidebarEmphasis, `<div class="th-tree-node">
      <span class="th-tree-icon"></span>
      <button class="th-tree-activation"><span class="th-tree-label">Newer connected</span></button></div>`);
    const idle = serialized(probeSidebarEmphasis, `<div class="th-tree-node">
      <span class="th-tree-icon"></span>
      <button class="th-tree-activation"><span class="th-tree-label">Newer</span></button></div>`);
    expect(sidebarStatesVerdict(running, connected, idle).pass).toBe(false);
    expect(sidebarStatesVerdict(running, connected, idle).failures.join(' '))
      .toContain('connected-but-idle');
    const live = serialized(probeSidebarEmphasis, `<div class="th-tree-node">
      <span class="th-tree-icon" style="color:#ededf0"><span class="th-tree-live"></span></span>
      <button class="th-tree-activation"><span class="th-tree-label">Newer</span></button></div>`);
    const result = sidebarStatesVerdict(running, live, idle);
    expect(result.pass).toBe(true);
  });

  function q5Geometry({ cardLeft = 17, labels = [70, 70, 70],
    childLeading = [36, 36, 36], cardBadgeRight = 247,
    parentLabelLeft = 59, parentLeadingLeft = 16 } = {}) {
    return serialized(probeSidebarEmphasis, `<div class="th-sidebar-live-label">Sessions</div>
      <span class="th-sidebar-live-count">1</span>
      <div class="th-sidebar-live-list"><span class="th-overview-card-name">Stored A</span>
        <span class="th-overview-card-running">1</span></div>
      <div class="th-tree-workspace">
        <div class="th-tree-node"><button class="th-tree-chevron"></button><span class="th-tree-icon"></span>
          <button class="th-tree-activation"><span class="th-tree-label-text">Workspace</span></button>
          <span class="th-tree-running--workspace">1</span></div>
        <fieldset class="th-tree-children">
          ${['Alpha', 'Beta', 'Gamma'].map(text => `<div class="th-tree-node">
            <span class="th-tree-placed"></span><span class="th-tree-icon"></span>
            <button class="th-tree-activation"><span class="th-tree-label">${text}</span></button>
          </div>`).join('')}
        </fieldset>
      </div>`, (_window, document) => {
      const rect = (el, left, right = left + 20) => {
        el.getBoundingClientRect = () => ({
          left, right, top: 0, bottom: 20, width: right - left, height: 20, toJSON() { return this; },
        });
      };
      for (const [selector, left, right] of [
        ['.th-sidebar-live-label', 16, 120], ['.th-sidebar-live-count', 228, 247],
        ['.th-overview-card-name', cardLeft, 100], ['.th-overview-card-running', 228, cardBadgeRight],
        ['.th-tree-chevron', parentLeadingLeft, parentLeadingLeft + 12],
        ['.th-tree-label-text', parentLabelLeft, 160],
        ['.th-tree-running--workspace', 228, 247],
      ]) rect(document.querySelector(selector), left, right);
      document.querySelectorAll('.th-tree-placed').forEach((el, index) =>
        rect(el, childLeading[index]));
      document.querySelectorAll('.th-tree-children .th-tree-label').forEach((el, index) =>
        rect(el, labels[index]));
    });
  }

  test('Q5 rejects live-card rows pinned to the top of a taller touch target', () => {
    const base = q5Geometry({ cardLeft: 17, parentLabelLeft: 16 });
    const centred = { ...base, cardCentering: [{ text: 'stored-a', contentTop: 108, contentBottom: 136, rowsTop: 113, rowsBottom: 131 }] };
    expect(sidebarVerdict(centred, { cards: 1, geometry: true }).pass).toBe(true);
    const pinned = { ...base, cardCentering: [{ text: 'stored-a', contentTop: 108, contentBottom: 136, rowsTop: 108, rowsBottom: 126 }] };
    const output = sidebarVerdict(pinned, { cards: 1, geometry: true });
    expect(output.failures).toContain('Q5 live card "stored-a" rows are -5.0px off vertical centre');
    console.log(`Q5 top-pinned control: ${output.failures.join('; ')}`);
  });

  test('Q23 rejects name ink centred in a button but high in the card border box', () => {
    const measure = (cardBottom, inkTop, inkBottom) => serialized(probeLiveCardInk,
      `<div class="th-sidebar-live-list"><div class="th-overview-card">
        <button class="th-overview-card-open"><span class="th-overview-card-name">Stored A</span></button>
      </div></div>`, (window, document) => {
        document.querySelector('.th-overview-card').getBoundingClientRect = () => ({
          left: 0, right: 200, top: 77.3, bottom: cardBottom,
          width: 200, height: cardBottom - 77.3, toJSON() { return this; },
        });
        window.Range.prototype.getBoundingClientRect = () => ({
          left: 8, right: 56, top: inkTop, bottom: inkBottom,
          width: 48, height: inkBottom - inkTop, toJSON() { return this; },
        });
      });
    expect(liveCardInkVerdict(measure(112.5, 87.9, 101.9), 1).pass).toBe(true);
    const output = liveCardInkVerdict(measure(112.5, 86.4, 100.4), 1);
    expect(output.failures).toContain('Q23 card "Stored A" name ink off border-box centre (9.1/12.1px)');
    console.log(`Q23 9.1/12.2 card-border control: ${output.failures.join('; ')}`);
  });

  test('Q5 parent label aligns with heading and card text', () => {
    const facts = q5Geometry({ cardLeft: 17, parentLabelLeft: 16 });
    expect(sidebarVerdict(facts, { cards: 1, geometry: true }).pass).toBe(true);
    expect(sidebarVerdict(q5Geometry({ parentLabelLeft: 116 }),
      { cards: 1, geometry: true }).failures)
      .toContain('Q5 left columns drift: 16,17,116');
  });

  test('Q5 a three-pixel live-card versus heading drift fails', () => {
    expect(sidebarVerdict(q5Geometry({ cardLeft: 19, parentLabelLeft: 16 }), { cards: 1, geometry: true }).failures)
      .toContain('Q5 left columns drift: 16,19,16');
  });

  test('Q5 a three-pixel workspace label-column drift fails', () => {
    expect(sidebarVerdict(q5Geometry({ parentLabelLeft: 19 }),
      { cards: 1, geometry: true }).failures)
      .toContain('Q5 left columns drift: 16,17,19');
  });

  test('Q5 a three-pixel sibling tree-label drift fails', () => {
    expect(sidebarVerdict(q5Geometry({ labels: [70, 70, 73] }), { cards: 1, geometry: true }).failures)
      .toContain('Q5 depth 1 tree labels drift: 70,70,73');
  });

  test('Q5 a three-pixel nested indent-step drift fails', () => {
    expect(sidebarVerdict(q5Geometry({ childLeading: [36, 36, 39] }),
      { cards: 1, geometry: true }).failures)
      .toContain('Q5 tree indentation steps drift: 20,20,23');
  });

  test('Q5 a three-pixel right badge drift still fails', () => {
    expect(sidebarVerdict(q5Geometry({ cardBadgeRight: 250 }), { cards: 1, geometry: true }).failures)
      .toContain('Q5 badge edges drift: 247,250,247');
  });

  test('Q5 another workspace badge cannot mask a missing heading badge', () => {
    const facts = q5Geometry();
    facts.headingBadges = [];
    facts.treeBadges.push(facts.treeBadges[0]);
    expect(sidebarVerdict(facts, { cards: 1, geometry: true }).failures)
      .toContain('Q5 badge edges drift: 247,247,247');
  });

  function workspaceProbe({ truncated = false, hiddenTail = false,
    glyphOutside = false, fontSize = 13 } = {}) {
    const markup = `<div class="th-sidebar"><div class="th-sidebar-body" style="padding:8px 12px;border:0 solid">
      <div class="th-tree-workspace">
      ${Array.from({ length: 12 }, (_, index) => `<div class="th-tree-node">
        <span class="th-tree-icon"><svg></svg></span>
        <button class="th-tree-activation" aria-label="Earlier workspace ${index + 1}">
          <span class="th-tree-label-text"><span class="th-tree-label-head">Earlier workspace </span><span class="th-tree-label-tail">${index + 1}</span></span></button></div>`).join('')}
      </div></div></div>`;
    return serialized(probeWorkspaceLabels, markup, (window, document) => {
      document.documentElement.style.setProperty('--th-font-size', `${fontSize}px`);
      if (fontSize === 24) window.localStorage.setItem('th-font-size', '24');
      const rectangle = (element, left, right, top = 20, bottom = 40) => {
        element.getBoundingClientRect = () => ({
          left, right, top, bottom, width: right - left, height: bottom - top,
          toJSON() { return this; },
        });
      };
      rectangle(document.querySelector('.th-sidebar'), 0, 264, 0, 700);
      rectangle(document.querySelector('.th-sidebar-body'), 0, 264, 0, 700);
      document.querySelectorAll('.th-tree-node').forEach((row, index) => {
        const top = 20 + index * 44, bottom = top + 20;
        rectangle(row, 12, 252, top, bottom);
        rectangle(row.querySelector('.th-tree-activation'), 32, 157, top, bottom);
        const label = row.querySelector('.th-tree-label-text');
        rectangle(label, 32, 157, top, bottom);
        Object.defineProperties(label, {
          scrollWidth: { value: index === 11 && truncated ? 160 : 120 },
          clientWidth: { value: index === 11 && truncated ? 64 : 125 },
        });
        const tail = row.querySelector('.th-tree-label-tail');
        if (index === 11 && hiddenTail) { tail.style.maxWidth = '0px'; tail.style.overflow = 'hidden'; }
        rectangle(tail, 130, index === 11 && hiddenTail ? 130 : 155, top, bottom);
        const glyph = row.querySelector('svg');
        if (index === 11 && glyphOutside) glyph.style.transform = 'translateX(-22px)';
        rectangle(glyph, index === 11 && glyphOutside ? -6 : 16,
          index === 11 && glyphOutside ? 8 : 30, top, bottom);
      });
    });
  }

  test('Q19 serialized probe rejects a real label truncated before its number', () => {
    expect(workspaceLabelVerdict(workspaceProbe()).pass).toBe(true);
    const damaged = workspaceProbe({ truncated: true });
    expect(damaged.rows[11].ellipsized).toBe(true);
    expect(workspaceLabelVerdict(damaged).failures)
      .toContain('Q19 "Earlier workspace 12" ellipsizes away its trailing number');
    expect(workspaceLabelVerdict({ ...damaged, rows: damaged.rows.map(row =>
      ({ ...row, ellipsized: false })) }).pass).toBe(true);
  });

  test('Q19 font13 and font24 reject a hidden number and accept its restoration', () => {
    for (const fontSize of [13, 24]) {
      const valid = workspaceProbe({ fontSize });
      expect(valid.fontSize).toBe(`${fontSize}px`);
      expect(valid.persistedFontSize).toBe(fontSize === 24 ? '24' : null);
      expect(workspaceLabelVerdict(valid).pass).toBe(true);
      const damaged = workspaceProbe({ fontSize, hiddenTail: true });
      expect(damaged.rows[11].accessibleName).toBe('Earlier workspace 12');
      expect(damaged.rows[11].ellipsized).toBe(false);
      const output = workspaceLabelVerdict(damaged);
      expect(output.failures).toContain('Q19 "Earlier workspace 12" tail is not fully visible');
      console.log(`Q19 font${fontSize} tail control: ${output.failures.join('; ')}`);
    }
  });

  test('Q19 serialized probe rejects a collapsed space before the number', () => {
    const valid = workspaceProbe();
    const spaced = { ...valid, rows: valid.rows.map(row => ({ ...row, tailSeparatorWidth: 3.6 })) };
    expect(workspaceLabelVerdict(spaced).pass).toBe(true);
    const collapsed = { ...valid, rows: valid.rows.map(row => ({ ...row, tailSeparatorWidth: 0 })) };
    const output = workspaceLabelVerdict(collapsed);
    expect(output.failures).toContain('Q19 "Earlier workspace 12" loses the space before its number');
    console.log(`Q19 collapsed-space control: ${output.failures.length} failures`);
  });

  test('Q19 serialized probe rejects a folder glyph translated past the drawer edge', () => {
    const valid = workspaceProbe();
    expect(workspaceLabelVerdict(valid).pass).toBe(true);
    const damaged = workspaceProbe({ glyphOutside: true });
    expect(damaged.drawerLeft).toBe(0);
    expect(damaged.rows[11].glyph.left).toBe(-6);
    const output = workspaceLabelVerdict(damaged);
    expect(output.failures).toContain('Q19 "Earlier workspace 12" folder glyph outside content box or 4px left gutter');
    console.log(`Q19 glyph -6px control: ${output.failures.join('; ')}`);
  });

  test('Q25 rejects the 68px head floor despite an untruncated 65.9px word', () => {
    const names = ['omo-desktop-app', 'ai-token-monitor', 'omo-zcode-oauth', 'Earlier workspace 12'];
    const measure = spare => serialized(probeWorkspaceContinuity,
      `<div class="th-sidebar-body">${names.map(name =>
        `<div class="th-tree-workspace"><div class="th-tree-node">
          <button class="th-tree-activation"><span class="th-tree-label-text"><span class="th-tree-label-head">${name.slice(0, -5)}</span><span class="th-tree-label-tail">${name.slice(-5)}</span></span></button>
        </div></div>`).join('')}</div>`, (window, document) => {
        const bounds = (element, left, right, top, bottom) => {
          element.getBoundingClientRect = () => ({
            left, right, top, bottom, width: right - left, height: bottom - top,
            toJSON() { return this; },
          });
        };
        bounds(document.querySelector('.th-sidebar-body'), 0, 264, 0, 500);
        document.querySelectorAll('.th-tree-node').forEach((row, index) => {
          const top = index * 40, head = row.querySelector('.th-tree-label-head');
          const tail = row.querySelector('.th-tree-label-tail');
          bounds(row, 0, 264, top, top + 30);
          bounds(head, 20, 85.9 + (index === 0 ? spare : 0), top, top + 20);
          bounds(tail, 85.9 + (index === 0 ? spare : 0), 110 + (index === 0 ? spare : 0), top, top + 20);
          bounds(row.querySelector('.th-tree-label-text'), 20, 150, top, top + 20);
          Object.defineProperties(head, {
            clientWidth: { value: index === 3 ? 40 : 68 },
            scrollWidth: { value: index === 3 ? 80 : 68 },
          });
        });
        window.Range.prototype.getBoundingClientRect = function () {
          const top = this.startContainer.parentElement.getBoundingClientRect().top;
          return { left: 20, right: 85.9, top, bottom: top + 20, width: 65.9,
            height: 20, toJSON() { return this; } };
        };
      });
    expect(workspaceContinuityVerdict(measure(0)).pass).toBe(true);
    const output = workspaceContinuityVerdict(measure(2.1));
    expect(output.failures).toContain(
      'Q25 "omo-desktop-app" head/tail gap or spare width 0.0/2.1px');
    console.log(`Q25 68px/65.9px head control: ${output.failures.join('; ')}`);
  });

  test('Q26 rejects a running workspace chevron shifted left by 34px', () => {
    const measure = shift => serialized(probeWorkspaceColumns,
      `<div class="th-sidebar-body">${['Idle', 'Running'].map((name, index) =>
        `<div class="th-tree-workspace"><div class="th-tree-node">
          <button class="th-tree-workspace-activation"><span class="th-tree-label-text">${name}</span>
            <span class="th-tree-chevron"></span></button>
          <span class="th-tree-count${index ? ' th-tree-count--running' : ''}">1</span>
        </div></div>`).join('')}</div>`, (_window, document) => {
        const bounds = (element, left, right, top, bottom) => {
          element.getBoundingClientRect = () => ({
            left, right, top, bottom, width: right - left, height: bottom - top,
            toJSON() { return this; },
          });
        };
        bounds(document.querySelector('.th-sidebar-body'), 0, 264, 0, 500);
        document.querySelectorAll('.th-tree-node').forEach((row, index) => {
          const offset = index ? shift : 0;
          bounds(row, 0, 264, index * 40, index * 40 + 30);
          bounds(row.querySelector('.th-tree-count'), 204 - offset, 224 - offset, index * 40, index * 40 + 20);
          bounds(row.querySelector('.th-tree-chevron'), 170 - offset, 182 - offset, index * 40, index * 40 + 20);
        });
      });
    expect(workspaceColumnsVerdict(measure(0)).pass).toBe(true);
    const output = workspaceColumnsVerdict(measure(34));
    expect(output.failures).toContain('Q26 count right edges drift: 224,190');
    expect(output.failures).toContain('Q26 chevron left edges drift: 170,136');
    const hidden = measure(0).map(row => ({ ...row,
      count: { ...row.count, width: 0, height: 0 } }));
    expect(workspaceColumnsVerdict(hidden).failures)
      .toContain('Q26 visible count pill or chevron box missing');
    console.log(`Q26 running-row -34px control: ${output.failures.join('; ')}`);
  });

  function headingCount({ spinner = true, duration = 700, headingRight = 247, reduced = false } = {}) {
    const pillStyle = 'color:rgb(157, 144, 248);background-color:rgba(139, 124, 246, 0.12)';
    const dot = '<span class="th-overview-card-running-dot" style="width:8px;height:8px;'
      + 'opacity:1;visibility:visible;background-color:rgb(139, 124, 246)"></span>';
    return serialized(probeHeadingRunningCount, `<div class="th-sidebar-live">
      <div class="th-sidebar-live-label">Sessions
        <span class="th-sidebar-live-count" aria-label="2 running" style="${pillStyle}">
          ${spinner ? dot : ''}2</span>
      </div>
      <div class="th-sidebar-live-list"><div class="th-overview-card">
        <span class="th-overview-card-running" style="${pillStyle}">${dot}2</span>
      </div></div></div>`, (window, document) => {
      window.matchMedia = query => ({ matches: reduced && query.includes('prefers-reduced-motion') });
      const box = right => ({ left: right - 20, right, top: 0, bottom: 20,
        width: 20, height: 20, toJSON() { return this; } });
      document.querySelector('.th-sidebar-live-count').getBoundingClientRect = () => box(headingRight);
      document.querySelector('.th-overview-card-running').getBoundingClientRect = () => box(247);
      document.querySelectorAll('.th-overview-card-running-dot').forEach(marker => {
        marker.getBoundingClientRect = () => box(8);
        marker.getAnimations = () => reduced ? [] : [{
          effect: { getComputedTiming: () => ({ duration }) },
        }];
      });
    });
  }

  test('Q27 rejects a bare heading count without a spinner child', () => {
    expect(headingRunningCountVerdict(headingCount()).failures).toEqual([]);
    const output = headingRunningCountVerdict(headingCount({ spinner: false }));
    expect(output.failures).toContain('Q27 heading pill has no visible spinner marker');
    console.log(`Q27 bare number control: ${output.failures.join('; ')}`);
  });

  test('Q27 rejects a spinner whose period is 1280ms', () => {
    const output = headingRunningCountVerdict(headingCount({ duration: 1280 }));
    expect(output.failures).toContain(
      'Q27 heading spinner must animate in <=800ms or remain static under reduced motion');
    expect(headingRunningCountVerdict(headingCount({ reduced: true })).failures).toEqual([]);
    console.log(`Q27 slow spinner control: ${output.failures.join('; ')}`);
  });

  test('Q27 rejects a heading pill six pixels left of the card chips', () => {
    const output = headingRunningCountVerdict(headingCount({ headingRight: 241 }));
    expect(output.failures).toContain('Q27 heading/card chip right edges drift: 241,247');
    console.log(`Q27 right-edge -6px control: ${output.failures.join('; ')}`);
  });

  test('Q6 dim uppercase headings and metadata fail contrast/hierarchy', () => {
    const data = serialized(probeHeadings, `<div class="th-sidebar-section-label"
      style="color:#444;font-weight:400;text-transform:uppercase">Sessions</div>
      <div class="th-chat-pane"><span class="th-chat-status-label" style="color:#444">Context</span></div>`);
    const result = headingVerdict(data);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('hierarchy'))).toBe(true);
  });

  test('Q6 a faint 400-weight settings label fails beside its stronger row', () => {
    const keys = ['settings.language', 'settings.theme', 'settings.font', 'settings.fontSize'];
    const sections = keys.map((key, index) => `<div class="th-settings-section">
      <span class="th-settings-label" style="color:${index === 0 ? '#999' : '#fff'};
        font-weight:${index === 0 ? 400 : 600}">${english[key]}</span>
      <button class="th-settings-seg-btn--on" style="color:#ddd;font-weight:510">EN</button>
    </div>`).join('');
    const facts = serialized(probeHeadings, `<div class="th-settings-panel"
      style="background:#222">${sections}</div>`);
    expect(facts.settingsSections).toHaveLength(4);
    expect(facts.settingsSections[0].row.text).toBe('EN');
    const failures = headingVerdict(facts, ['settings']).failures;
    expect(failures).toContain(`Q6 settings "${english['settings.language']}" hierarchy`);
    expect(failures).toContain(`Q6 settings "${english['settings.language']}" quieter than its row`);
    const stronger = serialized(probeHeadings, `<div class="th-settings-panel"
      style="background:#222">${sections.replace('color:#999', 'color:#fff').replace('font-weight:400', 'font-weight:600')}</div>`);
    expect(headingVerdict(stronger, ['settings']).failures.filter(reason =>
      reason.startsWith('Q6 settings '))).toEqual([]);
  });

  test('Q7 fine pointer hidden actions and coarse overflow with undersized target fail', () => {
    const data = serialized(probeActionSurface, `<div class="th-tree-workspace"><div class="th-tree-node">
      <span class="th-tree-actions th-tree-actions--overflow"><button title="More"></button></span>
      </div></div>`);
    expect(actionVerdict(data, false).pass).toBe(false);
    expect(actionVerdict(data, true).pass).toBe(false);
  });

  test('Q7 an undersized overflow menu fails even if its kebab trigger is 44px', () => {
    const data = serialized(probeActionSurface, `<div class="th-tree-workspace"><div class="th-tree-node">
      <span class="th-tree-actions th-tree-actions--overflow"><button title="More"></button>
        <span class="th-tree-overflow"><button class="th-tree-overflow-item">Rename</button>
          <button class="th-tree-overflow-item">Add</button>
          <button class="th-tree-overflow-item">Delete</button></span></span>
      </div></div>`);
    const facts = { ...data, buttons: [{ ...data.buttons[0], width: 44, height: 44 }],
      menu: data.menu.map(item => ({ ...item, width: 32, height: 32 })) };
    expect(actionVerdict(facts, true).pass).toBe(true);
    expect(actionVerdict(facts, true, true).failures)
      .toContain('Q7 coarse overflow actions need three visible 44px targets');
  });

  test('Q7 a closed kebab fails; three visible, named 44px action buttons pass', () => {
    const buttons = `<button class="th-tree-overflow-item">Rename</button>
      <button class="th-tree-overflow-item">Add</button>
      <button class="th-tree-overflow-item th-tree-overflow-item--danger">Delete</button>`;
    const markup = menu => `<div class="th-tree-workspace"><div class="th-tree-node">
      <span class="th-tree-actions th-tree-actions--overflow"><button title="More"></button>
        ${menu ? `<span class="th-tree-overflow">${buttons}</span>` : ''}</span></div></div>`;
    const size = (_window, document) => {
      for (const el of document.querySelectorAll('.th-tree-actions--overflow > button, .th-tree-overflow-item'))
        el.getBoundingClientRect = () => ({
          left: 0, right: 48, top: 0, bottom: 48, width: 48, height: 48, toJSON() { return this; },
        });
    };
    const closed = serialized(probeActionSurface, markup(false), size);
    expect(actionVerdict(closed, true).pass).toBe(true);
    expect(actionVerdict(closed, true, true).failures)
      .toContain('Q7 coarse overflow actions need three visible 44px targets');
    const open = serialized(probeActionSurface, markup(true), size);
    expect(open.menu.map(item => item.text)).toEqual(['Rename', 'Add', 'Delete']);
    expect(actionVerdict(open, true, true).pass).toBe(true);
  });

  test('Q8 translucent picker and indistinct selected rows fail', () => {
    const data = serialized(probeOverlayEmphasis, `<div class="th-model-picker-popover"
      style="background:rgba(30,30,30,.72)"><div class="th-model-picker-list">
      <button aria-selected="true" style="background:#333">Selected</button>
      <button style="background:#333">Other</button></div></div>
      <div class="th-activity-tabs" style="background:#333"><span class="th-activity-tab-thumb"
        style="background:#333"></span><button role="tab" aria-pressed="true">Todo</button>
      <button role="tab">DAG</button></div>`);
    const result = overlayVerdict(data, ['picker', 'models', 'segments']);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('translucent'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('1.3'))).toBe(true);
  });

  test('Q8 a raised thumb on the wrong segment and missing named actions fail', () => {
    const data = serialized(probeOverlayEmphasis, `<div class="th-activity-tabs" style="background:#25262b">
      <span class="th-activity-tab-thumb" style="background:#777"></span>
      <button aria-selected="true">Todo</button><button aria-selected="false">DAG</button></div>
      <div class="th-wizard-foot"><button class="th-btn th-btn--ghost" style="background:#444">Cancel</button></div>`,
    (_window, document) => {
      document.querySelector('.th-activity-tab-thumb').getBoundingClientRect = () => ({
        left: 120, right: 180, width: 60, top: 0, bottom: 30, height: 30, toJSON() { return this; },
      });
      document.querySelector('[aria-selected="true"]').getBoundingClientRect = () => ({
        left: 0, right: 100, width: 100, top: 0, bottom: 30, height: 30, toJSON() { return this; },
      });
    });
    const facts = { ...data, tokens: { ...data.tokens, ...tokens, '--th-surface-overlay': '#25262b' } };
    expect(overlayVerdict(facts, ['segments'], ['cancel', 'next']).failures.join(' '))
      .toContain('thumb not under active label');
    expect(overlayVerdict(facts, ['segments'], ['cancel', 'next']).failures)
      .toContain('Q8 next action absent');
  });

  test('Q9 flat queue, stats, wizard, login, bubble, shelf and progress fail', () => {
    const html = ['queue-row', 'stats-row', 'wizard-step', 'login-card',
      'chat-msg--user', 'activity-shelf', 'activity-agent-progress']
      .map(name => `<div class="th-${name}" style="background:#1d1e22;border:0"></div>`).join('');
    const data = serialized(probeSecondary, html);
    expect(Object.values(data.groups).every(rows => rows.length > 0)).toBe(true);
    const result = secondaryVerdict(data, ['queue', 'stats', 'wizard', 'login', 'user', 'shelf', 'agents']);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('user bubble misses dedicated fill/shadow'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('boundary'))).toBe(true);
  });

  test('Q9 a nearly transparent border does not count as a separated row', () => {
    const data = serialized(probeSecondary, `<div class="th-queue-row"
      style="background:#17181b;border:1px solid rgba(255,255,255,.025)">Queue</div>`);
    expect(secondaryVerdict({ ...data, surfaceBorder: 'rgba(255,255,255,.06)' }, ['queue']).failures)
      .toContain('Q9 queue boundary below 1.3:1');
  });

  test('Q9 a translucent stats modal with competing behind-text fails', () => {
    const html = `<span class="th-sidebar-section-label" style="color:#fff">Sessions</span>
      <div class="th-modal-overlay"><div class="th-modal-backdrop" style="background:rgba(0,0,0,.01)"></div>
        <div class="th-modal" style="background:rgba(37,38,43,.4)">
          <div class="th-stats"><div class="th-stats-row" style="border-top:1px solid #555">CPU</div></div>
        </div></div>`;
    const patch = (_window, document) => {
      for (const [selector, box] of [
        ['.th-modal', { left: 0, right: 300, top: 0, bottom: 500 }],
        ['.th-sidebar-section-label', { left: 10, right: 100, top: 20, bottom: 40 }],
      ]) document.querySelector(selector).getBoundingClientRect = () =>
        ({ ...box, width: box.right - box.left, height: box.bottom - box.top, toJSON() { return this; } });
    };
    const translucent = secondaryVerdict(serialized(probeSecondary, html, patch), ['stats']);
    expect(translucent.failures.some(reason => reason.includes('stats modal is translucent'))).toBe(true);
    const opaque = secondaryVerdict(serialized(probeSecondary, html.replace('43,.4', '43,1'), patch), ['stats']);
    expect(opaque.failures.some(reason => reason.includes('stats modal is translucent'))).toBe(false);
  });

  test('Q10 offscreen chooser and button fail without scrolling', () => {
    const data = serialized(probeEmptyPane, `<div class="th-pane-wrap"><div class="th-picker-pane">
      <div class="th-picker-pane-list">A</div><div class="th-picker-pane-create">
      <button>New chat session</button></div></div></div>`,
    (_window, document) => {
      const geometry = {
        '.th-pane-wrap': [0, 240], '.th-picker-pane-list': [300, 360], button: [370, 410],
      };
      for (const [selector, [top, bottom]] of Object.entries(geometry))
        document.querySelector(selector).getBoundingClientRect = () =>
          ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, toJSON() { return this; } });
    });
    expect(emptyVerdict(data).failures).toContain('Q10 split chooser or New chat session below fold');
  });

  test('Q10 responsive single-chat proof alone cannot pass the split-layout gate', () => {
    const responsive = serialized(probeSplitApplicability, '<section class="th-chat-pane"></section>');
    expect(responsive).toMatchObject({
      splitCount: 0, mountedPanes: 0, mountedPickers: 0, visibleChats: 1,
    });
    expect(emptyVerdict(serialized(probeEmptyPane, '<section class="th-chat-pane"></section>')).pass).toBe(false);
  });

  test('Q10 actual single-pane chooser and create action must be visible without scrolling', () => {
    const html = `<main class="th-empty"><div class="th-picker-pane">
      <div class="th-picker-pane-list">Sessions</div><div class="th-picker-pane-create">
      <button>New chat session</button></div></div></main>`;
    const measure = bottom => serialized(probeEmptyPane, html, (_window, document) => {
      const geometry = {
        '.th-empty': [0, 500], '.th-picker-pane-list': [240, 380], button: [400, bottom],
      };
      for (const [selector, [top, edge]] of Object.entries(geometry))
        document.querySelector(selector).getBoundingClientRect = () =>
          ({ top, bottom: edge, left: 0, right: 390, width: 390, height: edge - top,
            toJSON() { return this; } });
      const pane = document.querySelector('.th-empty');
      Object.defineProperties(pane, {
        scrollHeight: { value: 500 }, clientHeight: { value: 500 },
      });
    });
    expect(emptyVerdict(measure(450), 'single').pass).toBe(true);
    expect(emptyVerdict(measure(540), 'single').failures)
      .toContain('Q10 single chooser or New chat session below fold');
    expect(emptyVerdict(measure(450), 'split').pass).toBe(false);
  });

  test('Q14 two visible tall nodes and reversed chain fail', () => {
    const data = serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><rect class="th-activity-gnode-card"></rect><text class="th-activity-gstate">Complete</text></g>
      <g data-node="k1"><rect class="th-activity-gnode-card"></rect><text class="th-activity-gstate">Complete</text></g>
      </svg></div>`, (_window, document) => {
      const reel = document.querySelector('.th-activity-graph');
      Object.defineProperties(reel, { scrollHeight: { value: 900 }, clientHeight: { value: 400 } });
    });
    const result = mobileDagVerdict(data, 80);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('whole mobile'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('wraps or reverses'))).toBe(true);
  });

  test('Q24 rejects a compact node with zero top padding and a larger internal gap', () => {
    const measure = (titleTop, titleBottom, stateTop, stateBottom, cardBottom = 370.5) =>
      serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
        <g data-node="k0"><rect class="th-activity-gnode-card"></rect>
          <text class="th-activity-glabel">Title</text><text class="th-activity-gstate">completed</text>
        </g></svg></div>`, (_window, document) => {
        for (const [selector, top, bottom] of [
          ['rect', 332.5, cardBottom], ['.th-activity-glabel', titleTop, titleBottom],
          ['.th-activity-gstate', stateTop, stateBottom],
        ]) document.querySelector(selector).getBoundingClientRect = () => ({
          left: 0, right: 100, top, bottom, width: 100, height: bottom - top,
          toJSON() { return this; },
        });
      });
    const good = measure(337.5, 350.5, 351.5, 365.5);
    expect(compactDagPaddingVerdict({ nodes: Array.from({ length: 11 }, (_, index) =>
      ({ ...good.nodes[0], id: `k${index}` })) }, 'mixed').pass).toBe(true);
    const bad = measure(332.5, 345.5, 354.5, 368.5);
    const output = compactDagPaddingVerdict({ nodes: Array.from({ length: 11 }, (_, index) =>
      ({ ...bad.nodes[0], id: `k${index}` })) }, 'mixed');
    expect(output.failures).toContain('Q24 mixed k0 compact node padding top/bottom/gap 0.0/2.0/9.0px');
    const overlapping = measure(337.5, 350.5, 343.5, 357.5, 362.5);
    expect(compactDagPaddingVerdict({ nodes: Array.from({ length: 11 }, (_, index) =>
      ({ ...overlapping.nodes[0], id: `k${index}` })) }, 'mixed').failures)
      .toContain('Q24 mixed k0 compact node padding top/bottom/gap 5.0/5.0/-7.0px');
    console.log(`Q24 0/9/2 compact-node control: ${output.failures[0]}`);
  });

  test('Q14 and Q15 serialized rendered font and vertical ink clipping fail', () => {
    const markup = `<div class="th-activity-graph"><svg><defs>
      <clipPath id="state-clip"><rect x="17" y="0" width="81" height="37"></rect></clipPath>
    </defs><g data-node="k0"><rect class="th-activity-gnode-card"></rect>
      <text class="th-activity-gstate" clip-path="url(#state-clip)" style="font-size:10.2141px">Complete</text>
    </g></svg></div>`;
    const measure = (font, y) => serialized(probeMobileDag, markup, (window, document) => {
      const word = document.querySelector('text');
      word.style.fontSize = `${font}px`;
      word.getComputedTextLength = () => 70;
      word.getBBox = () => ({ x: 17, y, width: 70, height: 25 });
    });
    const small = measure(10.2141, 2);
    expect(small.nodes[0].words[0].fontSize).toBeCloseTo(10.2141, 3);
    expect(mobileDagVerdict(small, 80).failures.join(' ')).toContain('clipped word "Complete"');
    const clipped = measure(20.5704, -10);
    expect(clipped.nodes[0].words[0].clipped).toBe(true);
    expect(mobileDagVerdict(clipped, 80).failures.join(' ')).toContain('clipped word "Complete"');
    expect(measure(11, 2).nodes[0].words[0].clipped).toBe(false);
  });

  test('Q14/Q15 a clipped parent rejects valid reel metrics and local SVG ink', () => {
    const html = `<section class="th-activity-panel"><div class="th-activity-tabpanel"
      data-activity-tabpanel="dag" style="overflow-y:hidden">
      <div class="th-activity-graph" style="overflow-y:hidden"><svg><defs>
        <clipPath id="state-clip"><rect x="17" y="0" width="81" height="120"></rect></clipPath>
      </defs><g data-node="k0"><rect class="th-activity-gnode-card"></rect>
        <text class="th-activity-gstate" clip-path="url(#state-clip)"
          style="font-size:11.1px">completed</text>
      </g></svg></div></div></section>`;
    const measure = parentBottom => serialized(probeMobileDag, html, (_window, document) => {
      const rect = (selector, top, bottom) => {
        document.querySelector(selector).getBoundingClientRect = () => ({
          left: 0, right: 120, top, bottom, width: 120, height: bottom - top,
          toJSON() { return this; },
        });
      };
      rect('.th-activity-panel', 0, 120);
      rect('.th-activity-tabpanel', 0, parentBottom);
      rect('.th-activity-graph', 0, 120);
      rect('.th-activity-gnode-card', 80, 100);
      rect('text', 84, 96);
      for (const selector of ['.th-activity-tabpanel', '.th-activity-graph']) {
        const el = document.querySelector(selector);
        Object.defineProperties(el, {
          scrollHeight: { value: selector === '.th-activity-graph' ? 120 : parentBottom },
          clientHeight: { value: selector === '.th-activity-graph' ? 120 : parentBottom },
        });
      }
      const word = document.querySelector('text');
      word.getComputedTextLength = () => 55;
      word.getBBox = () => ({ x: 17, y: 84, width: 55, height: 12 });
    });
    const valid = measure(120), clipped = measure(90);
    expect(valid.reel.scrollHeight).toBe(valid.reel.clientHeight);
    expect(clipped.reel.scrollHeight).toBe(valid.reel.scrollHeight);
    expect(clipped.reel.clientHeight).toBe(valid.reel.clientHeight);
    expect(clipped.nodes[0].words[0].clipped).toBe(false);
    expect(dagAncestorVerdict(valid).pass).toBe(true);
    expect(dagAncestorVerdict(clipped).failures).toContain(
      'Q14/Q15 mixed k0 card outside reachable ancestor 0.0..90.0');
    expect(mobileDagVerdict(clipped, 150).failures.join(' ')).toContain('outside reachable ancestor');
  });

  test('Q14/Q15 a clip above the panel rejects otherwise valid reel and words', () => {
    const html = `<div class="th-chat-pane" style="overflow-y:hidden"><main class="th-chat-main"
      style="overflow-y:hidden"><div class="th-chat-main-content" style="overflow-y:hidden">
      <div class="th-activity-shelf" style="overflow-y:hidden"><section class="th-activity-panel">
      <div class="th-activity-tabpanel" style="overflow-y:hidden">
      <div class="th-activity-graph" style="overflow-y:hidden"><svg><defs>
        <clipPath id="state-clip"><rect x="0" y="0" width="110" height="120"></rect></clipPath>
      </defs><g data-node="k0"><rect class="th-activity-gnode-card"></rect>
      <text class="th-activity-gstate" clip-path="url(#state-clip)"
        style="font-size:11.1px">completed</text>
      </g></svg></div></div></section></div></div></main></div>`;
    const measure = shelfBottom => serialized(probeMobileDag, html, (_window, document) => {
      const rect = (el, top, bottom) => {
        el.getBoundingClientRect = () => ({
          left: 0, right: 120, top, bottom, width: 120, height: bottom - top,
          toJSON() { return this; },
        });
      };
      for (const selector of ['.th-chat-pane', '.th-chat-main', '.th-chat-main-content',
        '.th-activity-shelf', '.th-activity-panel', '.th-activity-tabpanel', '.th-activity-graph']) {
        const el = document.querySelector(selector);
        const bottom = selector === '.th-activity-shelf' ? shelfBottom : 120;
        rect(el, 0, bottom);
        Object.defineProperties(el, {
          scrollHeight: { value: bottom }, clientHeight: { value: bottom },
        });
      }
      rect(document.querySelector('.th-activity-gnode-card'), 80, 100);
      rect(document.querySelector('text'), 84, 96);
      const word = document.querySelector('text');
      word.getComputedTextLength = () => 55;
      word.getBBox = () => ({ x: 0, y: 84, width: 55, height: 12 });
    });
    const valid = measure(120), clipped = measure(90);
    expect(valid.reel.scrollHeight).toBe(valid.reel.clientHeight);
    expect(clipped.reel.scrollHeight).toBe(clipped.reel.clientHeight);
    expect(clipped.nodes[0].words[0].clipped).toBe(false);
    expect(clipped.ancestors.map(row => row.owner)).toContain('th-chat-main-content');
    expect(clipped.ancestors.map(row => row.owner)).toContain('viewport');
    expect(dagAncestorVerdict(valid).pass).toBe(true);
    const rejected = dagAncestorVerdict(clipped);
    expect(rejected.pass).toBe(false);
    expect(rejected.failures.join(' ')).toContain('k0 card outside reachable ancestor');
    console.log('Q14/Q15 above-panel clip control:', rejected.failures.join('; '));
    console.log('Q14/Q15 restored above-panel control: PASS');
  });

  test('Q14/Q15 scrollport reaches a card below its viewport but hidden parent rejects it', () => {
    const markup = overflow => `<section class="th-activity-panel">
      <div class="th-activity-tabpanel" data-activity-tabpanel="dag" style="overflow-y:${overflow}">
        <div class="th-activity-graph" style="overflow-y:hidden"><svg><defs>
          <clipPath id="state-clip"><rect x="0" y="0" width="110" height="120"></rect></clipPath>
        </defs><g data-node="k0"><rect class="th-activity-gnode-card"></rect>
          <text class="th-activity-gstate" clip-path="url(#state-clip)"
            style="font-size:11px">completed</text>
        </g></svg></div></div></section>`;
    const measure = overflow => serialized(probeMobileDag, markup(overflow), (_window, document) => {
      const tab = document.querySelector('.th-activity-tabpanel');
      const rect = (selector, top, bottom) => {
        document.querySelector(selector).getBoundingClientRect = () => ({
          left: 0, right: 120, top, bottom, width: 120, height: bottom - top,
          toJSON() { return this; },
        });
      };
      rect('.th-activity-panel', 0, 120);
      rect('.th-activity-tabpanel', 0, 60);
      rect('.th-activity-graph', 0, 120);
      const shifted = (selector, top, bottom) => {
        document.querySelector(selector).getBoundingClientRect = () => ({
          left: 0, right: 120, top: top - tab.scrollTop, bottom: bottom - tab.scrollTop,
          width: 120, height: bottom - top, toJSON() { return this; },
        });
      };
      shifted('.th-activity-gnode-card', 80, 100);
      shifted('text', 84, 96);
      for (const selector of ['.th-activity-tabpanel', '.th-activity-graph']) {
        const el = document.querySelector(selector);
        Object.defineProperties(el, {
          scrollHeight: { value: 120 },
          clientHeight: { value: selector === '.th-activity-tabpanel' ? 60 : 120 },
        });
      }
      const word = document.querySelector('text');
      word.getComputedTextLength = () => 55;
      word.getBBox = () => ({ x: 0, y: 84, width: 55, height: 12 });
    }, { scroll: true });
    const scrolling = measure('auto'), hidden = measure('hidden');
    expect(scrolling.nodes[0].card.top).toBe(80);
    expect(scrolling.nodes[0].words[0].clipped).toBe(false);
    expect(scrolling.scrollChecks).toEqual([{ id: 'k0', visible: true }]);
    expect(dagAncestorVerdict(scrolling, 'mixed').pass).toBe(true);
    expect(dagAncestorVerdict(hidden, 'mixed').failures.join(' '))
      .toContain('k0 card outside reachable ancestor');
    expect(hidden.scrollChecks).toEqual([]);
    console.log('Q14/Q15 control: scrollable ancestor PASS; hidden parent FAIL');
  });

  test('Q14/Q15 phone dense graph scrolls to every card but a hidden parent fails', () => {
    const stage = t4StageSpec('dense16');
    const markup = overflow => `<section class="th-activity-panel">
      <div class="th-activity-tabpanel" data-activity-tabpanel="dag" style="overflow-y:${overflow}">
        <div class="th-activity-graph" style="overflow-y:hidden"><svg><defs>
          <clipPath id="word-clip"><rect x="0" y="0" width="110" height="120"></rect></clipPath>
        </defs>${stage.map(node => `<g data-node="${node.id}">
          <rect class="th-activity-gnode-card"></rect>
          <text class="th-activity-glabel" clip-path="url(#word-clip)" style="font-size:11px">${node.label}</text>
          <text class="th-activity-gstate" clip-path="url(#word-clip)" style="font-size:11px">${english[`activity.status.${node.state}`]}</text>
        </g>`).join('')}</svg></div></div></section>`;
    const measure = overflow => serialized(probeMobileDag, markup(overflow), (_window, document) => {
      const tab = document.querySelector('.th-activity-tabpanel');
      const bounds = (el, left, top, width, height, shifted = false) => {
        el.getBoundingClientRect = () => {
          const y = top - (shifted ? tab.scrollTop : 0);
          return { left, right: left + width, top: y, bottom: y + height,
            width, height, toJSON() { return this; } };
        };
      };
      bounds(document.querySelector('.th-activity-panel'), 0, 0, 390, 200);
      bounds(tab, 0, 0, 390, 80);
      bounds(document.querySelector('.th-activity-graph'), 0, 0, 390, 200);
      for (const [index, group] of [...document.querySelectorAll('g[data-node]')].entries()) {
        const left = stage[index].wave * 160;
        const top = 10 + (index % 4) * 40;
        bounds(group.querySelector('rect'), left, top, 110, 38, true);
        bounds(group.querySelector('.th-activity-glabel'), left + 4, top + 4, 100, 12, true);
        bounds(group.querySelector('.th-activity-gstate'), left + 4, top + 22, 100, 12, true);
        for (const word of group.querySelectorAll('text')) {
          word.getComputedTextLength = () => 80;
          word.getBBox = () => ({ x: 0, y: 4, width: 80, height: 12 });
        }
      }
      for (const [el, clientHeight, scrollHeight] of [
        [tab, 80, 200], [document.querySelector('.th-activity-graph'), 200, 200],
      ]) Object.defineProperties(el, {
        clientHeight: { value: clientHeight }, scrollHeight: { value: scrollHeight },
      });
    }, { scroll: true });
    const scrolling = measure('auto'), hidden = measure('hidden');
    expect(scrolling.scrollChecks).toHaveLength(stage.length);
    expect(scrolling.scrollChecks.every(item => item.visible)).toBe(true);
    expect(mobileDagVerdict(scrolling, 80, 'dense16').pass).toBe(true);
    expect(hidden.scrollChecks).toEqual([]);
    const rejected = mobileDagVerdict(hidden, 80, 'dense16');
    expect(rejected.failures).toContain('Q14/Q15 dense16 w0n2 card outside reachable ancestor 0.0..80.0');
    console.log('Q14/Q15 390 dense16 scrollable control: PASS (16/16 cards and words reachable)');
    console.log(`Q14/Q15 390 dense16 hidden-parent control: ${rejected.failures[0]}`);
  });

  test('Q14/Q15 scrolling requires the full card and word to paint after scroll', () => {
    const facts = { panelFound: true, ancestors: [
      { owner: 'th-activity-graph', overflowY: 'hidden', top: 0, bottom: 120, clientHeight: 120, scrollHeight: 120 },
      { owner: 'th-activity-tabpanel', overflowY: 'auto', top: 0, bottom: 60, clientHeight: 60, scrollHeight: 120, scrollTop: 0 },
      { owner: 'th-activity-panel', overflowY: 'hidden', top: 0, bottom: 120, clientHeight: 120, scrollHeight: 120 },
    ], nodes: [{ id: 'k0', card: { top: 80, bottom: 100 }, words: [
      { kind: 'state', box: { top: 84, bottom: 96 } },
    ] }], scrollChecks: [{ id: 'k0', visible: false }] };
    expect(dagAncestorVerdict(facts, 'mixed').failures.join(' '))
      .toContain('k0 not fully painted when scrolled into view');
    expect(mobileDagVerdict({ ...facts, reel: { box: { left: 0, right: 120, top: 0, bottom: 120 } } },
      80).failures.join(' ')).toContain('k0 not fully painted when scrolled into view');
    console.log('Q14/Q15 control: partially painted scrolled card FAIL');
  });

  test('decision 9 rejects phone graph font drift, desktop sub-11px and unscaled List', () => {
    const sample = fontSize => serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><text class="th-activity-glabel" style="font-size:${fontSize}px">Node</text>
      <text class="th-activity-gstate" style="font-size:${fontSize}px">completed</text></g>
      </svg></div>`);
    for (const setting of [13, 14, 24]) {
      expect(dagTypographyVerdict(sample(11), true, setting).pass).toBe(true);
      expect(dagTypographyVerdict(sample(12), true, setting).failures.join(' ')).toContain('not 11px');
      expect(dagTypographyVerdict(sample(10.8), false, setting).failures.join(' ')).toContain('below 11px');
    }
    const list = size => serialized(probeDagListText, `<ul class="th-activity-dagnodes">
      <li><span class="th-activity-dnode-label" style="font-size:${size}px">Node</span>
      <span class="th-activity-dnode-state" style="font-size:${size}px">completed</span></li></ul>`);
    expect(dagListScaleVerdict(list(13), list(24)).pass).toBe(true);
    expect(dagListScaleVerdict(list(13), list(13)).failures.join(' ')).toContain('does not grow');
    console.log('decision 9 control: phone 13/14/24 drift FAIL; desktop sub-11 FAIL; static List FAIL');
  });

  test('decision 9 rejects capped desktop title and fixed state but accepts setting tiers', () => {
    const sample = (title, state) => serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><text class="th-activity-glabel" style="font-size:${title}px">Node</text>
      <text class="th-activity-gstate" style="font-size:${state}px">completed</text></g>
      </svg></div>`);
    const capped = {
      13: sample(11.1423, 11.1), 14: sample(11.9994, 11.1), 24: sample(12, 11.1),
    };
    const scaled = {
      13: sample(11.1423, 11), 14: sample(11.9994, 11), 24: sample(20.5704, 18.8568),
    };
    const rejected = dagGraphScaleVerdict(capped);
    expect(rejected.pass).toBe(false);
    expect(rejected.failures.join(' ')).toContain('desktop title font24');
    expect(rejected.failures.join(' ')).toContain('desktop state font24');
    expect(dagGraphScaleVerdict(scaled).pass).toBe(true);
    console.log('Q14 capped control:', rejected.failures.join('; '));
    console.log('Q14 scaled control: PASS (title 11.1423/11.9994/20.5704; state 11/11/18.8568)');
  });

  test('Q15 clipped tool status and node state are rejected', () => {
    const data = serialized(probeToolEmphasis, `<div class="th-tool" data-tool-call-id="design-running">
      <button class="th-tool-head"><span class="th-tool-status">Runn</span></button></div>`);
    const tool = phoneToolVerdict({ ...data,
      tools: [{ ...data.tools[0], contentRight: 378, expanded: true,
        card: { left: 48, right: 378, top: 0, bottom: 40 },
        body: { left: 50, right: 420, top: 20, bottom: 39 },
        word: { box: { left: 330, right: 370, top: 0, bottom: 20 } } },
      { ...data.tools[0], id: 'design-read', contentRight: 378, expanded: false,
        card: { left: 48, right: 420, top: 40, bottom: 80 },
        word: { box: { left: 380, right: 420, top: 40, bottom: 70 } } }] });
    expect(tool.pass).toBe(false);
    expect(tool.failures.some(reason => reason.includes('expanded body overhangs'))).toBe(true);
    expect(tool.failures.some(reason => reason.includes('reading-column right'))).toBe(true);
    const fitting = { tools: [{ ...tool.measurements.tools[0], expanded: false, contentRight: 378,
      card: { left: 48, right: 378, top: 0, bottom: 40 },
      word: { text: 'Runn', box: { left: 300, right: 350, top: 0, bottom: 20 } } },
    { ...tool.measurements.tools[1], card: { left: 48, right: 378, top: 40, bottom: 80 },
      word: { text: 'Done', box: { left: 300, right: 350, top: 40, bottom: 60 } } }] };
    expect(phoneToolVerdict(fitting).failures.join(' ')).toContain('design-running card/word clipped');
    const graph = serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><rect class="th-activity-gnode-card"></rect>
      <text class="th-activity-gstate" style="font-size:10px;text-overflow:ellipsis">Complete</text></g>
      </svg>`);
    expect(graph.nodes[0].words[0].clientWidth).toBe(0);
    expect(graph.nodes[0].words[0].clipped).toBe(true);
    expect(mobileDagVerdict(graph, 80).pass).toBe(false);
    const shortened = serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><rect class="th-activity-gnode-card"></rect>
        <text class="th-activity-glabel">노드 k0</text>
        <text class="th-activity-gstate" style="font-size:12px">complet</text></g>
      </svg>`);
    expect(mobileDagVerdict(shortened, 80).failures.join(' ')).toContain('title or state word shortened');
  });

  test('Q17 stale virtual history height leaves a visible gap despite a correct toggled card', () => {
    const facts = serialized(probeDisclosureGeometry, `<div class="th-chat-body">
      <div class="th-chat-history" style="height:700px"><div class="th-chat-row" data-index="0">
        <div class="th-chat-thinking"></div><div id="failed"></div>
      </div></div><div class="th-chat-live"><div class="th-chat-record"></div></div>
    </div>`, (_window, document) => {
      const boxes = {
        '.th-chat-body': [0, 500], '.th-chat-history': [0, 700],
        '.th-chat-row': [100, 160], '#failed': [110, 150],
        '.th-chat-live > .th-chat-record': [700, 740],
      };
      for (const [selector, [top, bottom]] of Object.entries(boxes))
        document.querySelector(selector).getBoundingClientRect = () => ({
          top, bottom, left: 0, right: 390, width: 390, height: bottom - top,
          toJSON() { return this; },
        });
    }, { selector: '#failed' });
    const verdict = disclosureVerdict({ target: { top: 110 } }, facts);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.some(reason => reason.includes('virtualizer total'))).toBe(true);
    expect(verdict.failures.some(reason => reason.includes('missing rows'))).toBe(true);
    expect(disclosureVerdict({ target: { top: 100 } }, facts).failures
      .some(reason => reason.includes('toggled record moved'))).toBe(true);
  });
});
