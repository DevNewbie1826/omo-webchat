import { test, expect } from 'bun:test';
import { designAssertions, preservedGeometry, assertAnchor } from './design-workbench-measure.mjs';

function sample({ viewportWidth = 1280, columnWidth = 506, gutter = 24, userTop = 180 } = {}) {
  return {
    viewport: { width: viewportWidth, height: 900 }, documentWidth: viewportWidth,
    readingColumn: { paneWidth: columnWidth, width: columnWidth, maxWidth: 760, gutter },
    rows: [
      { index: 24, content: { top: 100, bottom: 120 }, paddingTop: 0 },
      { index: 25, content: { top: 132, bottom: 152 }, paddingTop: 0 },
      { index: 26, content: { top: userTop, bottom: userTop + 20 }, paddingTop: 0 },
    ],
    tools: ['one', 'two', 'three'].map(id => ({ id, name: 'bash', status: 'Done', glyph: true,
      expanded: 'false', background: 'rgba(0, 0, 0, 0)', borders: [], head: { height: 44 } })),
    edges: Object.fromEntries(['model', 'composer', 'status', 'live'].map(key => [key, { left: 24, right: columnWidth - 24 }])),
    historyAxis: 24, liveAxis: 24, roles: [],
    panes: [{ active: true, outline: '1px solid rgb(1, 1, 1)' }],
    composer: { bottom: 900 }, trigger: { top: 800, bottom: 830 }, coarse: false,
  };
}
const assertion = (value, id) => designAssertions(value).find(result => result.id === id);

test('turn rhythm accepts larger rendered gaps without larger user padding', () => {
  // Given equally padded adjacent rendered assistant/assistant/user content.
  const value = sample();
  // When measuring a 28px new-turn gap against a 12px continuation gap.
  const result = assertion(value, 'new-turn-spacing');
  // Then the geometry, not the padding mechanism, establishes the hierarchy.
  expect(result.pass).toBe(true);
  expect(result.actual).toEqual({ newTurnGap: 28, withinAssistantGap: 12 });
});

test('larger user padding alone cannot pass equal content-to-content gaps', () => {
  const value = sample({ userTop: 164 });
  value.rows[2].paddingTop = 32;
  const result = assertion(value, 'new-turn-spacing');
  expect(result.pass).toBe(false);
  expect(result.actual).toEqual({ newTurnGap: 12, withinAssistantGap: 12 });
});

test('expected gutter RED follows a narrow desktop pane rather than viewport width', () => {
  const result = assertion(sample({ viewportWidth: 1900, columnWidth: 506 }), 'local-gutters');
  expect(result.expectedBefore).toBe(true);
  expect(result.actual.beforeEdgeDelta).toBe(24);
  // Expected-before classification is independent of the observed edge result.
  expect(result.pass).toBe(true);
});

test('wide local columns and the one-pixel boundary do not expect gutter RED', () => {
  for (const columnWidth of [806, 808, 1016]) {
    expect(assertion(sample({ columnWidth }), 'local-gutters').expectedBefore).toBe(false);
  }
  expect(assertion(sample({ columnWidth: 805 }), 'local-gutters').expectedBefore).toBe(true);
});

test('pane-local gutter overrides determine expected mismatch', () => {
  const result = assertion(sample({ viewportWidth: 390, columnWidth: 390, gutter: 12 }), 'local-gutters');
  expect(result.expectedBefore).toBe(true);
  expect(result.actual.beforeEdgeDelta).toBe(12);
});

test('coarse tool target is guarded separately from reading rhythm', () => {
  const value = sample(); value.coarse = true;
  expect(() => preservedGeometry(value)).not.toThrow();
  value.tools[0].head.height = 43;
  expect(() => preservedGeometry(value)).toThrow();
  expect(assertion(value, 'new-turn-spacing').pass).toBe(true);
});

test('missing rendered comparison rows are unexpected failures, not design RED', () => {
  const value = sample(); value.rows.pop();
  expect(() => designAssertions(value)).toThrow();
});


test('visible anchor ignores compensated virtual coordinates but rejects real motion and lost content', () => {
  const before = { key: '23', index: 0, fragment: 2, text: 'visible line', top: 30, left: 24 };
  expect(() => assertAnchor(before, { ...before })).not.toThrow();
  expect(() => assertAnchor(before, { ...before, top: 268 })).toThrow();
  expect(() => assertAnchor(before, { ...before, key: '24' })).toThrow();
  expect(() => assertAnchor(before, null)).toThrow();
});
