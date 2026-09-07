import assert from 'node:assert/strict';

/** Read computed styles/geometry only. Semantic colors are resolved without DOM/style mutation. */
export async function measure(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.th-chat-pane');
    const box = element => element?.getBoundingClientRect().toJSON();
    const rect = selector => box(pane.querySelector(selector));
    const root = getComputedStyle(document.documentElement);
    const token = name => root.getPropertyValue(name).trim();
    const color = value => /^#[\da-f]{6}$/i.test(value)
      ? `rgb(${[1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).join(', ')})` : value;
    const roles = [['.th-chat-pane', '--th-bg'], ['.th-termhead', '--th-surface'],
      ['.th-chat-input-inner', '--th-surface'], ['.th-sidebar', innerWidth <= 768 ? '--th-surface-overlay' : '--th-surface'],
      ['.th-model-picker-popover', document.querySelector('.th-model-picker-popover--sheet') ? '--th-surface-overlay' : '--th-surface-raised']]
      .map(([selector, name]) => { const element = document.querySelector(selector);
        return { selector, token: name, expected: color(token(name)), actual: element && getComputedStyle(element).backgroundColor }; });
    const rows = [...pane.querySelectorAll('.th-chat-row')].map(element => {
      const css = getComputedStyle(element);
      return { index: Number(element.dataset.index), className: element.className, rect: box(element), content: box(element.querySelector('.th-chat-msg')),
        paddingTop: parseFloat(css.paddingTop), paddingBottom: parseFloat(css.paddingBottom) };
    });
    const tools = [...pane.querySelectorAll('.th-tool')].map(element => {
      const css = getComputedStyle(element), head = element.querySelector('.th-tool-head');
      return { id: element.dataset.toolCallId, name: element.querySelector('.th-tool-name').textContent,
        status: element.querySelector('.th-tool-status').textContent, glyph: !!element.querySelector('.th-tool-glyph'),
        expanded: head.getAttribute('aria-expanded'), rect: box(element), head: box(head),
        background: css.backgroundColor, borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => ({
          width: parseFloat(css[`border${side}Width`]), style: css[`border${side}Style`], color: css[`border${side}Color`] })),
        output: box(element.querySelector('.th-tool-output')) };
    });
    const assistant = pane.querySelector('.th-chat-msg--assistant');
    const column = pane.querySelector('.th-chat-main'), columnStyle = getComputedStyle(column);
    return { readingColumn: { paneWidth: pane.clientWidth, width: column.clientWidth,
      maxWidth: parseFloat(columnStyle.getPropertyValue('--th-chat-max')),
      gutter: parseFloat(columnStyle.getPropertyValue('--th-chat-gutter')) }, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      theme: document.documentElement.dataset.theme, fontSize: assistant && getComputedStyle(assistant).fontSize,
      coarse: matchMedia('(pointer: coarse)').matches, rows, tools, roles,
      tokens: Object.fromEntries(['--th-bg', '--th-surface', '--th-surface-raised', '--th-surface-overlay', '--th-border-strong', '--th-chat-gutter'].map(name => [name, token(name)])),
      // Only full reading bands share both edges; status occupies the row's remaining space.
      edges: { controls: rect('.th-chat-controls'), composer: rect('.th-chat-input-inner'), live: rect('.th-chat-live') },
      status: rect('.th-chat-status'),
      historyAxis: rect('.th-chat-row--assistant .th-chat-markdown')?.left, liveAxis: rect('.th-chat-msg--streaming .th-chat-markdown')?.left,
      panes: [...document.querySelectorAll(document.querySelector('.th-pane-wrap') ? '.th-pane-wrap' : '.th-chat-pane')].map(element => ({ id: element.dataset.paneId, rect: box(element),
        active: element.matches('.th-pane--focused') || !!element.querySelector('.th-pane--focused'),
        outline: getComputedStyle(element.querySelector('.th-pane--focused') ?? element).outline })),
      scroll: { body: pane.querySelector('.th-chat-body').scrollTop, outer: pane.querySelector('.th-chat-main-content').scrollTop },
      send: rect('.th-chat-send-btn'), composer: rect('.th-chat-input'), trigger: rect('.th-model-picker-btn'),
    };
  });
}

export function preservedGeometry(sample) {
  assert(sample.documentWidth <= sample.viewport.width, 'document has no horizontal overflow');
  assert.equal(sample.panes.filter(pane => pane.active).length, 1, 'exactly one active pane');
  assert(sample.panes.find(pane => pane.active).outline.includes('solid'), 'active outline remains visible');
  assert(sample.composer.bottom <= sample.viewport.height + 1, 'composer stays in viewport');
  assert(sample.trigger.top >= 0 && sample.trigger.bottom <= sample.composer.bottom, 'model control remains above input');
  assert(sample.tools.every(tool => tool.name && tool.status && tool.glyph), 'individual tool names and status text/glyphs');
  assert.equal(new Set(sample.tools.map(tool => tool.id)).size, sample.tools.length, 'one record per invocation');
  assert(sample.rows.every((row, i) => !i || row.index > sample.rows[i - 1].index), 'transcript order preserved');
  if (sample.coarse) for (const tool of sample.tools) assert(tool.head.height >= 44, 'coarse-pointer tool target >=44px');
}

