/** Emphasis-restore QA over the real fixture SPA. Probes are serialized by
 * ctx.probe (pageKit is injected); verdicts deliberately reject missing
 * surfaces, not just incorrectly painted surfaces. */
import { join } from 'node:path';
import english from '../../frontend/src/i18n/locales/en.json' with { type: 'json' };
import {
  t4ActivityFrame, t4CatalogPayload, t4DocumentPayload, t4ExtensionFrames,
  t4StageRoles, t4StageRun, t4StageSpec, nodeStrokeViolations,
  nodeTintVerdict, fulfilledEdgeContrastVerdict, visibleMixedNodesVerdict,
  footerInsidePanelVerdict, probeDagGraph, probeDagRunningMotion,
  dagRunningMotionVerdict, dagReducedMotionVerdict,
} from './visual-redesign-scenarios-t4.mjs';
import { shellLiveFrame } from './visual-redesign-scenarios-t3.mjs';
import { colorEquals, parseColor, contrastRatio, compositeOver } from './visual-redesign-probes.mjs';
import { designSeed, installSignals, output as fixtureOutput, seedLive } from './design-workbench-fixture.mjs';
import { startTaskFixture } from './task-state-fixture.mjs';

const CHAT = 'stored-a';
const errorLine = error => error instanceof Error ? error.message.split('\n')[0] : String(error);
const rect = element => element?.getBoundingClientRect().toJSON() ?? null;
const inside = (a, b) => !!a && !!b && a.left >= b.left - 1 && a.right <= b.right + 1
  && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
const fail = (condition, text, failures) => { if (!condition) failures.push(text); };
const ratio = (front, back) => {
  const a = parseColor(front), b = parseColor(back);
  return a && b ? contrastRatio(a.a < 1 ? compositeOver(a, b) : a, b) : 0;
};
const same = (a, b) => !!parseColor(a) && !!parseColor(b) && colorEquals(parseColor(a), parseColor(b));
const hue = (a, b) => {
  const x = parseColor(a), y = parseColor(b);
  return !!x && !!y && ['r', 'g', 'b'].every(channel => Math.abs(x[channel] - y[channel]) < 2);
};
const finish = (measurements, failures) => ({ pass: failures.length === 0, measurements, failures });

/** A DOM probe runs in isolation: do not reference module-scope helpers here. */
export function probeToolEmphasis() {
  const root = getComputedStyle(document.documentElement);
  const pane = document.querySelector('.th-chat-pane');
  const resolve = name => {
    const node = document.createElement('i');
    node.style.color = `var(${name})`;
    document.body.append(node);
    const value = getComputedStyle(node).color;
    node.remove();
    return value;
  };
  const box = el => el?.getBoundingClientRect().toJSON() ?? null;
  const intersects = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const tools = [...document.querySelectorAll('.th-tool[data-tool-call-id]')].filter(isVisibleElement).map(el => {
    const head = el.querySelector('.th-tool-head'), body = el.querySelector('.th-tool-body');
    const rail = el.querySelector('.th-chat-record-rail');
    const word = el.querySelector('.th-tool-status'), glyph = el.querySelector('.th-tool-glyph');
    const chevron = el.querySelector('.th-tool-chevron');
    const style = getComputedStyle(el), boxRecord = box(el), boxRail = box(rail);
    let backdrop = el.parentElement;
    while (backdrop && parseColor(getComputedStyle(backdrop).backgroundColor)?.a < .999) backdrop = backdrop.parentElement;
    return {
      id: el.dataset.toolCallId, className: el.className, card: boxRecord, head: box(head),
      proseLeft: box(el.closest('.th-chat-row, .th-chat-live'))?.left ?? null,
      contentRight: box(el.closest('.th-chat-row, .th-chat-live'))?.right ?? null,
      body: body && isVisibleElement(body) ? box(body) : null,
      rail: boxRail, background: style.backgroundColor,
      backdrop: backdrop ? getComputedStyle(backdrop).backgroundColor : getComputedStyle(document.body).backgroundColor,
      border: style.borderTopColor, borderWidth: parseFloat(style.borderTopWidth),
      borderStyle: style.borderTopStyle, radius: parseFloat(style.borderTopLeftRadius),
      word: word ? { text: word.textContent.trim(), color: getComputedStyle(word).color,
        background: getComputedStyle(word).backgroundColor, box: box(word) } : null,
      glyph: glyph ? getComputedStyle(glyph).color : null, glyphBox: box(glyph),
      chevron: chevron ? getComputedStyle(chevron).transform : null,
      expanded: head?.getAttribute('aria-expanded') === 'true',
      crossings: [...el.querySelectorAll('.th-tool-name, .th-tool-summary, .th-tool-invocation, .th-tool-preview')]
        .filter(isVisibleElement).filter(text => intersects(box(text), boxRail)).map(text => text.className),
      railCrossesCard: intersects(boxRecord, boxRail),
    };
  });
  const thinking = [...document.querySelectorAll('.th-chat-thinking')].filter(isVisibleElement).map(el => {
    const rail = box(el.querySelector('.th-chat-record-rail'));
    const pre = el.querySelector('.th-chat-thinking-body pre');
    return {
      live: !!el.closest('.th-chat-live'), rail,
      proseLeft: box(el.closest('.th-chat-row, .th-chat-live'))?.left ?? null,
      dot: box(el.querySelector('.th-chat-thinking-dot')),
      label: box(el.querySelector('.th-chat-thinking-label')),
      bodyText: pre && isVisibleElement(pre) ? box(pre) : null,
      textCrossings: [...el.querySelectorAll('.th-chat-thinking-label, .th-chat-thinking-body pre')]
        .filter(isVisibleElement).filter(text => intersects(box(text), rail)).map(text => text.className),
      font: pre ? getComputedStyle(pre).fontFamily : null,
    };
  });
  const spacing = tools.slice(1).map((item, index) => ({
    previous: tools[index].id, next: item.id, gap: item.card.top - tools[index].card.bottom,
  })).filter(item => item.previous !== item.next);
  return { pane: pane ? getComputedStyle(pane).backgroundColor : null,
    mono: root.getPropertyValue('--th-font-mono').trim(),
    tokens: Object.fromEntries(['--th-success', '--th-error', '--th-accent', '--th-accent-ink',
      '--th-tool-record-border'].map(name => [name, resolve(name)])),
    tools, thinking, spacing };
}

