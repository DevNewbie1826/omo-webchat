import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { footerAssertions, settle } from './ui-mobile-helpers.mjs';

for (const [gap, pass] of [[8, true], [9, false], [42, false], [-26, false]]) {
  test(`bottom reserve assertion classifies usable gap ${gap}`, () => {
    // Given measured control bounds and an independently supplied usable gap.
    const geometry = { controls: Array.from({ length: 2 }, () => ({ bounded: true, hit: true, disabled: false })),
      usableBottomGap: gap, bottomGap: gap + 34, necessaryBottomInset: 34, horizontalOverflow: false };
    // When the intended bottom-reserve contract is evaluated, then only <=8px plus rounding fits.
    expect(footerAssertions(geometry).find(row => row.id === 'C5.bottom-reserve').pass).toBe(pass);
  });
}

for (const count of [0, 1, 3]) {
  test(`footer coverage rejects ${count} controls before evaluating bounds`, () => {
    // Given an incomplete or overbroad selector result, even otherwise valid geometry cannot pass.
    const geometry = { controls: Array.from({ length: count }, () => ({ bounded: true, hit: true, disabled: false })),
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
