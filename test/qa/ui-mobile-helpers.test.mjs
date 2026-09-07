import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { footerAssertions, measure, settle } from './ui-mobile-helpers.mjs';

for (const [gap, pass] of [[8, true], [9, false], [42, false], [-26, false]]) {
  test(`bottom reserve assertion classifies usable gap ${gap}`, () => {
    // Given measured control bounds and an independently supplied usable gap.
    const geometry = { controls: Array.from({ length: 2 }, () => ({ bounded: true, unclipped: true, hit: true, disabled: false })),
      usableBottomGap: gap, bottomGap: gap + 34, necessaryBottomInset: 34, horizontalOverflow: false };
    // When the intended bottom-reserve contract is evaluated, then only <=8px plus rounding fits.
    expect(footerAssertions(geometry).find(row => row.id === 'C5.bottom-reserve').pass).toBe(pass);
  });
}

for (const count of [0, 1, 3]) {
  test(`footer coverage rejects ${count} controls before evaluating bounds`, () => {
    // Given an incomplete or overbroad selector result, even otherwise valid geometry cannot pass.
    const geometry = { controls: Array.from({ length: count }, () => ({ bounded: true, unclipped: true, hit: true, disabled: false })),
      usableBottomGap: 8, bottomGap: 8, necessaryBottomInset: 0, horizontalOverflow: false };
    // When assertions evaluate coverage, then the malformed capture is rejected.
    expect(() => footerAssertions(geometry)).toThrow();
  });
}

test('capture subscribes to concurrent transitions before cancellation and awaits the surviving transition', async () => {
  // Given a drawer whose visibility transition cancels its transform transition.
  const subscribed = Promise.withResolvers(), first = Promise.withResolvers(), second = Promise.withResolvers();
  let subscriptions = 0;
  const animations = [first, second].map((state, index) => ({ playState: 'running', transitionProperty: String(index),
    effect: { getComputedTiming: () => ({ endTime: 180 }) }, get finished() {
      if (++subscriptions === 2) subscribed.resolve();
      return state.promise;
    } }));
  const infinite = { playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) },
    get finished() { throw new Error('Infinite animation must not gate capture'); } };
  const document = { documentElement: { getBoundingClientRect() {} }, fonts: { ready: Promise.resolve() },
    querySelector: () => ({ getAnimations: () => [...animations, infinite] }) };
  const page = { evaluate: fn => runInNewContext(`(${fn})()`, { document, setTimeout, clearTimeout }) };
  let complete = false;
  const pending = settle(page).then(result => { complete = true; return result; });
  // When both exact promises have subscribers, cancellation may safely arrive before finish.
  await subscribed.promise;
  animations[0].playState = 'idle'; first.reject(new DOMException('Transition cancelled', 'AbortError'));
  await Promise.resolve();
  expect(complete).toBe(false);
  animations[1].playState = 'finished'; second.resolve();
  // Then legitimate cancellation is recorded, not swallowed or awaited a second time.
  const receipt = await pending;
  expect(receipt.map(row => row.outcome).sort()).toEqual(['cancelled', 'finished']);
  expect(subscriptions).toBe(2);
});

for (const [mobileMedia, gap, pass] of [[true, 4, true], [true, 8, false], [false, 8, true], [false, 4, false]]) {
  test(`exact gap at mobile=${mobileMedia}, gap=${gap}`, () => {
    const g = { controls: [{}, {}], mobileMedia, usableBottomGap: gap };
    expect(footerAssertions(g).find(r => r.id === 'C5.mobile-bottom-gap-exact').pass).toBe(pass);
  });
}

// Supply DOM geometry independently of the expected safe bounds. The native hit
// result deliberately stays positive so rectangle/clipping guards cannot hide
// behind a center-only hit test. The real-browser runners exercise these together.
async function measured({ safeTop = 59, safeBottom = 34, keyboard = false, controlTop = 50, clipTop = 0, occluded = false } = {}) {
  const element = (top, height = 270) => ({
    getBoundingClientRect: () => ({ toJSON: () => ({ x: 0, y: top, left: 0, right: 100, top, bottom: top + height, width: 100, height }) }),
    clientTop: 0, clientLeft: 0, clientWidth: 100, clientHeight: height,
    scrollHeight: height, scrollTop: 0, scrollWidth: 100, className: 'fixture', dataset: {},
    matches: () => false, contains: () => false, getAttribute: () => null,
    style: { getPropertyValue: () => '' }, hasAttribute: () => keyboard,
  });
  const root = element(0), ancestor = element(clipTop, 270 - clipTop), control = element(controlTop, 24);
  control.parentElement = ancestor;
  const footer = { ...root, querySelectorAll: () => [control] };
  const document = { documentElement: root, activeElement: control,
    elementFromPoint: () => occluded ? ancestor : control,
    querySelector: selector => selector === '.th-settings-panel' || selector === '.th-pane-wrap' ? null
      : selector === '.th-sidebar-footer' ? footer : root,
    querySelectorAll: () => [] };
  const context = { document, visualViewport: { width: 390, height: 270, offsetTop: 0, offsetLeft: 0, scale: 1 },
    innerWidth: 390, innerHeight: 270, matchMedia: () => ({ matches: false }),
    getComputedStyle: e => ({ paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px',
      overflowY: e === ancestor ? 'hidden' : 'visible', overflowX: 'visible', outlineStyle: 'none' }) };
  return measure({ evaluate: (fn, args) => runInNewContext(`(${fn})(args)`, { ...context, args }) }, safeBottom, safeTop);
}

test('safe top is externally supplied and checks the full control, not just its center', async () => {
  const control = await measured({ safeTop: 0 });
  const cutout = await measured({ safeTop: 59 });
  expect(control.controls[0].bounded).toBe(true);
  expect(cutout.safe.top).toBe(59);
  expect(cutout.controls[0].hit).toBe(true);
  expect(cutout.controls[0].bounded).toBe(false);
});

test('keyboard releases bottom only; top protection remains independent of product padding', async () => {
  for (const keyboard of [false, true]) for (const safeBottom of [0, 34]) {
    const g = await measured({ keyboard, safeBottom });
    expect(g.safe).toEqual({ top: 59, left: 0, right: 390, bottom: 270 - (keyboard ? 0 : safeBottom) });
  }
});

test('ancestor clipping rejects a safe, center-hit control whose edge is clipped', async () => {
  const g = await measured({ safeTop: 0, clipTop: 59 });
  expect(g.controls[0].bounded).toBe(true);
  expect(g.controls[0].hit).toBe(true);
  expect(g.controls[0].unclipped).toBe(false);
  expect(footerAssertions(g).find(r => r.id === 'C5.controls-bounded-and-hit').pass).toBe(false);
});

test('native occlusion rejects otherwise bounded and unclipped controls', async () => {
  const g = await measured({ controlTop: 70, occluded: true });
  expect(g.controls[0].bounded).toBe(true);
  expect(g.controls[0].unclipped).toBe(true);
  expect(g.controls[0].hit).toBe(false);
  expect(footerAssertions(g).find(r => r.id === 'C5.controls-bounded-and-hit').pass).toBe(false);
});