export function toolVerdict(facts, required = ['design-read', 'design-failed', 'design-running']) {
  const failures = [], byId = new Map((facts.tools ?? []).map(record => [record.id, record]));
  for (const id of required) fail(byId.has(id), `Q1 missing ${id} tool record`, failures);
  for (const item of facts.tools ?? []) {
    const token = /failed|error/.test(item.id) ? '--th-error'
      : /running/.test(item.id) ? '--th-accent' : '--th-success';
    fail(item.card && item.head && inside(item.head, item.card) && (!item.body || inside(item.body, item.card)),
      `Q1 ${item.id} header/body detached from card`, failures);
    fail(item.radius >= 8 && item.borderStyle === 'solid' && item.borderWidth >= .95 && item.borderWidth <= 1.05
      && ratio(item.background, facts.pane) > 1 && !hue(item.border, facts.tokens[token]),
    `Q1 ${item.id} card tint/hairline/radius`, failures);
    const cardFill = compositeOver(parseColor(item.background), parseColor(item.backdrop ?? facts.pane));
    const wordFill = item.word && cardFill && compositeOver(parseColor(item.word.background), cardFill);
    fail(item.word && hue(item.word.color, facts.tokens[token === '--th-accent' ? '--th-accent-ink' : token])
      && hue(item.glyph, facts.tokens[token]) && wordFill
      && contrastRatio(parseColor(item.word.color), wordFill) >= 4.5,
    `Q1 ${item.id} glyph/word contrast or hue`, failures);
    fail(item.rail && !item.railCrossesCard && item.crossings.length === 0,
      `Q1 ${item.id} rail intersects card or invocation`, failures);
    fail(item.proseLeft !== null && Math.abs(item.card.left - item.proseLeft - 24) <= 1,
      `Q1 ${item.id} indent ${item.proseLeft === null ? 'unknown' : (item.card.left - item.proseLeft).toFixed(1)}px != 24px`, failures);
    fail(item.glyphBox && item.rail &&
      Math.abs((item.glyphBox.left + item.glyphBox.right - item.rail.left - item.rail.right) / 2) <= 1 &&
      item.glyphBox.right < item.card.left,
    `Q1 ${item.id} glyph not centered on gutter rail outside card`, failures);
    // matrix(a,b,c,d,e,f): a=0,b=1 -> down; a=1,b=0 -> right.
    const matrix = /matrix\(([-.\d]+),\s*([-.\d]+)/.exec(item.chevron ?? '');
    fail(item.expanded ? !!matrix && Math.abs(Number(matrix[2])) > .7
      : item.chevron === 'none' || !!matrix && Math.abs(Number(matrix[1])) > .7,
      `Q1 ${item.id} chevron direction`, failures);
  }
  if (required.length >= 2) fail(facts.spacing?.length > 0, 'Q1 no consecutive cards to check', failures);
  for (const pair of facts.spacing ?? [])
    fail(pair.gap > .5, `Q1 ${pair.previous}/${pair.next} cards touch or overlap (${pair.gap}px)`, failures);
  fail((facts.thinking ?? []).some(row => !row.live) && (facts.thinking ?? []).some(row => row.live),
    'Q1 missing historical or live thinking', failures);
  for (const item of facts.thinking ?? []) {
    fail(item.rail && item.textCrossings.length === 0, 'Q1 thinking text intersects rail', failures);
    fail(item.proseLeft !== null && item.rail && item.dot && item.label &&
      Math.abs((item.rail.left + item.rail.right) / 2 - item.proseLeft - 12) <= 1 &&
      Math.abs((item.dot.left + item.dot.right - item.rail.left - item.rail.right) / 2) <= 1 &&
      Math.abs(item.label.left - item.proseLeft - 24) <= 3 &&
      (!item.bodyText || Math.abs(item.bodyText.left - item.proseLeft - 24) <= 1),
    'Q1 thinking glyph, label or body leaves 24px gutter geometry', failures);
    if (item.font) fail(item.font === facts.mono, 'Q1 thinking pre is not app mono', failures);
  }
  return finish(facts, failures);
}

export function probeStatusEmphasis() {
  const tokens = {}, node = document.createElement('i');
  document.body.append(node);
  for (const name of ['--th-accent', '--th-accent-ink', '--th-success', '--th-error',
    '--th-accent-bg', '--th-success-bg', '--th-error-bg', '--th-active']) {
    node.style.color = `var(${name})`;
    tokens[name] = getComputedStyle(node).color;
  }
  node.remove();
  const pick = (selector, owner) => [...document.querySelectorAll(selector)].filter(isVisibleElement)
    .map(el => {
      let backdrop = el.parentElement;
      while (backdrop && parseColor(getComputedStyle(backdrop).backgroundColor)?.a < .999) backdrop = backdrop.parentElement;
      return { owner, cls: el.className?.baseVal ?? el.className,
        text: el.textContent.trim().slice(0, 55), color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
        backdrop: backdrop ? getComputedStyle(backdrop).backgroundColor : getComputedStyle(document.body).backgroundColor };
    });
  return { tokens, rows: [
    ...pick('.th-goal-bar .th-activity-chip', 'goal'),
    ...pick('.th-activity-todo-task .th-activity-chip', 'todo'),
    ...pick('.th-activity-agent .th-activity-chip, .th-activity-agents .th-activity-chip', 'agents'),
    ...pick('.th-activity-dagnodes .th-activity-dnode-state', 'dag-list'),
    ...pick('.th-activity-dag-head .th-activity-chip', 'dag-head'),
  ] };
}

export function statusVerdict(facts, required = ['goal', 'todo', 'agents', 'dag-list'], states = ['success', 'error', 'accent']) {
  const failures = [], rows = facts.rows ?? [], tokens = facts.tokens ?? {};
  for (const owner of required) fail(rows.some(row => row.owner === owner), `Q2 missing ${owner} chips`, failures);
  const kindOf = row => /(?:--ok|complete)/i.test(`${row.cls} ${row.text}`) ? 'success'
    : /(?:--error|fail|block)/i.test(`${row.cls} ${row.text}`) ? 'error'
      : /(?:--running|active)/i.test(`${row.cls} ${row.text}`) ? 'accent' : null;
  for (const row of rows) {
    const kind = kindOf(row);
    if (!kind) continue;
    const ink = kind === 'accent' ? tokens['--th-accent-ink'] : tokens[`--th-${kind}`];
    const fill = compositeOver(parseColor(row.background), parseColor(row.backdrop));
    fail(hue(row.color, ink) && hue(row.background, tokens[`--th-${kind}-bg`])
      && !hue(row.background, tokens['--th-active']) && fill
      && contrastRatio(parseColor(row.color), fill) >= 4.5,
    `Q2 ${row.owner} ${kind} chip tint/ink/contrast`, failures);
  }
  for (const kind of states)
    fail(rows.some(row => required.includes(row.owner) && kindOf(row) === kind),
      `Q2 ${kind} state not seeded`, failures);
  return finish(facts, failures);
}

export function probeSidebarEmphasis() {
  const box = el => el?.getBoundingClientRect().toJSON() ?? null;
  const style = el => el ? getComputedStyle(el) : null;
  const row = (selector, owner) => [...document.querySelectorAll(selector)].filter(isVisibleElement)
    .map(el => { const textBox = el.classList.contains('th-sidebar-live-label') && el.firstChild?.nodeType === Node.TEXT_NODE
      ? (() => { const range = document.createRange(); range.selectNodeContents(el.firstChild); return range.getBoundingClientRect().toJSON(); })()
      : box(el);
      return { owner, text: el.textContent.trim(), box: textBox, color: style(el).color,
      background: style(el).backgroundColor, weight: Number(style(el).fontWeight),
      paddingLeft: parseFloat(style(el).paddingLeft) || 0,
      animation: el.getAnimations({ subtree: true }).map(a => a.effect?.getComputedTiming()?.duration ?? 0),
      accessible: el.getAttribute('aria-label') }; });
  const treeRows = [...document.querySelectorAll('.th-tree-workspace')].flatMap((workspace, workspaceIndex) =>
    [...workspace.querySelectorAll('.th-tree-node')].filter(isVisibleElement).map(el => {
      let depth = 0;
      for (let parent = el.parentElement; parent && parent !== workspace; parent = parent.parentElement)
        if (parent.classList.contains('th-tree-children')) depth++;
      const leading = el.querySelector(':scope > .th-tree-chevron, :scope > .th-tree-placed');
      const label = el.querySelector(':scope > .th-tree-activation .th-tree-label-text, :scope > .th-tree-activation .th-tree-label');
      return { workspace: workspaceIndex, depth, leading: box(leading), label: box(label),
        text: label?.textContent.trim() ?? null };
    }));
  return {
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    liveHeading: row('.th-sidebar-live-label', 'heading'),
    headingBadges: row('.th-sidebar-live-count', 'heading-badge'),
    cards: row('.th-sidebar-live-list .th-overview-card-name', 'card'),
    cardBadges: row('.th-sidebar-live-list .th-overview-card-running', 'card-badge'),
    treeRows,
    treeBadges: row('.th-tree-workspace > .th-tree-node .th-tree-running--workspace', 'tree-badge'),
    running: row('.th-sidebar-live-list .th-overview-card-running, .th-tree-running--count', 'running'),
    selected: row('.th-tree [aria-current="true"] .th-tree-label', 'selected'),
    idle: row('.th-tree .th-tree-label:not([aria-current="true"] .th-tree-label)', 'idle'),
    sessionRows: [...document.querySelectorAll('.th-tree-node:has(.th-tree-activation .th-tree-label)')]
      .filter(isVisibleElement).map(el => ({
        label: el.querySelector('.th-tree-activation .th-tree-label')?.textContent.trim(),
        connected: !!el.querySelector('.th-tree-live'),
        running: !!el.querySelector('.th-tree-running'),
        iconColor: getComputedStyle(el.querySelector('.th-tree-icon')).color,
        fill: getComputedStyle(el).backgroundColor,
      })),
    tokens: (() => { const root = getComputedStyle(document.documentElement);
      return { accent: root.getPropertyValue('--th-accent-ink').trim(), weight: root.getPropertyValue('--th-weight-emphasize').trim() };
    })(),
  };
}

export function sidebarVerdict(facts, { cards = 1, geometry = false } = {}) {
  const failures = [];
  if (!geometry) {
    fail(facts.running?.length >= 2, 'Q4 running live-card/tree counts not mounted', failures);
    for (const row of facts.running ?? []) {
      fail(hue(row.color, facts.tokens?.accent) && row.animation.some(ms => ms > 0 && ms <= 800),
        `Q4 ${row.owner} lacks accent text or <=800ms motion`, failures);
    }
    fail(facts.selected?.some(row => row.weight >= Number(facts.tokens?.weight ?? 600)),
      'Q4 selected session lacks emphasize weight', failures);
  }
  if (geometry) {
    fail(facts.cards?.length === cards, `Q5 expected ${cards} live cards`, failures);
    const treeRows = facts.treeRows ?? [];
    const parents = treeRows.filter(row => row.depth === 0);
    const lefts = [...(facts.liveHeading ?? []).map(row => row.box.left),
      ...(facts.cards ?? []).map(row => row.box.left),
      ...parents.map(row => row.leading?.left)];
    const rights = [...(facts.headingBadges ?? []).map(row => row.box.right),
      ...(facts.cardBadges ?? []).map(row => row.box.right),
      ...(facts.treeBadges ?? []).map(row => row.box.right)];
    fail(parents.length > 0 && facts.liveHeading?.length === 1 && lefts.length >= cards + 2
      && lefts.every(Number.isFinite) && Math.max(...lefts) - Math.min(...lefts) <= 1,
      `Q5 left columns drift: ${lefts}`, failures);
    const depths = new Set(treeRows.map(row => row.depth));
    fail(depths.has(1), 'Q5 nested tree labels absent', failures);
    for (const depth of depths) {
      const labels = treeRows.filter(row => row.depth === depth).map(row => row.label?.left);
      fail(labels.length > 0 && labels.every(Number.isFinite)
        && Math.max(...labels) - Math.min(...labels) <= 1,
      `Q5 depth ${depth} tree labels drift: ${labels}`, failures);
    }
    const steps = treeRows.filter(row => row.depth > 0).map(row => {
      const parent = treeRows.find(candidate => candidate.workspace === row.workspace
        && candidate.depth === row.depth - 1);
      return row.leading?.left - parent?.leading?.left;
    });
    fail(steps.length > 0 && steps.every(step => Number.isFinite(step) && step > 0)
      && Math.max(...steps) - Math.min(...steps) <= 1,
    `Q5 tree indentation steps drift: ${steps}`, failures);
    fail(facts.headingBadges?.length === 1 && facts.cardBadges?.length === cards
      && facts.treeBadges?.length > 0 && rights.length >= cards + 2
      && Math.max(...rights) - Math.min(...rights) <= 1,
      `Q5 badge edges drift: ${rights}`, failures);
  }
  return finish(facts, failures);
}

export function sidebarStatesVerdict(running, connected, idle) {
  const failures = [];
  const active = running.sessionRows?.find(row => row.running);
  const connectedRow = connected.sessionRows?.find(row => row.label === 'Newer');
  const idleRow = idle.sessionRows?.find(row => row.label === 'Newer');
  fail(active?.running === true && active?.connected === true, 'Q4 running session lacks connected/running markers', failures);
  fail(connectedRow?.connected === true && connectedRow?.running === false,
    'Q4 connected-but-idle session lacks a distinct presence marker', failures);
  fail(idleRow?.connected === false && idleRow?.running === false
    && connectedRow?.iconColor !== idleRow?.iconColor,
  'Q4 idle and connected session glyphs are visually indistinguishable', failures);
  return finish({ active, connected: connectedRow, idle: idleRow }, failures);
}

/** Q19 (E33): every "Earlier workspace N" row in the drawer must keep its
 * trailing number visible, with the full main-baseline label width. The
 * floor is main's label box for this fixture: drawer 264 - 1 border - 8 body
 * - 2x4 row padding - 44 chevron - 14 icon - 44 kebab - 3x4 gaps = 125px;
 * 124 allows 1px rounding. */
export function probeWorkspaceLabels() {
  const owner = document.querySelector('.th-sidebar-body');
  const ownerBox = owner?.getBoundingClientRect();
  const rows = [];
  for (const row of document.querySelectorAll('.th-tree-workspace > .th-tree-node')) {
    if (!isVisibleElement(row)) continue;
    const label = row.querySelector('.th-tree-label-text');
    const column = row.querySelector('.th-tree-activation');
    if (!label || !column) continue;
    const box = column.getBoundingClientRect();
    if (ownerBox && (box.bottom < ownerBox.top || box.top > ownerBox.bottom)) continue;
    rows.push({ text: label.textContent.trim(), box: box.toJSON(),
      ellipsized: label.scrollWidth > label.clientWidth + 1 });
  }
  return { rows, coarsePointer: window.matchMedia('(pointer: coarse)').matches };
}

export function workspaceLabelVerdict(facts, { minWidth = 124 } = {}) {
  const failures = [];
  const tested = (facts.rows ?? []).filter(row => /Earlier workspace/.test(row.text));
  fail(tested.length >= 12, `Q19 expected 12+ "Earlier workspace N" rows, found ${tested.length}`, failures);
  for (const row of tested) {
    fail(/(\d+)\s*$/.test(row.text), `Q19 row "${row.text}" has no trailing number`, failures);
    fail(row.box && row.box.width >= minWidth,
      `Q19 label box ${row.box ? row.box.width.toFixed(1) : '?'}px < main baseline ${minWidth}px ("${row.text}")`, failures);
    fail(!row.ellipsized, `Q19 "${row.text}" ellipsizes away its trailing number`, failures);
  }
  return finish(facts, failures);
}

export function probeHeadings() {
  const root = getComputedStyle(document.documentElement), pane = document.querySelector('.th-chat-pane');
  const sample = selector => [...document.querySelectorAll(selector)].filter(isVisibleElement)
    .map(el => ({ text: el.textContent.trim().slice(0, 80), color: getComputedStyle(el).color,
      weight: Number(getComputedStyle(el).fontWeight), transform: getComputedStyle(el).textTransform,
      background: getComputedStyle(el.parentElement).backgroundColor }));
  const settingsPaint = el => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color?.a > 0) layers.unshift(color);
    }
    return hexOf(layers.reduce((under, over) => compositeOver(over, under),
      parseColor(root.getPropertyValue('--th-bg').trim())));
  };
  const settingsText = el => el && isVisibleElement(el) ? {
    text: el.textContent.trim().slice(0, 80),
    color: getComputedStyle(el).color,
    weight: Number(getComputedStyle(el).fontWeight),
    transform: getComputedStyle(el).textTransform,
    background: settingsPaint(el),
  } : null;
  const settingsSections = [...document.querySelectorAll('.th-settings-panel .th-settings-section')]
    .filter(isVisibleElement).map(section => ({
      heading: settingsText(section.querySelector('.th-settings-label')),
      row: settingsText(section.querySelector(
        '.th-settings-seg-btn--on, .th-settings-select, .th-settings-size-value')),
    }));
  return { heading: sample('.th-sidebar-section-label, .th-sidebar-live-label, .th-activity-section-title, .th-files-title, .th-settings-label'),
    sidebar: sample('.th-sidebar-section-label, .th-sidebar-live-label'),
    files: sample('.th-files-title'), settings: sample('.th-settings-label'), settingsSections,
    status: sample('.th-chat-status-label, .th-chat-status-num, .th-model-picker-label, .th-followup-badge'),
    context: sample('.th-chat-status-item:has(.th-chat-status-num)'),
    model: sample('.th-model-picker-label'),
    followup: sample('.th-queue-engine-chip'),
    weight: Number(root.getPropertyValue('--th-weight-emphasize').trim()),
    surface: pane ? getComputedStyle(pane).backgroundColor : root.getPropertyValue('--th-bg').trim() };
}

