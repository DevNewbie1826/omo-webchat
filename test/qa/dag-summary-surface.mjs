/** Read-only production DOM probes and binary count/qualification oracle. */
import assert from 'node:assert/strict';
import { stages } from './dag-summary-fixture.mjs';
export { armDOM, doneDOM } from './task-state-ordering.mjs';

export function readSummaryDOM() {
  const sidebar = [...document.querySelectorAll('.th-tree-node')].find(node =>
    node.querySelector('.th-tree-activation .th-tree-label')?.textContent === 'Stored A');
  const overview = [...document.querySelectorAll('.th-overview-card')].find(node =>
    node.querySelector('.th-overview-card-name')?.textContent === 'Stored A');
  function badge(node) {
    if (!node) return null;
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { text: node.textContent.trim(), aria: node.getAttribute('aria-label'), box: box.toJSON(),
      visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }), hit: !!hit && node.contains(hit) };
  }
  const transcript = document.querySelector('.th-chat-body');
  return { sidebar: badge(sidebar?.querySelector('.th-tree-running')),
    overview: badge(overview?.querySelector('.th-overview-card-running')),
    marker: overview?.querySelector('.th-overview-card-line')?.textContent ?? null,
    viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
    transcript: transcript && { height: transcript.scrollHeight, client: transcript.clientHeight, top: transcript.scrollTop },
    drawerHidden: document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true' };
}

/** Compare accessible names with shipped translations, not pinned prose.
 * '?' and the numeric '+' lower-bound sentinel are the existing UI protocol.
 */
export function assertSummaryDOM(dom, stage, copy, surfaces = ['sidebar', 'overview']) {
  assert.ok(stages.includes(stage), `Unknown summary stage: ${stage}`);
  const exact = ['complete2', 'compact-duplicate-ids', 'complete2-recovery'].includes(stage);
  const expected = exact ? '2' : stage === 'compact-no-ids' ? '?' : stage === 'compact-mixed-ids' ? '1+' : null;
  const result = {};
  for (const surface of surfaces) {
    const badge = dom[surface]; assert.ok(badge, `${surface}: running badge must not disappear`);
    const prefix = surface === 'sidebar' ? 'sidebar.tm.runningAgents' : 'overview.runningAria';
    const unknown = badge.text === '?', lowerBound = /^[1-9]\d*\+$/.test(badge.text);
    const count = Number.parseInt(badge.text, 10), qualified = unknown || lowerBound;
    const key = prefix + (unknown ? 'Unknown' : lowerBound ? 'Partial' : '');
    assert.equal(badge.aria, copy[key].replace('{n}', String(count)), `${surface}: accessible qualification matches visible count`);
    if (expected !== null) assert.equal(badge.text, expected, `${surface}: ${stage} must yield ${expected}`);
    else {
      assert.ok(qualified, `${surface}: incomplete data must be visibly qualified, never exact1/zero`);
      if (lowerBound) assert.ok(count <= 2, `${surface}: lower bound cannot exceed the full two-node fixture`);
    }
    result[surface] = { qualified, unknown, exact2: badge.text === '2', falseExact: !exact && !qualified,
      impliesZero: badge.text === '0', text: badge.text, aria: badge.aria };
  }
  return result;
}

export function assertVisibleBadge(dom, surface) {
  const badge = dom[surface], box = badge?.box;
  assert.ok(badge?.visible && badge.hit && box.width > 0 && box.height > 0, `${surface}: visible unobscured count`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.right <= dom.viewport.width + 1 && box.bottom <= dom.viewport.height + 1,
    `${surface}: count fits viewport`);
  assert.ok(dom.documentWidth <= dom.viewport.width, 'no horizontal document overflow');
}

export async function settleCapture(page) {
  return page.evaluate(async () => {
    let timer;
    try {
      return await Promise.race([(async () => {
        await document.fonts.ready;
        const animations = document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)
          && !['finished', 'idle'].includes(a.playState));
        await Promise.all(animations.map(a => a.finished));
        await new Promise(requestAnimationFrame);
        return { fonts: document.fonts.status, finiteAnimations: animations.length };
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Summary capture deadline')), 15000); })]);
    } finally { clearTimeout(timer); }
  });
}
