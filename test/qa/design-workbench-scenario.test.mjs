import { test, expect } from 'bun:test';
import { singleScenario, scenarioRunner } from './design-workbench.mjs';
import { collectDesignReds } from './design-workbench-measure.mjs';

/** Measurement fixture satisfying every designAssertions/preservedGeometry
 * precondition; the collapsed-enclosure predicate is driven to a RED by an
 * opaque tool-card background, exactly like the deferred T2 restyle. */
function sample({ viewportWidth = 1280, columnWidth = 506, gutter = 24, userTop = 180, fontSize = '14px', enclosed = false } = {}) {
  const bandWidth = Math.min(760, columnWidth - 2 * gutter);
  const left = (columnWidth - bandWidth) / 2, right = left + bandWidth;
  return {
    viewport: { width: viewportWidth, height: 900 }, documentWidth: viewportWidth, fontSize,
    readingColumn: { paneWidth: columnWidth, width: columnWidth, maxWidth: 760, gutter },
    rows: [
      { index: 24, content: { top: 100, bottom: 120 }, paddingTop: 0 },
      { index: 25, content: { top: 132, bottom: 152 }, paddingTop: 0 },
      { index: 26, content: { top: userTop, bottom: userTop + 20 }, paddingTop: 0 },
    ],
    tools: ['one', 'two', 'three'].map((id, index) => ({ id, name: 'bash', status: 'Done', glyph: true,
      expanded: 'false', background: enclosed && index === 0 ? 'rgb(29, 30, 34)' : 'rgba(0, 0, 0, 0)',
      borders: ['Top', 'Right', 'Bottom', 'Left'].map(() => ({ width: 0, style: 'solid', color: 'rgba(0, 0, 0, 0)' })),
      head: { height: 44 } })),
    edges: Object.fromEntries(['controls', 'composer', 'live'].map(key => [key, { left, right }])),
    status: { left, right: right - 108, top: 800, bottom: 830 },
    historyAxis: left, liveAxis: left, roles: [],
    panes: [{ active: true, outline: viewportWidth <= 768 ? 'none' : '1px solid rgb(1, 1, 1)' }],
    composer: { bottom: 900 }, trigger: { left: right - 100, right, top: 800, bottom: 830 }, coarse: false,
  };
}

/** Page-boundary fake: real arm/complete/measure/wheel code runs against it,
 * with canned measurements standing in for the rendered App. */
function fakePage(canned) {
  const fakeWindow = {}, order = [];
  const head = { getAttribute: async () => 'true', click: async () => { order.push('failure-head-click'); } };
  const body = { evaluate: async () => { fakeWindow.qaPending = Promise.resolve(true); },
    boundingBox: async () => ({ x: 0, y: 0, width: 400, height: 600 }) };
  const page = {
    locator: selector => selector.includes('design-failed') ? head : body,
    mouse: { move: async () => {}, wheel: async () => {} },
    screenshot: async () => { order.push('screenshot'); },
    async evaluate(fn, arg) {
      const source = String(fn);
      if (arg !== undefined) { fakeWindow.qaPending = Promise.resolve(true); return undefined; } // arm
      if (source.includes('qaPending')) return fakeWindow.qaPending ?? Promise.resolve(true);   // complete
      return canned();                                                                          // measure
    },
  };
  return { page, order };
}

function scenarioContext(record, { enclosed = true, fontSize = '14px' } = {}) {
  const saved = [];
  return { saved,
    ctx: { name: 'single-dark-1280', phase: 'after', width: 1280,
      save: async name => { saved.push(name); }, record },
    sample: () => sample({ enclosed, fontSize }) };
}

test('a failing design predicate is recorded, not thrown, so the following behaviour steps still run', async () => {
  const record = {};
  const { ctx, saved } = scenarioContext(record);
  const { page, order } = fakePage(() => sample({ enclosed: true }));
  const behaviour = {
    exerciseControls: async () => {
      // The RED must already be recorded when behaviour starts, proving the
      // design verdict neither threw nor blocked this step.
      expect(record.designReds.map(red => red.id)).toEqual(['collapsed-enclosure']);
      order.push('exerciseControls'); return 'CONTROLS';
    },
    auxiliarySurfaces: async () => { order.push('auxiliarySurfaces'); },
  };
  const detail = await singleScenario({ page }, async suffix => { order.push(`shot:${suffix}`); }, ctx, behaviour);
  expect(detail.designReds).toHaveLength(1);
  expect(detail.designReds[0]).toMatchObject({ id: 'collapsed-enclosure', observedPass: false, phaseExpectedPass: true });
  expect(detail.designReds[0].actual).toHaveLength(3); // measurements of every collapsed record
  expect(detail.controls).toBe('CONTROLS');
  expect(order).toEqual(['shot:failure-open', 'failure-head-click', 'shot:collapsed', 'shot:history-top', 'exerciseControls', 'auxiliarySurfaces']);
  expect(saved).toContain('single-dark-1280-measurements.json');
  expect(saved).toContain('single-dark-1280-assertions.json');
});

test('a passing design surface records no REDs and behaviour still completes', async () => {
  const record = {};
  const { ctx } = scenarioContext(record);
  const { page } = fakePage(() => sample({ enclosed: false }));
  const behaviour = {
    exerciseControls: async () => 'CONTROLS',
    auxiliarySurfaces: async () => {},
  };
  const detail = await singleScenario({ page }, async () => {}, ctx, behaviour);
  expect(detail.designReds).toEqual([]);
  expect(record.designReds).toEqual([]);
});

