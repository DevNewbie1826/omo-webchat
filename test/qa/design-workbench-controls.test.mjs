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

test('open model overlay matches the resolved glass token and an active backdrop filter', () => {
  // Custom properties serialize the token alpha as ".72"; computed style keeps "0.72".
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-glass', expected: 'rgba(38, 39, 44, .72)', actual: glass,
    backdropFilter: filter, backdropSupported: true, sheet: false,
  }))).not.toThrow();
});

test('a non-token colour still fails when the floating filter is present', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-glass', expected: glass, actual: 'rgb(9, 9, 9)',
    backdropFilter: filter, backdropSupported: true, sheet: false,
  }))).toThrow(/model overlay follows semantic token/);
});

test('supported floating layer with no backdrop filter fails even when the glass colour matches', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-glass', expected: glass, actual: glass,
    backdropFilter: 'none', backdropSupported: true, sheet: false,
  }))).toThrow(/model overlay follows semantic token/);
});

test('solid overlay fallback rejects a non-token colour and accepts the overlay token without a filter', () => {
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: overlay,
    backdropFilter: 'none', backdropSupported: false, sheet: false,
  }))).not.toThrow();
  expect(() => assertModelOverlayFollowsToken(measurement({
    token: '--th-surface-overlay', expected: overlay, actual: glass,
    backdropFilter: 'none', backdropSupported: false, sheet: false,
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
    token: '--th-glass', expected: glass, actual: glass,
    backdropFilter: filter, backdropSupported: true, sheet: false,
    siblingActual: 'rgb(9, 9, 9)',
  }))).toThrow(/model overlay follows semantic token/);
});
