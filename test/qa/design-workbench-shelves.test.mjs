import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { installSignals, armShelf, complete } from './design-workbench-fixture.mjs';
import { assertShelfAllocation } from './design-workbench-controls.mjs';

const { JSDOM } = createRequire(new URL('../../frontend/package.json', import.meta.url))('jsdom');

async function shelfDOM(kind, columnHeight) {
  // Real DOM mutations/MutationObserver; only layout (not implemented by jsdom) is supplied.
  const dom = new JSDOM(`<div class="th-chat-main" data-height="${columnHeight}">
    <div class="th-chat-main-content"><div class="th-chat-scrollport"></div>
      <section class="th-${kind}-shelf"><div class="th-activity-bar-row" data-height="32">
        <button aria-expanded="false"><span class="th-activity-caret"></span></button>
      </div></section>
    </div><footer data-height="20"></footer></div>`, { url: 'http://fixture.test', runScripts: 'outside-only' });
  const { window } = dom;
  const resizing = new Set();
  window.ResizeObserver = class {
    observe() { resizing.add(this); }
    disconnect() { resizing.delete(this); }
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return new window.DOMRect(0, 0, 200, Number(this.dataset.height ?? 0));
  };
  const page = {
    async addInitScript(fn, arg) { window.eval(`(${fn})(${JSON.stringify(arg)})`); },
    async evaluate(fn, arg) { return window.eval(`(${fn})(${JSON.stringify(arg)})`); },
  };
  await installSignals(page);
  const shelf = window.document.querySelector(`.th-${kind}-shelf`);
  async function transition({ requested, applied, expanded, height = null }) {
    // Subscribe to this exact mutation delivery, not an elapsed-time or polling barrier.
    const delivered = new Promise(resolve => {
      const observer = new window.MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(shelf, { subtree: true, childList: true, attributes: true });
    });
    // The activity shelf carries its disclosure state on the root, exactly
    // like the SPA (data-open / data-expanded); the goal shelf keeps the
    // caret and aria-expanded on its bar button.
    if (kind === 'activity') {
      shelf.dataset.open = String(requested);
      shelf.dataset.expanded = String(expanded);
    } else {
      shelf.querySelector('.th-activity-caret').classList.toggle('th-activity-caret--open', requested);
      shelf.querySelector('button').setAttribute('aria-expanded', String(expanded));
    }
    shelf.style.flexShrink = applied ? '0' : '';
    shelf.querySelector(`.th-${kind}-panel`)?.remove();
    if (height !== null) {
      const panel = window.document.createElement('div');
      panel.className = `th-${kind}-panel`; panel.dataset.height = String(height);
      if (applied) panel.style.maxHeight = `${height}px`;
      shelf.append(panel);
    }
    await delivered;
    // Drain the completion reaction produced by that delivery, if it incorrectly resolved.
    await Promise.resolve();
  }
  return { page, transition, resizing, close: () => window.close() };
}

for (const kind of ['goal', 'activity']) {
  test(`${kind} cannot complete on transient open before allocation, then records constrained refusal`, async () => {
    const q = await shelfDOM(kind, 200);
    let completed = false;
    try {
      // Given a closed shelf, subscribe before the open action.
      await armShelf(q.page, kind, true);
      const pending = complete(q.page).then(state => { completed = true; return state; });
      // When intent renders an unallocated panel before the effect-driven refusal.
      await q.transition({ requested: true, applied: false, expanded: true, height: 100 });
      try { expect(completed).toBe(false); }
      finally { await q.transition({ requested: true, applied: true, expanded: false }); }
      // Then only the settled allocation is accepted, preserving the entire causal sequence.
      const state = await pending;
      assertShelfAllocation(state);
      expect(state.budget).toBe(28);
      expect(state.panel).toBeNull();
      expect(state.observations.map(s => [s.expanded, !!s.panel, s.requestedOpen, s.allocationApplied])).toEqual([
        ['false', false, false, false], ['true', true, true, false], ['false', false, true, true],
      ]);
      expect(q.resizing.size).toBe(0);
    } finally { q.close(); }
  });

  test(`${kind} retains normal expansion and awaits intent clearing plus allocator release on collapse`, async () => {
    const q = await shelfDOM(kind, 400);
    let collapsed = false;
    try {
      await armShelf(q.page, kind, true);
      await q.transition({ requested: true, applied: true, expanded: true, height: 180 });
      const opened = await complete(q.page);
      assertShelfAllocation(opened);
      expect(opened.budget).toBe(228);
      expect(opened.panel.height).toBe(180);
      // Given an allocated shelf, subscribe before the collapse action.
      await armShelf(q.page, kind, false);
      const pending = complete(q.page).then(state => { collapsed = true; return state; });
      // When the panel unmounts but the allocator has not released its old value.
      await q.transition({ requested: false, applied: true, expanded: false });
      try { expect(collapsed).toBe(false); }
      finally { await q.transition({ requested: false, applied: false, expanded: false }); }
      // Then the next action starts without stale open intent or applied allocation.
      const closed = await pending;
      expect(closed.requestedOpen).toBe(false);
      expect(closed.allocationApplied).toBe(false);
      expect(closed.panel).toBeNull();
      expect(q.resizing.size).toBe(0);
    } finally { q.close(); }
  });
}

test('allocation guard rejects wrong refusal, hidden panels, slivers and over-budget expansion', () => {
  const roomy = { requestedOpen: true, allocationApplied: true, budget: 100, expanded: 'true', panel: { height: 80 }, panelMax: 80 };
  const refused = { ...roomy, budget: 47, expanded: 'false', panel: null, panelMax: null };
  expect(() => assertShelfAllocation(roomy)).not.toThrow();
  expect(() => assertShelfAllocation(refused)).not.toThrow();
  for (const state of [
    { ...roomy, allocationApplied: false }, { ...roomy, requestedOpen: false },
    { ...roomy, expanded: 'false', panel: null }, { ...refused, panel: { height: 20 } },
    { ...roomy, panel: { height: 47 } }, { ...roomy, panel: { height: 102 }, panelMax: 102 },
    { ...roomy, panel: { height: 82 } }, { ...roomy, budget: 47 },
  ]) expect(() => assertShelfAllocation(state)).toThrow();
});
