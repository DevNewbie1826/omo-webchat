import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertContainedGeometry, assertControlReachable, describeLaunch } from './rpc46-resume.mjs';

test('launch receipt records argv and environment keys without password or environment values', () => {
  const receipt = describeLaunch('/owned/app', ['--root', '/owned', '--password', 'private-password', '--port', '25262'],
    { OMO_CODING_AGENT_DIR: '/owned/agent', PRIVATE_TOKEN: 'private-token' }, '/repo');
  assert.deepEqual(receipt, {
    argv: ['/owned/app', '--root', '/owned', '--password', '[REDACTED]', '--port', '25262'],
    environmentKeys: ['OMO_CODING_AGENT_DIR', 'PRIVATE_TOKEN'],
    cwd: '/repo',
  });
  assert.ok(!JSON.stringify(receipt).includes('private-password'));
  assert.ok(!JSON.stringify(receipt).includes('private-token'));
});

function mobileGeometry() {
  const box = (left, right, scrollWidth = right - left) => ({ rect: { left, right, top: 44, bottom: 721, width: right - left, height: 677 },
    clientLeft: 0, clientWidth: right - left, scrollWidth, scrollLeft: 0, overflowX: 'hidden' });
  return { innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 0,
    visualViewport: { width: 390, height: 844, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0 },
    boxes: { '#root': [box(0, 390)], '.th-chat-body': [box(0, 390)],
      '.th-failed-drafts': [{ ...box(12, 378, 2399), overflowX: 'auto' }] },
    transcriptEdges: [{ rect: { left: 12, right: 378 }, textRects: [{ left: 12, right: 180 }], clippingAncestors: [box(0, 390)] }] };
}

test('contained retry scroller is allowed, page pan and actual transcript clipping are rejected', () => {
  const g = mobileGeometry();
  assert.doesNotThrow(() => assertContainedGeometry(g));
  for (const mutate of [
    g => { g.scrollX = 12; },
    g => { g.visualViewport.offsetLeft = 12; },
    g => { g.visualViewport.scale = 1.1; },
    g => { g.boxes['#root'][0].rect.right = 410; },
    g => { g.boxes['.th-chat-body'][0].scrollWidth = 410; },
    g => { g.boxes['.th-chat-body'][0].scrollLeft = 12; },
    g => { g.transcriptEdges[0].rect.left = -12; },
    g => { g.transcriptEdges[0].textRects[0].left = -12; },
  ]) {
    const bad = structuredClone(g); mutate(bad);
    assert.throws(() => assertContainedGeometry(bad), assert.AssertionError);
  }
});

test('retry and dismiss must be fully visible through every clipping ancestor after natural scrolling', () => {
  const g = mobileGeometry();
  const control = { rect: { left: 199, right: 245, top: 687, bottom: 721, width: 46, height: 34 },
    clippingAncestors: [g.boxes['.th-failed-drafts'][0], g.boxes['#root'][0]] };
  assert.doesNotThrow(() => assertControlReachable(control, g));
  const offscreen = structuredClone(control); offscreen.rect.left = 440; offscreen.rect.right = 486;
  assert.throws(() => assertControlReachable(offscreen, g), assert.AssertionError);
  const partlyClipped = structuredClone(control); partlyClipped.rect.right = 390;
  assert.throws(() => assertControlReachable(partlyClipped, g), assert.AssertionError);
  const verticallyClipped = structuredClone(control); verticallyClipped.rect.bottom = 745;
  assert.throws(() => assertControlReachable(verticallyClipped, g), assert.AssertionError);
  assert.throws(() => assertControlReachable(undefined, g), assert.AssertionError);
});
