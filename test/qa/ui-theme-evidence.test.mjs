import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { captureFrame, closeResources, exposeTranscript, judgeFill, missingSurfaces, REQUIRED_SURFACES, settleFrame } from './ui-theme-evidence.mjs';

const completeSurfaces = () => Object.fromEntries(REQUIRED_SURFACES.map(name => [name, { present: true, matches: true }]));
test('required missing surfaces cannot disappear from the mismatch list, including omitted verdict keys', () => {
  const surfaces = completeSurfaces();
  for (const name of ['canvas', 'sidebar', 'collapsedTool', 'text']) surfaces[name] = { present: false, matches: false };
  const results = [{ scenario: '390x844', theme: 'dark', surfaces }];
  expect(missingSurfaces(results)).toEqual(['canvas', 'sidebar', 'collapsedTool', 'text'].map(name => `390x844/dark/${name}`));
  delete surfaces.composer;
  expect(missingSurfaces(results)).toContain('390x844/dark/composer');
  surfaces.extraRequiredState = { present: true, matches: false };
  expect(missingSurfaces(results)).toContain('390x844/dark/extraRequiredState');
});

test('computed-only offscreen, occluded/no-pixel and missing fills fail; exposed matching paint passes', () => {
  const sample = { present: true, visible: true, onScreen: true, computed: 'rgb(40, 40, 40)', samples: [{ rgb: [40, 40, 40] }] };
  expect(judgeFill(sample, [40, 40, 40]).matches).toBe(true);
  for (const mutation of [{ present: false }, { visible: false }, { onScreen: false }, { samples: [] }, { computed: 'rgba(40, 40, 40, 0.5)' }]) {
    expect(judgeFill({ ...sample, ...mutation }, [40, 40, 40]).matches).toBe(false);
  }
});

test('one settled PNG buffer is saved AND decoded, with hash-bound geometry/actions', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=', 'base64');
  const changedFrame = Buffer.from(bytes); changedFrame[changedFrame.length - 1] ^= 1;
  const settled = Promise.withResolvers(), entered = Promise.withResolvers();
  const order = [], actions = [{ action: 'select', theme: 'dark' }], geometry = { sidebar: { rect: { x: 0, width: 264 } } };
  let captures = 0, saved, decoded;
  const page = { screenshot: async () => { order.push('capture'); return ++captures === 1 ? bytes : changedFrame; } };
  const pending = captureFrame({ page, path: 'frame.png', actions,
    settle: () => { entered.resolve(); return settled.promise; },
    save: async (_, value) => { order.push('save'); saved = value; },
    decode: async (actualPage, value) => { expect(actualPage).toBe(page); order.push('decode'); decoded = value; },
    measure: async () => { order.push('geometry'); return geometry; } });
  await entered.promise;
  expect(captures).toBe(0);
  settled.resolve({ fonts: 'loaded' });
  const receipt = await pending;
  expect(captures).toBe(1);
  expect(saved).toBe(bytes); expect(decoded).toBe(saved);
  expect(order).toEqual(['capture', 'save', 'decode', 'geometry']);
  expect(receipt.sha256).toBe(createHash('sha256').update(saved).digest('hex'));
  expect(receipt.geometry).toEqual(geometry); expect(receipt.actions).toEqual(actions);
  actions[0].theme = 'light'; expect(receipt.actions[0].theme).toBe('dark');
});

test('cleanup success cannot precede any awaited owned closure', async () => {
  const context = Promise.withResolvers(), browser = Promise.withResolvers();
  const contextEntered = Promise.withResolvers(), browserEntered = Promise.withResolvers();
  const order = []; let receipt;
  const pending = closeResources([
    { name: 'context', close: () => { order.push('context-enter'); contextEntered.resolve(); return context.promise; } },
    { name: 'fixture', close: async () => { order.push('fixture-close'); return { pendingWebSockets: 0 }; } },
    { name: 'browser', close: () => { order.push('browser-enter'); browserEntered.resolve(); return browser.promise; } },
  ], async value => { order.push('receipt'); receipt = value; });
  await contextEntered.promise;
  expect(receipt).toBeUndefined(); expect(order).toEqual(['context-enter']);
  context.resolve({ contextClosed: true }); await browserEntered.promise;
  expect(receipt).toBeUndefined();
  browser.resolve({ browserClosed: true }); await pending;
  expect(receipt.success).toBe(true);
  expect(order).toEqual(['context-enter', 'fixture-close', 'browser-enter', 'receipt']);
  expect(receipt.resources.every(resource => resource.closed)).toBe(true);
});