export function headingVerdict(facts, required = ['sidebar']) {
  const failures = [];
  for (const kind of required) fail(facts[kind]?.length > 0, `Q6 ${kind} section heading missing`, failures);
  if (required.includes('settings')) {
    const sections = facts.settingsSections ?? [];
    const expected = ['settings.language', 'settings.theme', 'settings.font', 'settings.fontSize']
      .map(key => english[key]);
    fail(sections.length >= expected.length, 'Q6 settings sections missing', failures);
    for (const label of expected) fail(sections.some(section => section.heading?.text === label),
      `Q6 settings heading "${label}" missing`, failures);
    for (const [index, section] of sections.entries()) {
      const heading = section.heading, row = section.row;
      fail(!!heading && !!row, `Q6 settings section ${index} lacks visible heading or row`, failures);
      if (!heading || !row) continue;
      const headingContrast = ratio(heading.color, heading.background);
      const rowContrast = ratio(row.color, row.background);
      fail(heading.weight >= facts.weight && heading.weight >= row.weight
        && heading.transform !== 'uppercase',
      `Q6 settings "${heading.text}" hierarchy`, failures);
      fail(headingContrast >= 4.5, `Q6 settings "${heading.text}" contrast`, failures);
      fail(headingContrast >= rowContrast,
        `Q6 settings "${heading.text}" quieter than its row`, failures);
    }
  }
  for (const kind of ['heading', 'status']) {
    fail((facts[kind] ?? []).length > 0, `Q6 no ${kind} text mounted`, failures);
    for (const item of facts[kind] ?? []) {
      fail(ratio(item.color, parseColor(item.background)?.a >= 1 ? item.background : facts.surface) >= 4.5,
        `Q6 ${kind} "${item.text}" contrast`, failures);
      if (kind === 'heading') fail(item.weight >= facts.weight && item.transform !== 'uppercase',
        `Q6 heading "${item.text}" hierarchy`, failures);
    }
  }
  for (const kind of ['context', 'model', 'followup']) {
    fail((facts[kind] ?? []).length > 0, `Q6 ${kind} badge/label missing`, failures);
    for (const item of facts[kind] ?? []) fail(
      ratio(item.color, parseColor(item.background)?.a >= 1 ? item.background : facts.surface) >= 4.5,
      `Q6 ${kind} badge/label contrast`, failures);
  }
  return finish(facts, failures);
}