/** The only expected REDs are specific design predicates, never caught runtime/behavior errors. */
export function designAssertions(sample) {
  const collapsed = sample.tools.filter(tool => tool.expanded === 'false');
  assert(collapsed.length >= 3, 'design enclosure evidence requires multiple collapsed records');
  const continuation = sample.rows.find(row => row.index === 24);
  const assistant = sample.rows.find(row => row.index === 25);
  const user = sample.rows.find(row => row.index === 26);
  assert(user?.content && assistant?.content && continuation?.content, 'turn rhythm requires the actual adjacent assistant/assistant/user rows');
  const newTurnGap = user.content.top - assistant.content.bottom;
  const withinAssistantGap = assistant.content.top - continuation.content.bottom;
  const edgeValues = ['controls', 'composer', 'live'].map(key => sample.edges[key]);
  assert(edgeValues.every(Boolean), 'all local reading-column controls must exist');
  assert(sample.status, 'partial-width status region must exist');
  assert(Number.isFinite(sample.trigger.right) && Math.abs(sample.trigger.right - sample.edges.composer.right) <= 2,
    'model trigger right edge aligns with the input capsule edge');
  assert(Number.isFinite(sample.historyAxis) && Number.isFinite(sample.liveAxis), 'both live and history prose must render');
  const gutterDelta = Math.max(...edgeValues.map(rect => rect.left)) - Math.min(...edgeValues.map(rect => rect.left));
  const rightDelta = Math.max(...edgeValues.map(rect => rect.right)) - Math.min(...edgeValues.map(rect => rect.right));
  const { width, maxWidth, gutter } = sample.readingColumn;
  assert([width, maxWidth, gutter].every(Number.isFinite), 'gutter baseline requires measured local column dimensions');
  // Old CSS centers min(max, 100%) model chrome against min(max, 100% -
  // two gutters) composer chrome. Predict its RED from local geometry, not
  // viewport breakpoints or the observed edge assertion's own result.
  const beforeEdgeDelta = (Math.min(maxWidth, width) - Math.min(maxWidth, width - 2 * gutter)) / 2;
  return [
    { id: 'collapsed-enclosure', pass: collapsed.every(tool => tool.background === 'rgba(0, 0, 0, 0)'
      && !tool.borders.every(border => border.width > 0 && border.style !== 'none')), expectedBefore: true,
      actual: collapsed.map(tool => ({ id: tool.id, background: tool.background, borders: tool.borders })) },
    { id: 'new-turn-spacing', pass: newTurnGap > withinAssistantGap, expectedBefore: true,
      actual: { newTurnGap, withinAssistantGap } },
    { id: 'local-gutters', pass: gutterDelta <= 1 && rightDelta <= 1, expectedBefore: beforeEdgeDelta > 1,
      actual: { leftDelta: gutterDelta, rightDelta, edges: sample.edges, readingColumn: sample.readingColumn, beforeEdgeDelta } },
    { id: 'live-history-axis', pass: Math.abs(sample.historyAxis - sample.liveAxis) <= 1, expectedBefore: false,
      actual: { history: sample.historyAxis, live: sample.liveAxis } },
    { id: 'semantic-surfaces', pass: sample.roles.filter(role => role.actual).every(role => role.actual === role.expected), expectedBefore: false,
      actual: sample.roles },
  ];
}

/** Complete model rows must lie inside every clipping ancestor and accept a real hit. */
export async function modelRows(page) {
  return page.evaluate(() => {
    const popup = document.querySelector('.th-model-picker-popover');
    return [...popup.querySelectorAll('[role="option"]')].map(element => {
      const rect = element.getBoundingClientRect();
      let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) { top = Math.max(top, clip.top + ancestor.clientTop); bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight); }
        if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      }
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { text: element.textContent, rect: rect.toJSON(), complete: rect.top >= top - .5 && rect.bottom <= bottom + .5 && rect.left >= left - .5 && rect.right <= right + .5,
        hit: element === hit || element.contains(hit) };
    });
  });
}

/** A visible text fragment, not a virtual row's potentially offscreen origin. */
export async function contentAnchor(page, anchor = null) {
  return page.evaluate(anchor => {
    const port = document.querySelector('.th-chat-scrollport').getBoundingClientRect();
    const owners = [...document.querySelectorAll('.th-chat-row, .th-chat-live')];
    for (const owner of owners) {
      const key = owner.dataset.index ?? 'live';
      if (anchor && key !== anchor.key) continue;
      const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
      let node, ordinal = 0;
      while ((node = walker.nextNode())) {
        const index = ordinal++;
        if (anchor && index !== anchor.index) continue;
        if (!node.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        for (let fragment = 0; fragment < rects.length; fragment++) {
          const rect = rects[fragment];
          if (anchor ? fragment === anchor.fragment : rect.height > 0 && rect.top >= port.top && rect.bottom <= port.bottom && rect.right > port.left && rect.left < port.right) {
            return { key, index, fragment, text: node.textContent, top: rect.top - port.top, left: rect.left - port.left };
          }
        }
      }
    }
    return null;
  }, anchor);
}

export function assertAnchor(before, after) {
  assert(before && after, 'visible transcript anchor must remain mounted');
  for (const key of ['key', 'index', 'fragment', 'text']) assert.equal(after[key], before[key], 'same visible content anchor');
  assert(Math.abs(after.top - before.top) <= 1 && Math.abs(after.left - before.left) <= 1,
    `visible transcript anchor moved: ${JSON.stringify({ before, after })}`);
}
