import { test, expect } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import { complete } from './design-workbench-fixture.mjs';

// Controlled DOM/WAAPI boundary: completion is driven only by its real promise
// contract, not elapsed time. The actual-App runner covers native rendering.
function harness({ hidden = false, opacity = '1', missing = false } = {}) {
  const animation = Promise.withResolvers(), fonts = Promise.withResolvers();
  const subscribed = Promise.withResolvers();
  let finishedRead = false, infiniteRead = false;
  const finite = { playState: 'running', animationName: 'entrance',
    effect: { getComputedTiming: () => ({ endTime: 120 }) },
    get finished() { finishedRead = true; subscribed.resolve(); return animation.promise; } };
  const infinite = { playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) },
    get finished() { infiniteRead = true; throw new Error('infinite spinner awaited'); } };
  const parent = { parentElement: null, style: { opacity, visibility: hidden ? 'hidden' : 'visible', display: 'block' },
    getAnimations: () => [finite] };
  const element = { parentElement: parent, isConnected: true,
    style: { opacity: '1', visibility: 'visible', display: 'block' },
    getAnimations: () => [infinite],
    getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100 }),
    contains: hit => hit === element };
  const document = { querySelector: () => missing ? null : element,
    elementFromPoint: () => element, fonts: { ready: fonts.promise, status: 'loading' } };
  const context = createContext({ window: { qaPending: Promise.resolve(true) }, document,
    getComputedStyle: el => el.style, innerWidth: 1280, innerHeight: 900, setTimeout, clearTimeout });
  const page = { evaluate: (fn, options) => { context.options = options; return runInContext(`(${fn})(options)`, context); } };
  return { page, subscribed: subscribed.promise, get finishedRead() { return finishedRead; }, get infiniteRead() { return infiniteRead; },
    finishAnimation() { finite.playState = 'finished'; animation.resolve(); },
    finishFonts() { document.fonts.status = 'loaded'; fonts.resolve(); } };
}

test('capture completion subscribes to finite ancestor motion and fonts, excluding infinite spinners', async () => {
  // Given insertion has completed but parent entrance and font loading have not.
  const h = harness();
  let completed = false;
  const pending = complete(h.page, { target: '.panel' }).then(value => { completed = true; return value; });
  // When either the helper subscribes or (the regression) returns prematurely.
  await Promise.race([h.subscribed, pending]);
  try {
    expect(h.finishedRead).toBe(true);
    expect(completed).toBe(false);
    h.finishAnimation();
    // Flush this explicit animation completion, while fonts remain pending.
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(h.infiniteRead).toBe(false);
  } finally { h.finishAnimation(); h.finishFonts(); }
  const receipt = await pending;
  expect(receipt.opacity).toBe(1);
  expect(receipt.fontsStatus).toBe('loaded');
});

for (const [name, options] of [['hidden ancestor', { hidden: true }], ['translucent ancestor', { opacity: '.5' }], ['missing target', { missing: true }]]) {
  test(`capture rejects ${name} instead of accepting DOM insertion`, async () => {
    // Given a wrong surface, even though insertion/animation/font events complete.
    const h = harness(options); h.finishAnimation(); h.finishFonts();
    // When capture readiness is requested, then it fails closed.
    await expect(complete(h.page, { target: '.panel' })).rejects.toThrow();
  });
}