export function probeActionSurface() {
  const row = document.querySelector('.th-tree-workspace > .th-tree-node');
  const controls = [...(row?.querySelectorAll('.th-tree-actions > button') ?? [])];
  return { row: !!row, inline: controls.length, overflow: !!row?.querySelector('.th-tree-actions--overflow'),
    buttons: controls.map(el => ({ title: el.title, visible: isVisibleElement(el),
      width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
    menu: [...(row?.querySelectorAll('.th-tree-overflow-item') ?? [])].map(el => ({
      text: el.textContent.trim(), tag: el.tagName.toLowerCase(),
      danger: el.classList.contains('th-tree-overflow-item--danger'),
      visible: isVisibleElement(el), width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
    })) };
}

export function actionVerdict(facts, coarse, menuOpen = false) {
  const failures = [];
  fail(facts.row, 'Q7 workspace row absent', failures);
  fail(coarse ? facts.overflow && facts.inline === 1 && facts.buttons[0]?.width >= 44
    && facts.buttons[0]?.height >= 44 : !facts.overflow && facts.inline === 3
      && facts.buttons.every(button => button.visible),
  `Q7 ${coarse ? 'coarse overflow' : 'fine inline'} controls missing`, failures);
  if (menuOpen) fail(facts.menu?.length === 3 && facts.menu.every(item =>
    item.tag === 'button' && item.text && item.visible && item.width >= 44 && item.height >= 44)
    && new Set(facts.menu.map(item => item.text)).size === 3 && facts.menu[2].danger,
  'Q7 coarse overflow actions need three visible 44px targets', failures);
  return finish(facts, failures);
}

export function probeOverlayEmphasis() {
  const root = getComputedStyle(document.documentElement);
  const settingsPanel = document.querySelector('.th-settings-panel');
  const pick = selector => [...document.querySelectorAll(selector)].filter(isVisibleElement)
    .map(el => ({ text: el.textContent.trim().slice(0, 50), color: getComputedStyle(el).color,
      background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor,
      borderWidth: parseFloat(getComputedStyle(el).borderTopWidth),
      weight: Number(getComputedStyle(el).fontWeight),
      selected: el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true'
        || el.getAttribute('aria-checked') === 'true' }));
  const sample = document.createElement('i'); document.body.append(sample);
  const tokens = {};
  for (const name of ['--th-success', '--th-success-bg', '--th-text', '--th-border-surface',
    '--th-surface-overlay']) {
    sample.style.color = `var(${name})`; tokens[name] = getComputedStyle(sample).color;
  }
  sample.remove();
  const toast = document.querySelector('.th-toast--success');
  const controls = Object.fromEntries(Object.entries({
    cancel: '.th-wizard-foot .th-btn--ghost',
    next: '.th-wizard-foot .th-btn--primary',
    newFolder: '.th-picker-newfolder-toggle',
    choose: '.th-files-choose',
    save: '.th-editor-save',
  }).map(([name, selector]) => [name, pick(selector)]));
  return { tokens, toast: pick('.th-toast--success'),
    settingsGeometry: settingsPanel ? {
      rect: settingsPanel.getBoundingClientRect().toJSON(),
      ancestors: [...function* () { for (let el = settingsPanel.parentElement; el; el = el.parentElement) {
        yield { cls: el.className, overflowX: getComputedStyle(el).overflowX,
          overflowY: getComputedStyle(el).overflowY, rect: el.getBoundingClientRect().toJSON() };
      } }()],
    } : null,
    toastGlyph: toast && isVisibleElement(toast) ? [{ color: getComputedStyle(toast, '::before').color,
      background: getComputedStyle(toast, '::before').backgroundColor,
      mask: getComputedStyle(toast, '::before').maskImage }] : [],
    picker: pick('.th-model-picker-popover'),
    models: pick('.th-model-picker-list > button'),
    thinking: pick('.th-model-picker-popover [aria-pressed], .th-thinking-level [aria-pressed]'),
    secondary: pick('.th-modal .th-btn--ghost, .th-confirm .th-btn--ghost, .th-file-browser .th-btn--ghost'),
    controls,
    palettes: pick('.th-chat-slash [role="option"]'),
    segments: pick('.th-activity-tab-thumb, .th-activity-dag-view-thumb, .th-settings-seg-btn--on'),
    segmentPairs: [...document.querySelectorAll('.th-activity-tab-thumb, .th-activity-dag-view-thumb, .th-settings-seg-btn--on')]
      .filter(isVisibleElement).map(el => {
        const active = el.matches('.th-settings-seg-btn--on') ? el
          : el.parentElement.querySelector('[aria-selected="true"], [aria-pressed="true"]');
        const inactive = [...el.parentElement.querySelectorAll('button')].find(button => button !== active);
        return { active: getComputedStyle(el).backgroundColor,
          inactive: inactive ? getComputedStyle(inactive).backgroundColor : null,
          track: getComputedStyle(el.parentElement).backgroundColor, kind: el.className,
          activeRect: active?.getBoundingClientRect().toJSON() ?? null,
          thumbRect: el.getBoundingClientRect().toJSON(),
          selected: !!active, hasInactive: !!inactive };
      }),
  };
}

export function overlayVerdict(facts, required = [], requiredControls = []) {
  const failures = [];
  for (const kind of required) fail((facts[kind] ?? []).length > 0, `Q8 missing ${kind}`, failures);
  if (facts.toast?.length) fail(hue(facts.toast[0].background, facts.tokens['--th-success-bg'])
    && (facts.toastGlyph ?? []).some(g => hue(g.color, facts.tokens['--th-success'])),
  'Q8 success toast lacks semantic tint/glyph', failures);
  for (const picker of facts.picker ?? []) fail(parseColor(picker.background)?.a >= .92,
    'Q8 model picker is translucent without proven effective blur', failures);
  for (const group of ['models', 'thinking']) {
    const rows = facts[group] ?? [], active = rows.find(row => row.selected);
    if (rows.length) fail(active && rows.some(row => !row.selected
      && contrastRatio(compositeOver(parseColor(active.background), parseColor(facts.tokens['--th-surface-overlay'])),
        compositeOver(parseColor(row.background), parseColor(facts.tokens['--th-surface-overlay']))) >= 1.3),
    `Q8 ${group} active tier <1.3`, failures);
  }
  for (const pair of facts.segmentPairs ?? []) {
    fail(contrastRatio(compositeOver(parseColor(pair.active), parseColor(facts.tokens['--th-surface-overlay'])),
      compositeOver(parseColor(pair.inactive ?? pair.track),
        compositeOver(parseColor(pair.track), parseColor(facts.tokens['--th-surface-overlay'])))) >= 1.3
      && pair.selected && pair.hasInactive && pair.activeRect && pair.thumbRect
      && pair.thumbRect.left + pair.thumbRect.width / 2 >= pair.activeRect.left
      && pair.thumbRect.left + pair.thumbRect.width / 2 <= pair.activeRect.right,
    `Q8 segmented ${pair.kind} thumb not under active label or <1.3:1`, failures);
  }
  for (const button of facts.secondary ?? []) fail(parseColor(button.background)?.a > .02
    || button.borderWidth >= 1 && same(button.border, facts.tokens['--th-border-surface']),
  `Q8 secondary button "${button.text}" is bare`, failures);
  for (const name of requiredControls) {
    const buttons = facts.controls?.[name] ?? [];
    fail(buttons.length > 0, `Q8 ${name} action absent`, failures);
    for (const button of buttons) fail(parseColor(button.background)?.a > .02
      || button.borderWidth >= 1 && same(button.border, facts.tokens['--th-border-surface']),
    `Q8 ${name} action is bare`, failures);
  }
  for (const row of facts.palettes ?? []) fail(ratio(row.color,
    parseColor(row.background)?.a < .999 ? facts.tokens['--th-surface-overlay'] : row.background) >= 4.5,
    `Q8 palette name "${row.text}" too faint`, failures);
  if (facts.palettes?.length) {
    const selected = facts.palettes.find(row => row.selected);
    const neighbours = facts.palettes.filter(row => !row.selected);
    if (!neighbours.length) neighbours.push({ background: facts.tokens['--th-surface-overlay'] });
    fail(selected && neighbours.some(row => contrastRatio(
      compositeOver(parseColor(selected.background), parseColor(facts.tokens['--th-surface-overlay'])),
      compositeOver(parseColor(row.background), parseColor(facts.tokens['--th-surface-overlay']))) >= 1.3),
    'Q8 palette selection indistinct', failures);
  }
  return finish(facts, failures);
}

export function probeSecondary() {
  const root = getComputedStyle(document.documentElement);
  const surface = root.getPropertyValue('--th-bg').trim();
  const surfaceBorder = root.getPropertyValue('--th-border-surface').trim();
  const token = document.createElement('i');
  token.style.color = 'var(--th-surface-user)';
  document.body.append(token);
  const userSurface = getComputedStyle(token).color;
  token.remove();
  const pick = selector => [...document.querySelectorAll(selector)].filter(isVisibleElement)
    .map(el => ({ color: getComputedStyle(el).backgroundColor,
      border: getComputedStyle(el).borderTopColor, width: parseFloat(getComputedStyle(el).borderTopWidth),
      shadow: getComputedStyle(el).boxShadow, borderStyle: getComputedStyle(el).borderTopStyle,
      text: el.textContent.trim().slice(0, 50), cls: el.className,
      box: el.getBoundingClientRect().toJSON() }));
  const statsPanel = document.querySelector('.th-stats')?.closest('.th-modal');
  const modal = statsPanel ? (() => {
    const box = statsPanel.getBoundingClientRect();
    const fill = getComputedStyle(statsPanel).backgroundColor;
    const scrim = getComputedStyle(document.querySelector('.th-modal-backdrop')).backgroundColor;
    const pane = parseColor(surface);
    const flat = compositeOver(parseColor(fill), compositeOver(parseColor(scrim), pane));
    const behind = [...document.querySelectorAll(
      '.th-sidebar-section-label, .th-sidebar-live-label, .th-tree-label, .th-overview-card-name',
    )].filter(isVisibleElement).filter(el => {
      const r = el.getBoundingClientRect();
      return r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    }).map(el => {
      const ink = parseColor(getComputedStyle(el).color);
      const painted = compositeOver(parseColor(fill),
        compositeOver(parseColor(scrim), compositeOver(ink, pane)));
      return { text: el.textContent.trim().slice(0, 45),
        contrastUpperBound: flat && painted ? contrastRatio(painted, flat) : null };
    });
    return { found: true, fill, scrim, backdropFilter: getComputedStyle(statsPanel).backdropFilter,
      box: box.toJSON(), textBehind: behind };
  })() : null;
  return { surface, surfaceBorder, userSurface, modal, groups: {
    queue: pick('.th-queue-row'), stats: pick('.th-stats-row'),
    wizard: pick('.th-wizard-step'), login: pick('.th-login-card, .th-login-card input'),
    user: pick('.th-chat-msg--user'), shelf: pick('.th-activity-shelf, .th-goal-shelf'),
    agents: pick('.th-activity-agent-progress'),
  } };
}

export function secondaryVerdict(facts, required = []) {
  const failures = [];
  if (required.includes('stats')) {
    const opacity = parseColor(facts.modal?.fill)?.a ?? 0;
    const contrasts = (facts.modal?.textBehind ?? []).map(item => item.contrastUpperBound)
      .filter(Number.isFinite);
    fail(facts.modal?.found && (opacity >= .92 || contrasts.length > 0 && Math.max(...contrasts) < 1.3),
      `Q9 stats modal is translucent (${opacity.toFixed(2)}) without proven noncompeting behind-text contrast (${contrasts.join(', ') || 'unmeasured'})`,
      failures);
  }
  for (const kind of required) {
    const rows = facts.groups?.[kind] ?? [];
    fail(rows.length > 0, `Q9 ${kind} surface absent`, failures);
    for (const row of rows) {
      if (kind === 'user') fail(hue(row.color, facts.userSurface)
        && row.shadow !== 'none' && row.width === 0 && row.borderStyle === 'none',
      'Q9 user bubble misses dedicated fill/shadow/borderless anatomy', failures);
      else fail(ratio(row.color, facts.surface) >= 1.3
        || row.width >= 1 && row.borderStyle !== 'none'
          && (parseColor(row.border)?.a ?? 0) >= (parseColor(facts.surfaceBorder)?.a ?? 0.06) - 0.005,
      `Q9 ${kind} boundary below 1.3:1`, failures);
    }
  }
  return finish(facts, failures);
}

export function probeEmptyPane() {
  const panes = [...document.querySelectorAll('.th-pane-wrap, .th-empty')].filter(isVisibleElement);
  return panes.filter(pane => pane.querySelector('.th-picker-pane, .th-empty')).map(pane => {
    const viewport = pane.getBoundingClientRect().toJSON();
    const list = pane.querySelector('.th-picker-pane-list, .th-empty-sessions');
    const button = pane.querySelector('.th-picker-pane-create button')
      ?? [...pane.querySelectorAll('button')].find(el => /new chat session/i.test(el.textContent));
    return { kind: pane.classList.contains('th-empty') ? 'single' : 'split',
      viewport, list: list?.getBoundingClientRect().toJSON() ?? null,
      button: button?.getBoundingClientRect().toJSON() ?? null,
      scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
  });
}

export function probeSplitApplicability() {
  const panes = [...document.querySelectorAll('.th-pane-wrap')];
  return { viewportWidth: window.innerWidth, splitCount: document.querySelectorAll('.th-split').length,
    mountedPanes: panes.length, visiblePanes: panes.filter(isVisibleElement).length,
    mountedPickers: document.querySelectorAll('.th-picker-pane').length,
    visiblePickers: [...document.querySelectorAll('.th-picker-pane')].filter(isVisibleElement).length,
    visibleChats: [...document.querySelectorAll('.th-chat-pane')].filter(isVisibleElement).length,
    visiblePaneIds: panes.filter(isVisibleElement).map(pane => pane.dataset.paneId) };
}

export function emptyVerdict(facts, kind = 'split') {
  const failures = [];
  fail(facts?.length > 0, `Q10 no empty ${kind} pane`, failures);
  for (const pane of facts ?? []) fail(pane.kind === kind
    && inside(pane.list, pane.viewport) && inside(pane.button, pane.viewport)
    && pane.scrollHeight <= pane.clientHeight + 1,
  `Q10 ${kind} chooser or New chat session below fold`, failures);
  return finish(facts, failures);
}

async function setupCoarseLive(ctx, extra) {
  const fixture = startTaskFixture({ ...designSeed(extra.layout ?? 'single'), port: 0 });
  let context;
  try {
    context = await ctx.browser.newContext({
      viewport: { width: ctx.viewport.width, height: ctx.viewport.height },
      colorScheme: ctx.theme, hasTouch: true, isMobile: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    if (extra.earlierWorkspaces) {
      // E33 fixture: 12 workspaces named "Earlier workspace N" with no chats,
      // so every drawer row's trailing number must stay visible.
      await context.route('**/api/workspaces', async route => {
        const response = await route.fetch();
        const original = await response.json();
        const earlier = Array.from({ length: 12 }, (_, index) => ({
          id: `qa-top-${index}`, name: `Earlier workspace ${index + 1}`, path: `/fixture/earlier-${index}`,
          chats: [],
        }));
        await route.fulfill({ response, json: [...earlier, ...original] });
      });
      await context.route(/\/api\/workspaces\/qa-top-\d+\/sessions(?:\?.*)?$/, route =>
        route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ items: [], nextCursor: '' }) }));
    }
    await installSignals(page, { theme: ctx.theme });
    const attached = fixture.base.wait('frame', frame => frame.type === 'chat.stats');
    await page.goto(fixture.url);
    await attached;
    await page.evaluate(() => window.qaSignal(() =>
      document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
      && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
    await seedLive(page, fixture);
    return { page, context, fixture, errors, async close() {
      await context.close(); return { contextClosed: true, url: fixture.url, ...await fixture.stop() };
    } };
  } catch (error) {
    if (context) await context.close();
    await fixture.stop();
    throw error;
  }
}

async function withFixture(ctx, run, extra = {}) {
  const env = await (extra.touchLive ? setupCoarseLive(ctx, extra)
    : extra.coarse ? ctx.setupDesign(extra) : ctx.setupLive(extra)), screenshots = [];
  let result;
  try {
    result = await run(env, async suffix => {
      const path = await ctx.save(env.page, suffix);
      screenshots.push(path); return path;
    });
    result.measurements = { ...result.measurements, pageErrors: env.errors };
    if (env.errors.length) { result.pass = false; result.failures.push(...env.errors.map(error => `pageerror: ${error}`)); }
    result.screenshots = [...screenshots, ...(result.screenshots ?? [])];
  } catch (error) {
    result = { pass: false, measurements: { pageErrors: env.errors },
      failures: [`harness error: ${errorLine(error)}`], screenshots };
  } finally {
    result.teardown = await env.close();
    if (!result.teardown.contextClosed) { result.pass = false; result.failures.push('fixture context not closed'); }
  }
  return result;
}

async function drawer(page) {
  const menu = page.locator('.th-mobile-menu').first();
  if (!(await menu.isVisible().catch(() => false))) return;
  if (await page.locator('.th-sidebar').getAttribute('aria-hidden') === 'true') {
    await menu.click();
    await page.waitForFunction(() => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') !== 'true');
  }
  await page.evaluate(async () => {
    const animations = document.querySelector('.th-sidebar')?.getAnimations({ subtree: true })
      .filter(a => a.effect?.getComputedTiming()?.iterations !== Infinity) ?? [];
    await Promise.allSettled(animations.map(a => a.finished));
  });
}

async function dismissDrawer(page) {
  const backdrop = page.locator('.th-backdrop');
  if (!await backdrop.isVisible().catch(() => false)) return;
  const box = await backdrop.boundingBox();
  await backdrop.click({ position: { x: box.width - 12, y: Math.min(100, box.height - 12) } });
  await page.waitForFunction(() => document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true');
  await page.evaluate(async () => {
    const animations = document.querySelector('.th-sidebar')?.getAnimations({ subtree: true })
      .filter(a => a.effect?.getComputedTiming()?.iterations !== Infinity) ?? [];
    await Promise.allSettled(animations.map(a => a.finished));
  });
}

async function settleFinite(page, selector) {
  await page.locator(selector).first().evaluate(async element => {
    const animations = element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming()?.iterations !== Infinity);
    await Promise.allSettled(animations.map(animation => animation.finished));
  });
}

async function dag(env, stage) {
  const state = { stage, tick: 1 };
  await env.page.route(`**/api/workspaces/ws/chats/${CHAT}/dag-runs**`, route => {
    const run = t4StageRun(state.stage, state.tick);
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(/\/dag-runs\/[^/]+$/.test(new URL(route.request().url()).pathname)
        ? t4DocumentPayload(run) : t4CatalogPayload(run)) });
  });
  const update = async next => {
    state.stage = next; state.tick++;
    const run = t4StageRun(next, state.tick);
    for (const frame of t4ExtensionFrames(run, CHAT)) await env.fixture.deliver(CHAT, frame);
    env.fixture.overview(t4ActivityFrame(run, CHAT));
  };
  await update(stage);
  await env.page.click('[data-activity-tab="dag"]');
  await env.page.waitForSelector('.th-activity-gnode--running', { timeout: 9000 });
  return update;
}

export function dagVerdict(facts, roles, width) {
  const failures = [];
  fail(facts.found && facts.scroller && facts.nodes?.length >= 11, 'Q3 missing mixed DAG graph or reel', failures);
  if (!facts.found) return finish(facts, failures);
  for (const verdict of [
    nodeStrokeViolations(facts.nodes, facts.tokens),
    nodeTintVerdict(facts.nodes, roles, { completed: facts.tokens['--th-success-bg'],
      failed: facts.tokens['--th-error-bg'], running: facts.tokens['--th-accent-bg'] }),
    fulfilledEdgeContrastVerdict(facts.edges, facts.arrowheads, facts.graphBackground,
      t4StageSpec('mixed').reduce((sum, node) =>
        sum + node.deps.filter(dep => t4StageSpec('mixed').find(n => n.id === dep)?.state === 'completed').length, 0),
      ['--th-success', '--th-error', '--th-accent', '--th-warning'].map(name => facts.tokens[name])),
    visibleMixedNodesVerdict({ ...facts, viewportWidth: width }),
    footerInsidePanelVerdict(facts.footer),
  ]) failures.push(...verdict.failures);
  fail((facts.halos ?? []).some(halo => halo.visible && halo.insideRunningNode),
    'Q3 running halo missing', failures);
  return finish(facts, failures);
}

export function probeMobileDag() {
  const reel = document.querySelector('.th-activity-graph');
  const svg = reel?.querySelector('svg');
  const box = el => el?.getBoundingClientRect().toJSON() ?? null;
  const nodes = [...(svg?.querySelectorAll('g[data-node]') ?? [])].map(group => {
    const card = group.querySelector('.th-activity-gnode-card');
    const words = [...group.querySelectorAll('text[class*="glabel"], text[class*="gstate"]')].map(el => {
      const style = getComputedStyle(el), measured = el.getComputedTextLength?.() ?? 0;
      const clipId = /^url\(#([^)]+)\)$/.exec(el.getAttribute('clip-path') ?? '')?.[1];
      const allowed = Number(document.getElementById(clipId)?.querySelector('rect')?.getAttribute('width'));
      return { text: el.textContent.trim(), kind: el.classList.contains('th-activity-gstate') ? 'state' : 'title',
        fontSize: parseFloat(style.fontSize),
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        measured, allowed, clipId: clipId ?? null,
        clipped: style.textOverflow === 'ellipsis' || !clipId || !allowed || measured > allowed + 1 };
    });
    return { id: group.dataset.node, card: box(card), words,
      title: words.filter(word => word.kind === 'title').map(word => word.text).join(''),
      stateWord: words.find(word => word.kind === 'state')?.text ?? null };
  });
  return { reel: reel ? { box: box(reel), scrollHeight: reel.scrollHeight, clientHeight: reel.clientHeight,
    scrollWidth: reel.scrollWidth, clientWidth: reel.clientWidth } : null, nodes };
}

export function mobileDagVerdict(facts, desktopHeight, stage = 'mixed') {
  const failures = [], reel = facts.reel, nodes = facts.nodes ?? [];
  fail(reel && reel.scrollHeight <= reel.clientHeight + 1, `Q14 ${stage} reel scrolls vertically`, failures);
  const complete = nodes.filter(node => node.card && reel && inside(node.card, reel.box));
  if (stage === 'mixed') fail(complete.length >= 3, `Q14 only ${complete.length} whole mobile DAG nodes`, failures);
  fail(nodes.length === t4StageSpec(stage).length, `Q14 ${stage} node count`, failures);
  for (const node of nodes) {
    fail(node.card && node.card.height < desktopHeight, `Q14 ${node.id} not shorter than desktop`, failures);
    const expected = t4StageSpec(stage).find(item => item.id === node.id);
    fail(expected && node.title === expected.label
      && node.stateWord === english[`activity.status.${expected.state}`],
    `Q14/Q15 ${node.id} title or state word shortened`, failures);
    for (const word of node.words) fail(word.fontSize >= 10.99 && !word.clipped
      && (word.clientWidth > 0 ? word.scrollWidth <= word.clientWidth + 1
        : !!word.clipId && word.allowed > 0 && word.measured <= word.allowed + 1),
    `Q14/Q15 ${node.id} clipped word "${word.text}"`, failures);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of t4StageSpec(stage)) for (const dep of node.deps) {
    const target = byId.get(node.id), source = byId.get(dep);
    fail(source?.card && target?.card && target.card.left > source.card.left,
      `Q14 ${dep} -> ${node.id} wraps or reverses direction`, failures);
  }
  return finish({ ...facts, wholeCards: complete.map(node => node.id), desktopHeight }, failures);
}

export function phoneToolVerdict(facts) {
  const failures = [];
  fail((facts.tools ?? []).length >= 2, 'Q15 missing collapsed/expanded tool cards', failures);
  for (const item of facts.tools ?? []) {
    const label = item.id === 'design-running' ? english['tool.running']
      : item.id === 'design-failed' ? english['tool.error'] : english['tool.done'];
    fail(item.card && item.contentRight !== null && item.card.right <= item.contentRight + 1
      && item.word?.box && inside(item.word.box, item.card) && item.word.text === label,
    `Q15 ${item.id} card/word clipped at reading-column right`, failures);
    if (item.expanded) fail(item.body && item.body.right <= item.contentRight + 1
      && inside(item.body, item.card),
    `Q15 ${item.id} expanded body overhangs reading column`, failures);
  }
  return finish(facts, failures);
}

/** The virtual history sizer must end at its measured last row, not at the
 * old expanded height. The next live record must start without a blank band. */
export function probeDisclosureGeometry({ selector } = {}) {
  const box = element => element?.getBoundingClientRect().toJSON() ?? null;
  const scroll = document.querySelector('.th-chat-body');
  const history = document.querySelector('.th-chat-history');
  const target = document.querySelector(selector);
  const rows = [...(history?.querySelectorAll(':scope > .th-chat-row[data-index]') ?? [])]
    .map(element => ({ index: Number(element.dataset.index), box: box(element) }))
    .sort((a, b) => a.index - b.index);
  const historicalTail = history?.querySelector('.th-chat-thinking')?.closest('.th-chat-row[data-index]');
  const live = [...document.querySelectorAll('.th-chat-live > .th-chat-record')].map(element => box(element));
  const tail = box(historicalTail), viewport = box(scroll), historyBox = box(history);
  const visible = rows.map(row => row.box)
    .filter(rect => rect && viewport && rect.bottom > viewport.top && rect.top < viewport.bottom);
  if (tail && viewport && tail.bottom < viewport.bottom) visible.push(...live.filter(Boolean));
  return {
    target: box(target), viewport, rows, live, tail, history: historyBox,
    total: history ? Number.parseFloat(history.style.height) : null,
    measuredEnd: tail && historyBox ? tail.bottom - historyBox.top : null,
    gaps: visible.slice(1).map((rect, index) => Math.max(0, rect.top - visible[index].bottom)),
    nextAfterTail: tail && live[0] ? live[0].top - tail.bottom : null,
  };
}

export function disclosureVerdict(before, after) {
  const failures = [];
  fail(!!after.viewport && !!after.target && !!after.history && !!after.tail,
    'Q17 missing transcript, toggled record or historical tail', failures);
  if (before.target && after.target)
    fail(Math.abs(after.target.top - before.target.top) <= 1,
      `Q17 toggled record moved ${Math.abs(after.target.top - before.target.top).toFixed(1)}px`, failures);
  if (after.tail && after.viewport && after.tail.bottom <= after.viewport.bottom + 1) {
    fail(Math.abs(after.total - after.measuredEnd) <= 1,
      `Q17 virtualizer total differs from measured row end by ${Math.abs(after.total - after.measuredEnd).toFixed(1)}px`, failures);
    fail(after.nextAfterTail !== null && after.nextAfterTail <= 24,
      `Q17 missing rows after historical tail (${after.nextAfterTail}px gap)`, failures);
  }
  fail((after.gaps ?? []).every(gap => gap <= 24),
    `Q17 consecutive transcript rows leave a ${Math.max(0, ...(after.gaps ?? [])).toFixed(1)}px gap`, failures);
  return finish({ before, after }, failures);
}

/** Measure the actual first text run, not the <pre> box: blank lines can
 * leave its geometry intact while pushing the first painted glyph down. */
export function probeExpandedOutput({ id } = {}) {
  const well = document.querySelector(`[data-tool-call-id="${id}"] .th-tool-output`);
  if (!well) return { id, present: false };
  const text = well.firstChild;
  const offset = text?.textContent.search(/\S/) ?? -1;
  const range = document.createRange();
  if (text?.nodeType === Node.TEXT_NODE && offset >= 0) {
    range.setStart(text, offset);
    range.setEnd(text, Math.min(offset + 1, text.textContent.length));
  }
  const first = offset >= 0 ? range.getBoundingClientRect() : null;
  const style = getComputedStyle(well);
  const contentTop = well.getBoundingClientRect().top
    + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
  return {
    id, present: true, scrollTop: well.scrollTop,
    gap: first ? first.top - contentTop : null,
    firstLineStart: offset >= 0 ? text.textContent.slice(offset, offset + 9) : null,
    mask: style.maskImage, webkitMask: style.webkitMaskImage,
  };
}

export function expandedOutputVerdict(facts, expectedStart) {
  const failures = [];
  fail(facts.present && facts.gap !== null, `Q18 ${facts.id} output has no painted text`, failures);
  if (facts.present) {
    fail(facts.scrollTop === 0, `Q18 ${facts.id} first expand scrolled to ${facts.scrollTop}`, failures);
    fail(facts.gap !== null && facts.gap >= -1 && facts.gap <= 8,
      `Q18 ${facts.id} first text starts ${facts.gap}px from content top`, failures);
    fail(facts.paintedGap !== null && facts.paintedGap <= 8,
      `Q18 ${facts.id} first painted pixels start ${facts.paintedGap}px from content top`, failures);
    fail(facts.firstLineStart === expectedStart,
      `Q18 ${facts.id} first visible line is not the record start`, failures);
    // A mask on a nested scrolling well can hide its text after the virtual
    // row above changes height even when its DOM range and scrollTop are right.
    fail(facts.mask === 'none' && facts.webkitMask === 'none',
      `Q18 ${facts.id} scrolling output has a paint-obscuring mask`, failures);
  }
  return finish(facts, failures);
}

/** DOM ranges miss stale compositor layers. Sample the actual screenshot's
 * first text-coloured pixel within the well, away from its border/fade. */
async function probeOutputPaint(page, id) {
  const png = (await page.screenshot({ scale: 'css' })).toString('base64');
  return page.evaluate(async ({ id, png }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const well = document.querySelector(`[data-tool-call-id="${id}"] .th-tool-output`);
    if (!well) return null;
    const box = well.getBoundingClientRect(), style = getComputedStyle(well);
    const background = style.backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
    if (!background) return null;
    const top = Math.ceil(box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop));
    const left = Math.ceil(box.left + parseFloat(style.paddingLeft));
    const right = Math.min(left + 100, Math.floor(box.right - parseFloat(style.paddingRight)), canvas.width);
    const bottom = Math.min(Math.floor(box.bottom - (box.height > 60 ? 20 : 0)), canvas.height);
    for (let y = Math.max(0, top); y < bottom; y++) {
      for (let x = Math.max(0, left); x < right; x++) {
        const index = (y * canvas.width + x) * 4;
        if (background.some((channel, offset) => Math.abs(channel - pixels[index + offset]) > 60))
          return y - top;
      }
    }
    return null;
  }, { id, png });
}

async function driveQ1(ctx) {
  return withFixture(ctx, async (env, save) => {
    const records = [], captures = [], thinkingStates = [];
    await env.fixture.deliver(CHAT, {
      type: 'message', message: { role: 'assistant',
        blocks: [{ kind: 'thinking', id: 'qa-historical-thought', thinking: 'Historical QA reasoning.' }],
        model: 'qa', usage: {}, ts: 1 },
    });
    await env.page.waitForSelector('.th-chat-history .th-chat-thinking', { timeout: 4000 });
    await env.fixture.deliver(CHAT, {
      type: 'messageDelta', delta: { kind: 'thinking_delta', delta: 'Live QA reasoning.' },
    });
    await env.page.waitForSelector('.th-chat-thinking--running', { timeout: 4000 });
    for (const id of ['design-read', 'design-failed', 'design-running']) {
      const row = env.page.locator(`[data-tool-call-id="${id}"]`);
      await row.scrollIntoViewIfNeeded();
      const head = row.locator('.th-tool-head');
      const before = await head.getAttribute('aria-expanded');
      if (before !== 'true') await head.click();
      await env.page.waitForFunction(id => document.querySelector(`[data-tool-call-id="${id}"] .th-tool-head`)
        ?.getAttribute('aria-expanded') === 'true', id);
      records.push((await ctx.probe(env.page, probeToolEmphasis)).tools.find(item => item.id === id));
      captures.push(await save(`-${id}-open`));
      await head.click();
      records.push((await ctx.probe(env.page, probeToolEmphasis)).tools.find(item => item.id === id));
      captures.push(await save(`-${id}-collapsed`));
    }
    await env.page.locator('[data-tool-call-id="design-failed"]').scrollIntoViewIfNeeded();
    const facts = await ctx.probe(env.page, probeToolEmphasis);
    const decision = toolVerdict({ ...facts, tools: records });
    for (const [selector, live] of [['.th-chat-history', false], ['.th-chat-live', true]]) {
      const head = env.page.locator(`${selector} .th-chat-thinking-head`).first();
      await head.scrollIntoViewIfNeeded();
      await head.click();
      await env.page.waitForFunction(parent => document.querySelector(`${parent} .th-chat-thinking-head`)
        ?.getAttribute('aria-expanded') === 'true', selector);
      const open = await ctx.probe(env.page, probeToolEmphasis);
      const thinking = open.thinking.find(row => row.live === live);
      thinkingStates.push({ live, ...thinking });
      fail(thinking?.font === open.mono && thinking?.textCrossings.length === 0,
        `Q1 ${selector} thinking font or rail intersection`, decision.failures);
      captures.push(await save(`-${live ? 'live' : 'historical'}-thinking`));
    }
    for (const id of ['design-read', 'design-failed', 'design-running'])
      fail(records.some(record => record?.id === id && record.expanded)
        && records.some(record => record?.id === id && !record.expanded),
      `Q1 ${id} disclosure states missing`, decision.failures);
    decision.pass = decision.failures.length === 0;
    return { ...decision, measurements: { ...decision.measurements, captures, thinkingStates } };
  });
}

async function driveQ2(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, measurements = {}, failures = [];
    const capture = async (name, required, states) => {
      const facts = await ctx.probe(page, probeStatusEmphasis);
      const decision = statusVerdict(facts, required, states);
      measurements[name] = facts;
      failures.push(...decision.failures.map(reason => `${name}: ${reason}`));
      await save(`-${name}`);
    };
    await capture('goal-active', ['goal'], ['accent']);
    // Reload the same fixture with a routed goal response to cover all
    // three real GoalBar render paths; do not paint status in the DOM.
    for (const status of ['complete', 'blocked']) {
      await page.route('**/api/workspaces/ws/chats/stored-a/goal', route =>
        route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ goal: { status, objective: `${status} fixture goal` } }) }));
      await page.reload();
      await page.waitForSelector('.th-goal-bar .th-activity-chip', { timeout: 8000 });
      await capture(`goal-${status}`, ['goal'], [status === 'complete' ? 'success' : 'error']);
      await page.unroute('**/api/workspaces/ws/chats/stored-a/goal');
    }
    const tasks = [
      { task_id: 'qa-running', name: 'Running fixture', status: 'running' },
      { task_id: 'qa-completed', name: 'Completed fixture', status: 'completed' },
      { task_id: 'qa-failed', name: 'Failed fixture', status: 'failed' },
    ];
    // Todo authority requires a live binding. If this fixture lacks one,
    // record a precise missing-surface failure rather than timing out.
    const bindingId = 'emphasis-restore-qa-binding';
    await env.fixture.deliver(CHAT, { type: 'ready', resumed: true, piSessionId: CHAT, bindingId });
    measurements.todoBinding = { bindingId, piSessionId: CHAT };
    await env.fixture.deliver(CHAT, {
      type: 'chat.todo', sessionId: CHAT, durableSessionId: CHAT,
      bindingId, requestGeneration: 1, source: {
        leafId: 'qa-todo-leaf', entryId: 'qa-todo-entry', entryIndex: 0, kind: 'custom',
      }, status: 'ready',
      phases: [{ name: 'QA states', tasks: [
        { content: 'Completed', status: 'completed' }, { content: 'Running', status: 'in_progress' },
        { content: 'Failed', status: 'abandoned' }] }],
    });
    await page.click('[data-activity-tab="todo"]');
    await page.waitForSelector('.th-activity-todo-task .th-activity-chip', { timeout: 4000 });
    await capture('todo', ['todo'], ['success', 'accent']);
    await page.click('[data-activity-tab="agents"]');
    const agentMounted = page.evaluate(() => window.qaSignal(() =>
      !!document.querySelector('.th-activity-agent .th-activity-chip')));
    await env.fixture.deliver(CHAT, { type: 'extensionEvent', sessionId: CHAT, name: 'omo.task.updated',
      data: { parent_session_id: CHAT, truncated_tasks: false, tasks } });
    await agentMounted;
    await capture('agents', ['agents'], ['success', 'error', 'accent']);
    await dag(env, 'mixed');
    await page.click('[data-view="list"]');
    if (!await page.locator('.th-activity-dagnodes .th-activity-dnode-state').count())
      failures.push('Q2 DAG list did not mount');
    else await capture('dag-list', ['dag-list', 'dag-head'], ['success', 'error', 'accent']);
    return finish(measurements, failures);
  });
}