test('cleanup attempts remaining resources and preserves closure AND receipt errors', async () => {
  const closeError = new Error('closure failure'), writeError = new Error('receipt failure');
  let secondClosed = false, receipt;
  const pending = closeResources([
    { name: 'context', close: async () => { throw closeError; } },
    { name: 'fixture', close: async () => { secondClosed = true; } },
  ], async value => { receipt = value; throw writeError; });
  const error = await pending.then(() => { throw new Error('cleanup unexpectedly succeeded'); }, error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([closeError, writeError]);
  expect(secondClosed).toBe(true); expect(receipt.success).toBe(false);
  expect(receipt.resources[0].closed).toBe(false);
});

test('real scroll owner is subscribed before scrollTo; header geometry, not tall body, gates completion', async () => {
  class Port extends EventTarget {
    scrollTop = 200; scrollHeight = 1000; clientHeight = 150;
    getBoundingClientRect() { return { top: 40, bottom: 190, toJSON: () => ({ top: 40, bottom: 190 }) }; }
    scrollTo({ top, behavior }) { expect(behavior).toBe('instant'); this.scrollTop = top; this.dispatchEvent(new Event('scrollend')); }
  }
  const port = new Port();
  const target = { closest: selector => { expect(selector).toBe('.th-chat-body'); return port; }, getBoundingClientRect: () => {
    const top = 100 - port.scrollTop;
    return { top, bottom: top + 48, toJSON: () => ({ top, height: 48 }) };
  } };
  const receipt = await runInNewContext(`(${exposeTranscript})('.tool > .head')`, {
    document: { querySelector: () => target }, innerHeight: 390, setTimeout, clearTimeout,
  });
  expect(receipt.before).toBe(200); expect(receipt.after).toBe(52);
  expect(receipt.target.top).toBe(48);
});


test('native motion readiness observes replacement transitions and records cancellation without timer-based readiness', async () => {
  const initial = Promise.withResolvers(), replacement = Promise.withResolvers();
  const enteredInitial = Promise.withResolvers(), enteredReplacement = Promise.withResolvers();
  const first = { playState: 'running', transitionProperty: 'background-color',
    effect: { getComputedTiming: () => ({ endTime: 120 }) },
    get finished() { enteredInitial.resolve(); return initial.promise; } };
  const second = { playState: 'running', transitionProperty: 'background-color',
    effect: { getComputedTiming: () => ({ endTime: 120 }) },
    get finished() { enteredReplacement.resolve(); return replacement.promise; } };
  const infinite = { playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) },
    get finished() { throw new Error('infinite spinner must not gate a screenshot'); } };
  let animations = [first, infinite], completed = false;
  const pending = runInNewContext(`(${settleFrame})()`, {
    document: { documentElement: { getBoundingClientRect() {} }, fonts: { status: 'loaded', ready: Promise.resolve() }, getAnimations: () => animations },
    innerWidth: 844, innerHeight: 390, setTimeout, clearTimeout,
  }).then(value => { completed = true; return value; });
  await enteredInitial.promise;
  expect(completed).toBe(false);
  animations = [second, infinite]; first.playState = 'idle';
  initial.reject(new DOMException('replaced transition', 'AbortError'));
  await enteredReplacement.promise;
  expect(completed).toBe(false);
  second.playState = 'finished'; replacement.resolve();
  const receipt = await pending;
  expect(receipt.motion.map(row => row.state)).toEqual(['canceled', 'finished']);
  expect(receipt.viewport).toEqual({ width: 844, height: 390 });
});
