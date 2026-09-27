/** Read-only production DOM probes and binary count/qualification oracle. */
import assert from 'node:assert/strict';
import { stages } from './dag-summary-fixture.mjs';
export { armDOM, doneDOM } from './task-state-ordering.mjs';

export function readSummaryDOM() {
  const sidebar = [...document.querySelectorAll('.th-tree-node')].find(node =>
    node.querySelector('.th-tree-activation .th-tree-label')?.textContent === 'Stored A');
  const overview = [...document.querySelectorAll('.th-overview-card')].find(node =>
    node.querySelector('.th-overview-card-name')?.textContent?.startsWith('Stored A'));
  const cardName = overview?.querySelector('.th-overview-card-name')?.textContent;
  function badge(node) {
    if (!node) return null;
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { text: node.textContent.trim(), aria: node.getAttribute('aria-label'), box: box.toJSON(),
      visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }), hit: !!hit && node.contains(hit) };
  }
  const transcript = document.querySelector('.th-chat-body');
  return { sidebar: badge(sidebar?.querySelector('.th-tree-running')),
    overview: badge(overview?.querySelector('.th-overview-card-running')),
    rows: { sidebar: badge(sidebar), overview: badge(overview) },
    marker: overview?.querySelector('.th-overview-card-line')?.textContent
      ?? (cardName?.startsWith('Stored A | ') ? cardName.slice('Stored A | '.length) : null),
    viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
    transcript: transcript && { height: transcript.scrollHeight, client: transcript.clientHeight, top: transcript.scrollTop },
    drawerHidden: document.querySelector('.th-sidebar')?.getAttribute('aria-hidden') === 'true' };
}

/** Compare exact server-side running counts with shipped accessible names.
 * Truncated topology no longer qualifies an authoritative live-row scalar.
 */
export function assertSummaryDOM(dom, stage, copy, surfaces = ['sidebar', 'overview']) {
  assert.ok(stages.includes(stage), `Unknown summary stage: ${stage}`);
  const zero = stage === 'canceled-retained-running2' || stage === 'incomplete-retained0';
  const result = {};
  for (const surface of surfaces) {
    const badge = dom[surface];
    if (zero) {
      assert.ok(dom.rows?.[surface], `${surface}: zero-running session must remain mounted`);
      assert.equal(badge, null, `${surface}: authoritative zero must yield the shipped absent running badge`);
      result[surface] = { qualified: false, unknown: false, exact2: false, falseExact: false,
        impliesZero: true, zeroRunning: true, text: null, aria: null };
      continue;
    }
    assert.ok(badge, `${surface}: running badge must not disappear`);
    const prefix = surface === 'sidebar' ? 'sidebar.tm.runningAgents' : 'overview.runningAria';
    assert.equal(badge.text, '2', `${surface}: ${stage} must display the exact pre-truncation count`);
    assert.equal(badge.aria, copy[prefix].replace('{n}', '2'), `${surface}: accessible count matches visible count`);
    result[surface] = { qualified: false, unknown: false, exact2: true, falseExact: false,
      impliesZero: false, zeroRunning: false, text: badge.text, aria: badge.aria };
  }
  return result;
}

export function assertVisibleBadge(dom, surface, stage) {
  const target = stage === 'canceled-retained-running2' || stage === 'incomplete-retained0'
    ? dom.rows?.[surface] : dom[surface], box = target?.box;
  assert.ok(target?.visible && target.hit && box.width > 0 && box.height > 0,
    `${surface}: visible unobscured count or zero-running session`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.right <= dom.viewport.width + 1 && box.bottom <= dom.viewport.height + 1,
    `${surface}: count or zero-running session fits viewport`);
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