async function driveQ3(ctx) {
  return withFixture(ctx, async (env, save) => {
    await dag(env, 'mixed');
    const facts = await ctx.probe(env.page, probeDagGraph, { runningId: 'k6', sourceId: 'k5' });
    const verdict = dagVerdict(facts, t4StageRoles('mixed'), ctx.viewport.width);
    const motion = await ctx.probe(env.page, probeDagRunningMotion);
    verdict.failures.push(...dagRunningMotionVerdict(motion).failures);
    await save('-mixed');
    await env.page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await ctx.probe(env.page, probeDagRunningMotion);
    verdict.failures.push(...dagReducedMotionVerdict(reduced).failures);
    verdict.pass = verdict.failures.length === 0;
    verdict.measurements = { ...facts, motion, reduced };
    await save('-mixed-reduced');
    return verdict;
  });
}

async function driveQ4(ctx) {
  return withFixture(ctx, async (env, save) => {
    const now = Date.now();
    let connectedSession = false;
    const liveRow = (id, agents, active) => ({
      id, title: id === CHAT ? 'Stored A' : 'Newer', active, last_activity_ms: now,
      running: { agents, tasks: 0, dag: 0 }, done: 0, dag_done: 0, dag_total: 0,
      truncated: { task: false, dag: false }, last_line: 'Q4 live fixture',
    });
    // The base fixture's fallback poll reports no live sessions. Preserve
    // the same membership that the native push announces, or its 4s poll
    // would silently erase a valid connected-but-idle row mid-measurement.
    await env.context.route('**/api/sessions/live', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ sessions: [liveRow(CHAT, 2, true),
        ...(connectedSession ? [liveRow('newer', 0, false)] : [])] }),
    }));
    env.fixture.overview(shellLiveFrame({ sessionId: CHAT, title: 'Stored A', agents: 2 }));
    await drawer(env.page);
    await env.page.waitForSelector('.th-tree-running-dot', { timeout: 6000 });
    const running = await ctx.probe(env.page, probeSidebarEmphasis);
    const decision = sidebarVerdict(running);
    await save('-running');
    // The fixture already has a stored Newer row with no live process. Read
    // that actual offline state before the live summary connects it; sending
    // active:false does not remove a previously connected live summary.
    const idle = await ctx.probe(env.page, probeSidebarEmphasis);
    await save('-idle');
    const connectedReady = env.page.evaluate(() => window.qaSignal(() =>
      [...document.querySelectorAll('.th-tree-node')].some(node =>
        node.querySelector('.th-tree-label')?.textContent === 'Newer'
        && !!node.querySelector('.th-tree-live') && !node.querySelector('.th-tree-running'))));
    connectedSession = true;
    env.fixture.overview(shellLiveFrame({ sessionId: 'newer', title: 'Newer', agents: 0, active: false, now }));
    const connectedPainted = await connectedReady.then(() => true, () => false);
    const connected = await ctx.probe(env.page, probeSidebarEmphasis);
    fail(connectedPainted, 'Q4 connected idle presence never painted after live summary', decision.failures);
    decision.failures.push(...sidebarStatesVerdict(running, connected, idle).failures);
    decision.pass = decision.failures.length === 0;
    decision.measurements = { running, connected, idle };
    await save('-connected');
    await env.page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await ctx.probe(env.page, probeSidebarEmphasis);
    fail(reduced.running.every(row => row.animation.length === 0 && !!row.accessible),
      'Q4 reduced-motion running glyph/name missing', decision.failures);
    decision.pass = decision.failures.length === 0;
    decision.measurements.reduced = reduced;
    await save('-reduced');
    return decision;
  });
}

