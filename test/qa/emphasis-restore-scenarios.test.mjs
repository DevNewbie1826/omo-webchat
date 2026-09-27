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
import {
  scenarios, probeToolEmphasis, toolVerdict, probeStatusEmphasis, statusVerdict,
  dagVerdict, probeSidebarEmphasis, sidebarVerdict, probeHeadings, headingVerdict,
  probeDagRunningPaint, dagRunningPaintVerdict,
  sidebarStatesVerdict,
  probeActionSurface, actionVerdict, probeOverlayEmphasis, overlayVerdict,
  probeSecondary, secondaryVerdict, probeEmptyPane, probeSplitApplicability, emptyVerdict, probeMobileDag,
  mobileDagVerdict, phoneToolVerdict, probeDisclosureGeometry, disclosureVerdict,
  probeWorkspaceLabels, workspaceLabelVerdict,
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
    const ids = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q14', 'Q15', 'Q17'];
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

  test('Q3 screenshot paint probe rejects the old halo behind a translucent card', async () => {
    const facts = await serialized(probeDagRunningPaint, `<svg><g class="th-activity-gnode th-activity-gnode--running">
      <rect class="th-activity-gnode-card"></rect>
      <text class="th-activity-gstate" style="fill:rgb(157,144,248)">Running</text>
    </g></svg>`, (window, document) => {
      const word = document.querySelector('text');
      word.getBoundingClientRect = () => ({ left: 170, right: 195, top: 580, bottom: 600,
        toJSON() { return this; } });
      document.querySelector('rect').getBoundingClientRect = () => ({ left: 160, right: 250, top: 570, bottom: 620,
        toJSON() { return this; } });
      window.Image = class { width = 390; height = 844; decode() { return Promise.resolve(); } };
      window.HTMLCanvasElement.prototype.getContext = () => ({
        drawImage() {}, getImageData() { return { data: [65, 60, 102, 255] }; },
      });
    }, { png: 'serialized-paint' });
    expect(facts.sample).toEqual({ x: 198, y: 590 });
    expect(dagRunningPaintVerdict([0, 350, 700].map(time => ({ ...facts, time }))).failures)
      .toContain('Q3 running text contrast 3.770:1 at halo 700ms');
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

  test('Q19 serialized probe rejects a real label truncated before its number', () => {
    const markup = `<div class="th-sidebar-body"><div class="th-tree-workspace">
      ${Array.from({ length: 12 }, (_, index) => `<div class="th-tree-node">
        <button class="th-tree-activation"><span class="th-tree-label-text">
          Earlier workspace ${index + 1}</span></button></div>`).join('')}
      </div></div>`;
    const measure = truncated => serialized(probeWorkspaceLabels, markup, (_window, document) => {
      const labels = document.querySelectorAll('.th-tree-label-text');
      labels.forEach((label, index) => {
        Object.defineProperties(label, {
          scrollWidth: { value: index === 11 && truncated ? 160 : 120 },
          clientWidth: { value: index === 11 && truncated ? 64 : 125 },
        });
        label.parentElement.getBoundingClientRect = () => ({
          left: 0, right: 125, top: 0, bottom: 20, width: 125, height: 20,
          toJSON() { return this; },
        });
      });
    });
    expect(workspaceLabelVerdict(measure(false)).pass).toBe(true);
    const damaged = measure(true);
    expect(damaged.rows[11].ellipsized).toBe(true);
    expect(workspaceLabelVerdict(damaged).failures)
      .toContain('Q19 "Earlier workspace 12" ellipsizes away its trailing number');
    expect(workspaceLabelVerdict({ ...damaged, rows: damaged.rows.map(row =>
      ({ ...row, ellipsized: false })) }).pass).toBe(true);
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

  test('Q14 two visible tall nodes, vertical scroll and reversed chain fail', () => {
    const data = serialized(probeMobileDag, `<div class="th-activity-graph"><svg>
      <g data-node="k0"><rect class="th-activity-gnode-card"></rect><text class="th-activity-gstate">Complete</text></g>
      <g data-node="k1"><rect class="th-activity-gnode-card"></rect><text class="th-activity-gstate">Complete</text></g>
      </svg></div>`, (_window, document) => {
      const reel = document.querySelector('.th-activity-graph');
      Object.defineProperties(reel, { scrollHeight: { value: 900 }, clientHeight: { value: 400 } });
    });
    const result = mobileDagVerdict(data, 80);
    expect(result.pass).toBe(false);
    expect(result.failures.some(reason => reason.includes('scrolls vertically'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('whole mobile'))).toBe(true);
    expect(result.failures.some(reason => reason.includes('wraps or reverses'))).toBe(true);
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