test('a failing behaviour step still rejects the scenario and retains the recorded REDs', async () => {
  const record = {};
  const { ctx } = scenarioContext(record);
  const { page } = fakePage(() => sample({ enclosed: true }));
  const behaviour = {
    exerciseControls: async () => { throw new Error('behaviour step failed'); },
    auxiliarySurfaces: async () => { throw new Error('must not run'); },
  };
  await expect(singleScenario({ page }, async () => {}, ctx, behaviour)).rejects.toThrow('behaviour step failed');
  expect(record.designReds.map(red => red.id)).toEqual(['collapsed-enclosure']);
});

test('behaviour assertions still throw on their own failure', async () => {
  const record = {};
  const { ctx } = scenarioContext(record, { fontSize: '13px', enclosed: true });
  const { page } = fakePage(() => sample({ fontSize: '13px', enclosed: true }));
  const behaviour = { exerciseControls: async () => {}, auxiliarySurfaces: async () => {} };
  await expect(singleScenario({ page }, async () => {}, ctx, behaviour)).rejects.toThrow('user font setting is honored');
});

function runnerHarness(canned) {
  const { page } = fakePage(canned);
  const results = [], screenshots = [], traffic = [], cleanup = [], saved = [];
  const q = { page, errors: [], fixture: { requests: ['request'], frames: ['frame'], unexpected: [] },
    close: async () => ({ contextClosed: true }) };
  const scenario = scenarioRunner({ setup: async () => q, save: async name => { saved.push(name); },
    evidence: '/tmp/design-workbench-scenario-test', results, screenshots, traffic, cleanup });
  return { scenario, results, screenshots, traffic, cleanup, saved, q };
}

test('scenario record shows behaviourPass and design REDs distinctly; REDs alone pass', async () => {
  const h = runnerHarness(() => sample());
  await h.scenario('single-dark-1280', {}, async (q, shot, record) => {
    record.designReds = [{ id: 'collapsed-enclosure', observedPass: false, actual: [] }];
    await shot('collapsed');
    return { controls: ['kept'] };
  });
  expect(h.results[0]).toMatchObject({ scenario: 'single-dark-1280', pass: true, behaviourPass: true, controls: ['kept'] });
  expect(h.results[0].designReds.map(red => red.id)).toEqual(['collapsed-enclosure']);
  expect(h.saved).toContain('single-dark-1280-collapsed.json');
  expect(h.saved).toContain('results.json');
  expect(h.traffic[0].scenario).toBe('single-dark-1280');
  expect(h.cleanup[0].contextClosed).toBe(true);
});

test('a failing behaviour step fails the scenario while keeping its recorded design REDs', async () => {
  const h = runnerHarness(() => sample());
  await h.scenario('single-light-1280', {}, async (q, shot, record) => {
    record.designReds = [{ id: 'collapsed-enclosure', observedPass: false, actual: [] }];
    throw new Error('behaviour failed');
  });
  expect(h.results[0]).toMatchObject({ scenario: 'single-light-1280', pass: false, behaviourPass: false });
  expect(h.results[0].designReds.map(red => red.id)).toEqual(['collapsed-enclosure']);
  expect(h.results[0].error).toContain('behaviour failed');
  expect(h.saved).toContain('single-light-1280-FAIL-measurements.json');
  expect(h.screenshots.some(path => path.endsWith('single-light-1280-FAIL.png'))).toBe(true);
});

test('browser exceptions and unexpected traffic still fail the scenario', async () => {
  const errors = runnerHarness(() => sample());
  errors.q.errors.push('page error');
  await errors.scenario('layout-two', {}, async () => ({}));
  expect(errors.results[0].behaviourPass).toBe(false);
  expect(errors.results[0].error).toContain('no browser exceptions');

  const unexpected = runnerHarness(() => sample());
  unexpected.q.fixture.unexpected.push('POST /unexpected');
  await unexpected.scenario('layout-h4', {}, async () => ({}));
  expect(unexpected.results[0].behaviourPass).toBe(false);
  expect(unexpected.results[0].error).toContain('no unexpected HTTP/WS traffic');
});

test('after-phase REDs are exactly the failing predicates with their measurements', () => {
  const assertions = [
    { id: 'collapsed-enclosure', pass: false, expectedBefore: true, actual: { background: 'rgb(29, 30, 34)' } },
    { id: 'new-turn-spacing', pass: true, expectedBefore: true, actual: { newTurnGap: 28 } },
    { id: 'live-history-axis', pass: false, expectedBefore: false, actual: { history: 24, live: 24 } },
  ];
  const reds = collectDesignReds(assertions, 'after');
  expect(reds.map(red => red.id)).toEqual(['collapsed-enclosure', 'live-history-axis']);
  expect(reds[0]).toMatchObject({ observedPass: false, phaseExpectedPass: true, expectedBefore: true, actual: { background: 'rgb(29, 30, 34)' } });
  expect(collectDesignReds(assertions.map(result => ({ ...result, pass: true })), 'after')).toEqual([]);
});

test('before-phase REDs are deviations from the enumerated expectedBefore contract', () => {
  const assertions = [
    { id: 'collapsed-enclosure', pass: false, expectedBefore: true, actual: {} },   // enumerated RED: expected
    { id: 'new-turn-spacing', pass: true, expectedBefore: true, actual: {} },      // expected RED absent: deviation
    { id: 'live-history-axis', pass: false, expectedBefore: false, actual: {} },   // unexpected failure: deviation
  ];
  const reds = collectDesignReds(assertions, 'before');
  expect(reds.map(red => red.id)).toEqual(['new-turn-spacing', 'live-history-axis']);
  expect(reds[0]).toMatchObject({ observedPass: true, phaseExpectedPass: false });
});