async function driveQ5(ctx) {
  return withFixture(ctx, async (env, save) => {
    const measurements = {}, failures = [];
    for (const ids of [[CHAT], [CHAT, 'newer', 'created-2']]) {
      if (ids.length === 3) {
        const response = await fetch(`${env.fixture.base.url}/api/workspaces/ws/chats`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        if (!response.ok) failures.push('Q5 third live card creation failed');
        await env.page.reload();
        await env.page.waitForSelector('.th-tree-workspace', { state: 'attached', timeout: 4000 });
      }
      for (const id of ids) env.fixture.overview(shellLiveFrame({ sessionId: id, title: id, agents: 1 }));
      await env.page.waitForFunction(count =>
        document.querySelectorAll('.th-sidebar-live-list .th-overview-card').length === count,
      ids.length, { timeout: 4000 });
      await drawer(env.page); // awaits finite drawer animation before 390px geometry.
      const facts = await ctx.probe(env.page, probeSidebarEmphasis);
      measurements[ids.length] = facts;
      fail(facts.coarsePointer === (ctx.viewport.width <= 768),
        `Q5 expected ${ctx.viewport.width <= 768 ? 'coarse' : 'fine'} pointer fixture`, failures);
      failures.push(...sidebarVerdict(facts, { cards: ids.length, geometry: true }).failures);
      await save(`-${ids.length}-cards-drawer-settled`);
    }
    return finish(measurements, failures);
  }, { touchLive: ctx.viewport.width <= 768 });
}

async function driveQ6(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, measurements = {}, failures = [];
    env.fixture.overview(shellLiveFrame({ sessionId: CHAT, title: 'Stored A', agents: 1 }));
    await drawer(env.page);
    const capture = async (stage, required) => {
      const facts = await ctx.probe(page, probeHeadings);
      measurements[stage] = facts;
      failures.push(...headingVerdict(facts, required).failures.map(reason => `${stage}: ${reason}`));
      await save(`-${stage}`);
    };
    await page.waitForSelector('.th-sidebar-live-label', { timeout: 4000 });
    await capture('sessions-workspaces-status', ['sidebar']);
    await page.locator('.th-settings-menu > button').click();
    await page.waitForSelector('.th-settings-panel .th-settings-section .th-settings-label', { timeout: 4000 });
    await settleFinite(page, '.th-settings-panel');
    await capture('settings-headings', ['sidebar', 'settings']);
    await page.keyboard.press('Escape');
    await dismissDrawer(page);
    await page.locator('.th-files-toggle').click();
    await page.waitForSelector('.th-files-title', { timeout: 4000 });
    await capture('files-heading', ['files']);
    return finish(measurements, failures);
  });
}

