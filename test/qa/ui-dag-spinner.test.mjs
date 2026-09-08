import { test, expect } from 'bun:test';
import { assertTransparentRunning } from './ui-dag-spinner.mjs';

const rings = fill => ['c', 'e'].map(node => ({ node, tag: 'circle', fill, presentationFill: 'none' }));

test('spinner oracle rejects CSS-filled circles despite fill=none presentation attributes', () => {
  for (const fill of ['rgb(201, 201, 201)', 'rgb(93, 95, 98)', 'transparent', undefined]) {
    expect(() => assertTransparentRunning(rings(fill))).toThrow();
  }
  expect(() => assertTransparentRunning(rings('none'))).not.toThrow();
});

test('spinner oracle rejects missing circles, wrong glyph types and a single filled peer', () => {
  expect(() => assertTransparentRunning([])).toThrow();
  expect(() => assertTransparentRunning(rings('none').slice(0, 1))).toThrow();
  expect(() => assertTransparentRunning(rings('none').map(ring => ({ ...ring, tag: 'text' })))).toThrow();
  const mixed = rings('none'); mixed[1].fill = 'rgb(201, 201, 201)';
  expect(() => assertTransparentRunning(mixed)).toThrow();
});
