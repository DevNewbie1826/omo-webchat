import { test, expect } from 'bun:test';
import { bindingAssertion, motionAssertion, actionAssertion } from './ui-followup-sidebar.mjs';

const binding = () => ({ domURLs: ['http://fixture/', 'http://fixture/app.js', 'http://fixture/app.css'],
  responses: ['', 'app.js', 'app.css'].map(path => ({ url: `http://fixture/${path}`, status: 200,
    bytes: 42, localBytes: 42, sha256: 'served-hash', localSha256: 'served-hash' })) });

test('render binding requires each HTML/script/style response and identical bytes', () => {
  expect(bindingAssertion(binding())).toBe(true);
  for (const field of ['url', 'status', 'bytes', 'sha256']) {
    const bad = binding(); bad.responses[1][field] = field === 'status' || field === 'bytes' ? 0 : 'wrong';
    expect(bindingAssertion(bad)).toBe(false);
  }
  const missing = binding(); missing.responses.pop(); expect(bindingAssertion(missing)).toBe(false);
  expect(bindingAssertion({ domURLs: [], responses: [] })).toBe(false);
});

const frame = (closed, x, opacity) => ({ closed, sidebar: { x, width: 260, transform: `translateX(${x}px)` },
  backdrop: { present: !closed, opacity } });
const motion = (direction, reduced) => {
  const open = direction === 'open', before = frame(open, open ? -260 : 0, open ? null : 1);
  const after = frame(!open, open ? 0 : -260, open ? 1 : null);
  return { direction, reduced, frames: { before, during: reduced ? after : frame(!open, -130, open ? 0.5 : null), after },
    animations: reduced ? [] : [{ target: 'sidebar', name: 'transform', duration: 180 },
      ...(open ? [{ target: 'backdrop', name: 'th-fade-in', duration: 120 }] : [])] };
};

for (const direction of ['open', 'close']) for (const reduced of [false, true]) {
  test(`drawer ${direction} reduced=${reduced} requires endpoints and its actual motion contract`, () => {
    expect(motionAssertion(motion(direction, reduced))).toBe(true);
    const wrongEnd = motion(direction, reduced); wrongEnd.frames.after = wrongEnd.frames.before;
    expect(motionAssertion(wrongEnd)).toBe(false);
    const wrongMotion = motion(direction, reduced);
    if (reduced) wrongMotion.animations.push({ name: 'transform' });
    else wrongMotion.frames.during.sidebar.x = 0;
    expect(motionAssertion(wrongMotion)).toBe(false);
    if (!reduced) {
      const missing = motion(direction, reduced); missing.animations = [];
      expect(motionAssertion(missing)).toBe(false);
    }
  });
}

const rows = [
  { action: 'settings-open', before: { settings: false }, result: { settings: true, closed: false } },
  { action: 'settings-escape', before: { settings: true, closed: false }, result: { settings: false, closed: false } },
  { action: 'backdrop-dismiss', before: { closed: false }, result: { closed: true, backdrop: false } },
  { action: 'menu-open', result: { closed: false, backdrop: true } },
];
for (const row of rows) test(`${row.action} is bound to the resulting state`, () => {
  expect(actionAssertion(row)).toBe(true);
  expect(actionAssertion({ ...row, result: { ...row.result, closed: !row.result.closed } })).toBe(false);
});