async function driveQ7(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, coarse = ctx.viewport.width <= 768;
    await env.context.route('**/api/providers', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'omo', label: 'omo', available: false }]),
    }));
    await page.reload();
    await page.waitForSelector('.th-tree-workspace', { state: 'attached', timeout: 4000 });
    await drawer(page);
    const row = page.locator('.th-tree-workspace > .th-tree-node').first();
    if (!coarse) await row.hover();
    const decision = actionVerdict(await ctx.probe(page, probeActionSurface), coarse);
    if (!coarse) await save('-hover-inline');
    if (!coarse) {
      await page.mouse.move(0, 0);
      await row.locator('.th-tree-activation').focus();
      decision.failures.push(...actionVerdict(await ctx.probe(page, probeActionSurface), false).failures);
      await save('-focus-inline');
    } else {
      const menuReady = page.evaluate(() => window.qaSignal(() =>
        document.querySelectorAll('.th-tree-workspace > .th-tree-node .th-tree-overflow-item').length === 3));
      await row.locator('.th-tree-actions--overflow > button').click();
      const opened = await menuReady.then(() => true, () => false);
      if (opened) await settleFinite(page, '.th-tree-overflow');
      const openFacts = await ctx.probe(page, probeActionSurface);
      fail(opened, 'Q7 coarse overflow menu did not open', decision.failures);
      decision.failures.push(...actionVerdict(openFacts, true, true).failures);
      decision.measurements = { ...decision.measurements, menu: openFacts.menu, openMenu: openFacts };
      await save('-overflow');
      if (opened) await page.keyboard.press('Escape');
    }
    const actions = coarse ? '.th-tree-overflow-item' : '.th-tree-actions:not(.th-tree-actions--overflow) > button';
    for (const [index, selector] of [[0, '.th-tree-rename'], [1, '.th-modal-overlay'], [2, '.th-confirm']]) {
      if (!coarse) await row.hover(); // required before EVERY fine-pointer click.
      else await row.locator('.th-tree-actions--overflow > button').click();
      await row.locator(actions).nth(index).click();
      fail(await page.locator(selector).isVisible(), `Q7 action ${index} did not open ${selector}`, decision.failures);
      await save(`-action-${index}`);
      await page.keyboard.press('Escape');
      if (coarse) await drawer(page);
    }
    decision.pass = decision.failures.length === 0;
    return decision;
  }, { coarse: ctx.viewport.width <= 768 });
}

async function driveQ8(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, measurements = {}, failures = [];
    await page.click('.th-model-picker-btn');
    await page.waitForSelector('.th-model-picker-popover', { timeout: 4000 });
    await settleFinite(page, '.th-model-picker-popover');
    let facts = await ctx.probe(page, probeOverlayEmphasis);
    measurements.picker = facts;
    failures.push(...overlayVerdict(facts, ['picker', 'models', 'thinking', 'segments']).failures);
    await save('-picker');
    await page.keyboard.press('Escape');
    await page.locator('.th-chat-input textarea').fill('/');
    await page.waitForSelector('.th-chat-slash', { timeout: 4000 });
    await settleFinite(page, '.th-chat-slash');
    const palette = await ctx.probe(page, probeOverlayEmphasis);
    measurements.palette = palette;
    failures.push(...overlayVerdict(palette, ['palettes']).failures);
    await save('-slash-palette');
    await page.keyboard.press('Escape');
    await page.locator('.th-chat-input textarea').fill('@');
    await page.waitForSelector('.th-chat-files [role="option"]', { timeout: 4000 });
    await settleFinite(page, '.th-chat-files');
    const files = await ctx.probe(page, probeOverlayEmphasis);
    measurements.filePalette = files;
    failures.push(...overlayVerdict(files, ['palettes']).failures);
    await save('-file-palette');
    await page.keyboard.press('Escape');

    await dag(env, 'mixed');
    const graphControls = await ctx.probe(page, probeOverlayEmphasis);
    measurements.graphSegments = graphControls;
    fail(graphControls.segmentPairs?.length >= 2, 'Q8 shelf and List/Graph segment thumbs not both mounted', failures);
    failures.push(...overlayVerdict(graphControls, ['segments']).failures);
    await save('-graph-segments');
    await drawer(page);
    await page.locator('.th-settings-menu > button').click();
    await page.waitForSelector('.th-settings-seg-btn--on', { timeout: 4000 });
    await settleFinite(page, '.th-settings-panel');
    const settings = await ctx.probe(page, probeOverlayEmphasis);
    measurements.settingsSegments = settings;
    fail(settings.segmentPairs?.filter(pair => /th-settings-seg-btn/.test(pair.kind)).length >= 2,
      'Q8 theme and language active segments missing', failures);
    failures.push(...overlayVerdict(settings, ['segments']).failures);
    await save('-settings-segments');
    await page.keyboard.press('Escape');
    await drawer(page);
    await env.context.route('**/api/fs/browse**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ path: '/fixture', parent: null, dirs: ['docs'] }),
    }));
    await page.locator('.th-btn-add').click();
    await page.waitForSelector('.th-wizard-foot .th-btn--ghost', { timeout: 4000 });
    await page.waitForSelector('.th-picker-newfolder-toggle', { timeout: 4000 });
    await settleFinite(page, '.th-modal');
    const modal = await ctx.probe(page, probeOverlayEmphasis);
    measurements.secondary = modal;
    failures.push(...overlayVerdict(modal, ['secondary'], ['cancel', 'next', 'newFolder']).failures);
    await save('-secondary-buttons');
    await page.keyboard.press('Escape');
    await dismissDrawer(page);
    await page.locator('.th-files-toggle').click();
    await page.waitForSelector('.th-files-choose', { timeout: 4000 });
    const browser = await ctx.probe(page, probeOverlayEmphasis);
    measurements.fileControls = browser;
    failures.push(...overlayVerdict(browser, [], ['choose']).failures);
    await save('-choose-files');
    await page.locator('.th-files-name--link').first().click();
    await page.waitForSelector('.th-editor-save', { timeout: 4000 });
    const editor = await ctx.probe(page, probeOverlayEmphasis);
    measurements.editorControls = editor;
    failures.push(...overlayVerdict(editor, [], ['save']).failures);
    await save('-save-file');
    await page.locator('.th-editor .th-btn-icon').first().click();
    await page.waitForSelector('.th-editor', { state: 'detached', timeout: 4000 });
    await page.locator('.th-files-head > button.th-btn-icon').click();
    await page.waitForSelector('.th-files', { state: 'detached', timeout: 4000 });
    await drawer(page);
    const row = page.locator('.th-tree-workspace > .th-tree-node').first();
    const coarse = await row.locator('.th-tree-actions--overflow > button').count() > 0;
    if (!coarse) await row.hover(); // inline action must be revealed first.
    const add = coarse ? row.locator('.th-tree-actions--overflow > button')
      : row.locator('.th-tree-actions:not(.th-tree-actions--overflow) > button').nth(1);
    await add.click();
    if (coarse) await row.locator('.th-tree-overflow-item').nth(1).click();
    // The available fixture provider directly creates a chat and shows a
    // success toast. Its request is the toast's own real interaction path.
    await page.waitForSelector('.th-toast--success', { timeout: 4000 });
    await settleFinite(page, '.th-toast--success');
    facts = await ctx.probe(page, probeOverlayEmphasis);
    measurements.toast = facts;
    failures.push(...overlayVerdict(facts, ['toast']).failures);
    await save('-toast');
    return finish(measurements, failures);
  });
}

async function driveQ9(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, measurements = {}, failures = [];
    const capture = async (name, required) => {
      const facts = await ctx.probe(page, probeSecondary);
      measurements[name] = facts;
      failures.push(...secondaryVerdict(facts, required).failures.map(reason => `${name}: ${reason}`));
      await save(`-${name}`);
    };
    const queue = page.locator('.th-queue-header');
    if (await queue.getAttribute('aria-expanded') !== 'true') await queue.click();
    await page.waitForSelector('.th-queue-row', { timeout: 4000 });
    await capture('queue-shelves', ['queue', 'shelf']);

    await page.locator('.th-chat-body').evaluate(element => { element.scrollTop = 0; });
    await page.waitForSelector('.th-chat-msg--user', { state: 'visible', timeout: 4000 });
    await capture('user-bubble', ['user']);

    await page.click('[data-activity-tab="agents"]');
    const agentMounted = page.evaluate(() => window.qaSignal(() =>
      !!document.querySelector('.th-activity-agent-progress')));
    await env.fixture.deliver(CHAT, { type: 'extensionEvent', sessionId: CHAT, name: 'omo.task.updated',
      data: { parent_session_id: CHAT, truncated_tasks: false,
        tasks: [{ task_id: 'q9-progress', name: 'Q9 agent track', status: 'running',
          live_progress: { last_assistant_line: 'Fixture progress' } }] } });
    await agentMounted;
    await capture('agent-progress', ['agents']);

    await drawer(page);
    await page.locator('.th-btn-add').click();
    await page.waitForSelector('.th-wizard-step--current', { timeout: 4000 });
    await capture('wizard', ['wizard']);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.th-wizard-step', { state: 'detached', timeout: 4000 });

    await env.context.route('**/api/system/stats', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ cpuPercent: 22, memUsedBytes: 1024, memTotalBytes: 4096,
        memPercent: 25, numGoroutine: 8, goHeapAllocBytes: 512, uptimeSeconds: 100,
        os: 'darwin', arch: 'arm64', numCpu: 8 }),
    }));
    await drawer(page);
    await page.locator('.th-settings-menu > button').click();
    await page.locator('.th-settings-item').first().click();
    await page.waitForSelector('.th-stats-row', { timeout: 4000 });
    await settleFinite(page, '.th-modal');
    await capture('system-stats', ['stats']);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.th-stats-row', { state: 'detached', timeout: 4000 });

    await env.context.route('**/api/auth/check', route => route.fulfill({ status: 401,
      contentType: 'application/json', body: JSON.stringify({ error: 'qa login fixture' }) }));
    await page.reload();
    await page.waitForSelector('.th-login-card input', { timeout: 4000 });
    await capture('login-card-input', ['login']);
    fail(measurements['login-card-input'].groups.login.length >= 2,
      'Q9 login input or card not measured', failures);
    return finish(measurements, failures);
  });
}

async function driveQ10(ctx) {
  const measurements = {}, failures = [], screenshots = [], teardowns = [];
  for (const layout of ['two', 'h4']) {
    const result = await withFixture(ctx, async (env, save) => {
      const applicability = await ctx.probe(env.page, probeSplitApplicability);
      if (ctx.viewport.width <= 768 && applicability.visibleChats === 1
        && applicability.mountedPanes === 0 && applicability.mountedPickers === 0
        && applicability.splitCount === 0) {
        env.fixture.base.reset({ ...designSeed('empty'), running: [] });
        await env.page.reload();
        await env.page.waitForSelector('.th-empty .th-picker-pane-list', { timeout: 4000 });
        await settleFinite(env.page, '.th-empty');
        const actual = await ctx.probe(env.page, probeEmptyPane);
        const actualState = await ctx.probe(env.page, probeSplitApplicability);
        const actualVerdict = emptyVerdict(actual, 'single');
        fail(actualState.visibleChats === 0 && actualState.splitCount === 0
          && actualState.visiblePickers === 1 && actual.length === 1,
        `Q10 ${layout} expected one visible empty-state picker at ${ctx.viewport.width}px`,
        actualVerdict.failures);
        await save(`-${layout}-single-empty`);
        let operational, operationalResult, operationalTeardown;
        try {
          operational = await ctx.setupLive({ layout, viewport: { width: 1280, height: 900 } });
          await operational.page.waitForSelector('.th-picker-pane-list', { state: 'attached', timeout: 4000 });
          await settleFinite(operational.page, '.th-split');
          const facts = await ctx.probe(operational.page, probeEmptyPane);
          const verdict = emptyVerdict(facts);
          fail(facts.length === (layout === 'h4' ? 3 : 1),
            `Q10 ${layout} operational split has ${facts.length} empty panes`, verdict.failures);
          verdict.pass = verdict.failures.length === 0;
          const file = `Q10-${ctx.theme}-1280x900-${layout}-operational.png`;
          await operational.page.screenshot({ path: join(ctx.shotsDir, file), fullPage: false });
          operationalResult = { ...verdict, measurements: {
            responsive: { requestedLayout: layout, initial: applicability, empty: actualState,
              panes: actual },
            operationalViewport: '1280x900', operational: facts,
          }, screenshots: [`screenshots/${file}`] };
        } finally {
          if (operational) operationalTeardown = await operational.close();
        }
        operationalResult.measurements.operationalTeardown = operationalTeardown;
        fail(operationalTeardown?.contextClosed && operationalTeardown.pendingWebSockets === 0
          && operationalTeardown.original?.pendingWebSockets === 0
          && operationalTeardown.errors?.length === 0,
        `Q10 ${layout} operational fixture did not close cleanly`, operationalResult.failures);
        operationalResult.failures.push(...actualVerdict.failures);
        operationalResult.pass = operationalResult.failures.length === 0;
        return operationalResult;
      }
      await env.page.waitForSelector('.th-picker-pane-list', { state: 'attached', timeout: 4000 });
      const facts = await ctx.probe(env.page, probeEmptyPane);
      const verdict = emptyVerdict(facts);
      await save(`-${layout}`);
      return verdict;
    }, { layout });
    measurements[layout] = result.measurements;
    failures.push(...result.failures.map(reason => `${layout}: ${reason}`));
    screenshots.push(...result.screenshots); teardowns.push(result.teardown);
  }
  const verdict = finish(measurements, failures);
  return { ...verdict, screenshots, teardown: teardowns };
}

