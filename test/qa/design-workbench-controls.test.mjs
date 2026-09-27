import { test, expect } from 'bun:test';
import { assertModelOverlayFollowsToken } from './design-workbench-controls.mjs';

const glass = 'rgba(38, 39, 44, 0.72)';
const overlay = 'rgb(37, 38, 43)';
const filter = 'blur(20px) saturate(1.5)';

function measurement({ actual, expected, token, backdropFilter, backdropSupported, sheet, siblingActual }) {
  return {
    roles: [
      { selector: '.th-chat-pane', token: '--th-bg', expected: 'rgb(23, 24, 27)', actual: siblingActual ?? 'rgb(23, 24, 27)' },
      { selector: '.th-model-picker-popover', token, expected, actual, backdropFilter, backdropSupported, sheet },
    ],
  };
}

test('desktop model overlay resolves the opaque token without requiring backdrop blur', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: overlay,
    backdropFilter: 'none', backdropSupported: true, sheet: false,
  }))).not.toThrow();
});

test('a see-through glass popover fails even with matching glass token and blur', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-glass', expected: 'rgba(38, 39, 44, .72)', actual: glass,
    backdropFilter: filter, backdropSupported: true, sheet: false,
  }))).toThrow(/model overlay follows semantic token/);
});

test('a translucent popover fails even when measured against the opaque token name', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: glass, actual: glass,
    backdropFilter: 'none', backdropSupported: true, sheet: false,
  }))).toThrow(/model overlay follows semantic token/);
});

test('the opaque overlay rejects an arbitrary colour at every width', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: overlay,
    backdropFilter: 'none', backdropSupported: false, sheet: false,
  }))).not.toThrow();
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: glass,
    backdropFilter: 'none', backdropSupported: false, sheet: false,
  }))).toThrow(/model overlay follows semantic token/);
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: 'rgb(9, 9, 9)',
    backdropFilter: filter, backdropSupported: true, sheet: false,
  }))).toThrow(/model overlay follows semantic token/);
});

test('sheet placement stays on the solid overlay token', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: overlay,
    backdropFilter: 'none', backdropSupported: true, sheet: true,
  }))).not.toThrow();
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: glass,
    backdropFilter: filter, backdropSupported: true, sheet: true,
  }))).toThrow(/model overlay follows semantic token/);
});

test('other open surfaces must still match their semantic tokens', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: overlay,
    backdropFilter: 'none', backdropSupported: true, sheet: false,
    siblingActual: 'rgb(9, 9, 9)',
  }))).toThrow(/model overlay follows semantic token/);
});