async function driveQ14(ctx) {
  return withFixture(ctx, async (env, save) => {
    const update = await dag(env, 'mixed');
    const measurements = {}, failures = [];
    const desktop = ctx.viewport.width === 1280 ? null
      : await ctx.setupLive({ viewport: { width: 1280, height: 900 } });
    try {
      const desktopUpdate = desktop ? await dag(desktop, 'mixed') : null;
      for (const stage of ['mixed', 'dense16', 'dense64']) {
        if (stage !== 'mixed') {
          await update(stage);
          await env.page.waitForFunction(count => document.querySelectorAll('.th-activity-graph [data-node]').length === count,
            t4StageSpec(stage).length, { timeout: 9000 });
          if (desktop) {
            await desktopUpdate(stage);
            await desktop.page.waitForFunction(count =>
              document.querySelectorAll('.th-activity-graph [data-node]').length === count,
            t4StageSpec(stage).length, { timeout: 9000 });
          }
        }
        const facts = await ctx.probe(env.page, probeMobileDag);
        const desktopHeight = desktop
          ? (await ctx.probe(desktop.page, probeMobileDag)).nodes[0]?.card?.height ?? 0
          : facts.nodes[0]?.card?.height ?? 0;
        const verdict = ctx.viewport.width === 390
          ? mobileDagVerdict(facts, desktopHeight, stage)
          : finish(facts, facts.nodes.length === t4StageSpec(stage).length ? [] : [`Q14 ${stage} missing nodes`]);
        measurements[stage] = verdict.measurements;
        failures.push(...verdict.failures);
        if (stage === 'mixed') {
          const state = await ctx.probe(env.page, probeDagGraph, { runningId: 'k6', sourceId: 'k5' });
          const semantic = dagVerdict(state, t4StageRoles(stage), ctx.viewport.width);
          failures.push(...semantic.failures.map(reason => `Q14/Q3 ${reason}`));
          measurements.mixedSemantic = { pass: semantic.pass, nodes: state.nodes, tokens: state.tokens };
        }
        await save(`-${stage}`);
      }
    } finally {
      if (desktop) await desktop.close();
    }
    return finish(measurements, failures);
  });
}

async function driveQ15(ctx) {
  const tools = await withFixture(ctx, async (env, save) => {
    const page = env.page, rows = [];
    for (const id of ['design-read', 'design-running']) {
      const row = page.locator(`[data-tool-call-id="${id}"]`);
      await row.scrollIntoViewIfNeeded();
      const head = row.locator('.th-tool-head');
      if (id === 'design-read' && await head.getAttribute('aria-expanded') !== 'true') await head.click();
      if (id === 'design-running' && await head.getAttribute('aria-expanded') === 'true') await head.click();
      const facts = await ctx.probe(page, probeToolEmphasis);
      rows.push(facts.tools.find(item => item.id === id));
      await save(`-${id}`);
    }
    return phoneToolVerdict({ tools: rows });
  });
  const graph = await withFixture(ctx, async (env, save) => {
    await dag(env, 'mixed');
    const facts = await ctx.probe(env.page, probeMobileDag);
    const failures = [];
    for (const node of facts.nodes) for (const word of node.words)
      fail(!word.clipped && (word.allowed === 0 || word.measured <= word.allowed + 1),
        `Q15 ${node.id} ${word.text} clipped`, failures);
    await save('-graph');
    return finish(facts, failures);
  });
  return { ...finish({ tools: tools.measurements, graph: graph.measurements },
    [...tools.failures, ...graph.failures]), screenshots: [...tools.screenshots, ...graph.screenshots],
  teardown: [tools.teardown, graph.teardown] };
}

async function driveQ17(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, failures = [], measurements = [];
    await env.fixture.deliver(CHAT, { type: 'message', message: { role: 'assistant',
      blocks: [{ kind: 'thinking', id: 'qa-historical-thought', thinking: 'Historical QA reasoning.' }],
      model: 'qa', usage: {}, ts: 1 } });
    await page.waitForSelector('.th-chat-history .th-chat-thinking');
    await env.fixture.deliver(CHAT, {
      type: 'messageDelta', delta: { kind: 'thinking_delta', delta: 'Live QA reasoning.' },
    });
    await page.waitForSelector('.th-chat-live .th-chat-thinking');
    const records = [
      '[data-tool-call-id="design-read"]', '[data-tool-call-id="design-bash"]',
      '[data-tool-call-id="design-failed"]', '.th-chat-history .th-chat-thinking',
      '.th-chat-live .th-chat-thinking', '[data-tool-call-id="design-running"]',
    ];
    const frames = () => page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const [index, selector] of records.entries()) {
      const record = page.locator(selector), head = record.locator('button[aria-expanded]').first();
      await record.scrollIntoViewIfNeeded();
      const initiallyOpen = await head.getAttribute('aria-expanded') === 'true';
      const toggle = async (open, label) => {
        // A near-end record cannot remain at the viewport's top when its
        // collapse makes the entire remaining content shorter than the
        // viewport. Place it at the closest *reachable* anchor before click.
        await page.evaluate(({ selector, open }) => {
          const record = document.querySelector(selector), scroll = document.querySelector('.th-chat-body');
          const head = record?.querySelector('button[aria-expanded]');
          if (!record || !scroll || !head) throw new Error('Q17 disclosure fixture missing');
          const viewport = scroll.getBoundingClientRect(), card = record.getBoundingClientRect();
          const collapsing = !open && head.getAttribute('aria-expanded') === 'true';
          const shrink = collapsing ? Math.max(0, card.height - head.getBoundingClientRect().height) : 0;
          const maxAfter = Math.max(0, scroll.scrollHeight - shrink - scroll.clientHeight);
          const firstReachableTop = card.top + scroll.scrollTop - maxAfter;
          const desired = Math.min(viewport.bottom - head.getBoundingClientRect().height,
            Math.max(viewport.top + 40, firstReachableTop + 3));
          scroll.scrollTop += card.top - desired;
        }, { selector, open });
        await frames();
        const before = await ctx.probe(page, probeDisclosureGeometry, { selector });
        await page.evaluate(selector => document.querySelector(selector)
          ?.querySelector('button[aria-expanded]')?.click(), selector);
        await page.waitForFunction(({ selector, open }) => document.querySelector(selector)
          ?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === String(open), { selector, open });
        await page.evaluate(async selector => {
          const record = document.querySelector(selector);
          const finite = record?.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getComputedTiming()?.iterations !== Infinity) ?? [];
          await Promise.allSettled(finite.map(animation => animation.finished));
        }, selector);
        await frames();
        const after = await ctx.probe(page, probeDisclosureGeometry, { selector });
        const verdict = disclosureVerdict(before, after);
        measurements.push({ record: selector, state: label, ...verdict.measurements });
        failures.push(...verdict.failures.map(failure => `${selector} ${label}: ${failure}`));
        await save(`-${index}-${label}`);
      };
      if (initiallyOpen) await toggle(false, 'initial-collapse');
      await toggle(true, 'expanded');
      await toggle(false, 'collapsed');
    }
    return finish(measurements, failures);
  });
}

async function driveQ18(ctx) {
  return withFixture(ctx, async (env, save) => {
    const page = env.page, failures = [], measurements = [];
    const firstRecord = fixtureOutput.slice(0, 9);
    for (const id of ['design-read', 'design-failed', 'design-running']) {
      const row = page.locator(`[data-tool-call-id="${id}"]`);
      await row.scrollIntoViewIfNeeded();
      const head = row.locator('.th-tool-head');
      if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
      await page.waitForFunction(id => document.querySelector(`[data-tool-call-id="${id}"] .th-tool-output`), id);
      const well = row.locator('.th-tool-output');
      await well.scrollIntoViewIfNeeded();
      const original = await well.textContent();
      const expectedStart = id === 'design-running' ? original.slice(0, 9) : firstRecord;
      const facts = { ...await ctx.probe(page, probeExpandedOutput, { id }),
        paintedGap: await probeOutputPaint(page, id) };
      const verdict = expandedOutputVerdict(facts, expectedStart);
      failures.push(...verdict.failures);
      measurements.push(verdict.measurements);
      await save(`-${id}-open`);
    }
    // Serialized negative controls exercise the same browser probe and
    // verdict against injected DOM failures, then restore the real output.
    const id = 'design-read', well = page.locator(`[data-tool-call-id="${id}"] .th-tool-output`);
    await well.scrollIntoViewIfNeeded();
    const original = await well.textContent();
    try {
      for (const [kind, modified, reason] of [
        ['blank-band', '\n'.repeat(11) + original, 'first text starts'],
        ['mid-record', original.slice(firstRecord.length), 'not the record start'],
      ]) {
        await well.evaluate((element, text) => { element.textContent = text; }, modified);
        const facts = { ...await ctx.probe(page, probeExpandedOutput, { id }),
          paintedGap: await probeOutputPaint(page, id) };
        const verdict = expandedOutputVerdict(facts, firstRecord);
        fail(!verdict.pass && verdict.failures.some(failure => failure.includes(reason)),
          `Q18 ${kind} control did not reject its injected defect`, failures);
      }
    } finally {
      await well.evaluate((element, text) => { element.textContent = text; }, original);
    }
    return finish(measurements, failures);
  });
}

/** Q19 (E33): drawer workspace rows must keep their trailing number at the
 * main-baseline label width, on every theme/width. Runs on the coarse live
 * fixture with 12 "Earlier workspace N" rows; includes a serialized negative
 * control proving a truncated row fails the verdict. */
async function driveQ19(ctx) {
  return withFixture(ctx, async (env, save) => {
    await drawer(env.page);
    const facts = await ctx.probe(env.page, probeWorkspaceLabels);
    const failures = workspaceLabelVerdict(facts).failures;
    const control = workspaceLabelVerdict({ rows: [
      ...Array.from({ length: 12 }, (_, index) => ({
        text: `Earlier workspace ${index + 1}`, box: { width: 130 }, ellipsized: false,
      })),
      { text: 'Earlier workspace 13', box: { width: 96 }, ellipsized: true },
    ] });
    fail(control.failures.some(reason => /ellipsizes|label box/.test(reason)),
      'Q19 control: a row truncated before its number must fail the verdict', failures);
    await save('-drawer');
    return finish({ ...facts, controlFailures: control.failures }, failures);
  }, { touchLive: true, earlierWorkspaces: true });
}

export const scenarios = Object.freeze({
  Q1: driveQ1, Q2: driveQ2, Q3: driveQ3, Q4: driveQ4, Q5: driveQ5,
  Q6: driveQ6, Q7: driveQ7, Q8: driveQ8, Q9: driveQ9, Q10: driveQ10,
  Q14: driveQ14, Q15: driveQ15, Q17: driveQ17, Q18: driveQ18, Q19: driveQ19,
});
