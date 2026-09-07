import { describe, expect, test } from 'bun:test';
import { assertCollinearProfiles, assertEdges, edgeRun } from './ui-dag-edges.mjs';

// Oracle regressions use literal computed-paint samples, not DOM or renderer mocks.
// The CLI owns actual Chrome integration; these prove it rejects false positives.
function sample() {
  const run = edgeRun();
  run.nodes = [run.nodes[0], run.nodes[2]];
  run.edges = [{ from: 'a', to: 'c' }, { from: 'missing', to: 'c' }];
  const green = [106, 194, 126, 255], gray = [255, 255, 255, 40];
  return { run, data: { reduced: false, markerIds: ['th-dag-arrow-r0-0-fulfilled'],
    tokens: { '--th-success': green, '--th-border-strong': gray }, graphs: [{ name: run.name,
      nodes: [{ id: 'a', x: 6, y: 6, width: 140, height: 60 }, { id: 'c', x: 170, y: 6, width: 140, height: 60 }],
      edges: [{ strokeRGBA: green, headRGBA: green, markerLocal: true, markerViewport: [7, 6], orient: 'auto', animation: 'th-dag-edge-flow', live: true,
        marker: 'url(#th-dag-arrow-r0-0-fulfilled)', markerComputed: 'url("#th-dag-arrow-r0-0-fulfilled")',
        duration: '1.2s', iterations: 'Infinity', dash: '8px, 4px', geometry: [146, 36, 170, 36] }],
    }] } };
}
describe('built-SPA edge oracle', () => {
  test('pixel oracle rejects hidden, solid and reversed collinear flow footprints', () => {
    const green = [63, 192, 132], background = [40, 40, 40];
    const profiles = ['GGGGGG....GGGG', '.GGGGGGGG....G', '....GGGGGGGG..'].map((pattern, i) => ({
      time: i * 300, green, distances: Array.from({ length: 14 }, (_, i) => i + 2),
      rows: [-1, 0, 1].map(dy => ({ dy, pixels: [...pattern].map(c => dy === 0 || c === 'G' ? green : background) })),
    }));
    expect(() => assertCollinearProfiles(profiles)).not.toThrow();
    for (const color of [green, background]) {
      const wrong = structuredClone(profiles);
      for (const profile of wrong) for (const row of profile.rows.filter(row => row.dy !== 0)) row.pixels.fill(color);
      expect(() => assertCollinearProfiles(wrong)).toThrow();
    }
    const reversed = structuredClone(profiles);
    for (const profile of reversed) for (const row of profile.rows.filter(row => row.dy !== 0)) row.pixels.reverse();
    expect(() => assertCollinearProfiles(reversed)).toThrow();
  });
  test('accepts eligible computed paint and rejects CSS/marker/geometry false positives', () => {
    const { run, data } = sample(); expect(() => assertEdges(data, [run])).not.toThrow();
    for (const change of [
      { strokeRGBA: data.tokens['--th-border-strong'] }, { headRGBA: data.tokens['--th-border-strong'] },
      { markerLocal: false }, { markerComputed: 'none' }, { animation: 'none' }, { live: false }, { dash: 'none' },
      { geometry: [170, 36, 146, 36] }, { markerViewport: [21, 18] }, { orient: '0' },
    ]) {
      const wrong = structuredClone(data); Object.assign(wrong.graphs[0].edges[0], change);
      expect(() => assertEdges(wrong, [run])).toThrow();
    }
  });
  test('rejects missing/extra edges, missing runs, unsafe/duplicate markers', () => {
    for (const corrupt of [
      d => { d.graphs[0].edges = []; }, d => { d.graphs[0].edges.push(d.graphs[0].edges[0]); },
      d => { d.graphs = []; }, d => { d.markerIds.push(d.markerIds[0]); },
      d => { d.markerIds[0] = 'th-dag-arrow-unsafe(/#)'; }, d => { d.markerIds = []; },
    ]) { const { run, data } = sample(); corrupt(data); expect(() => assertEdges(data, [run])).toThrow(); }
  });
  test('requires static green for terminal/unknown runs, inactive Graph, reduced motion and nonrunning destinations', () => {
    for (const modify of [
      (r, d) => { r.status = 'completed'; }, (r, d) => { r.status = 'future-run'; },
      (r, d) => { r.nodes[1].state = 'failed'; }, (r, d) => { d.reduced = true; },
    ]) {
      const { run, data } = sample(); modify(run, data);
      expect(() => assertEdges(data, [run])).toThrow();
      Object.assign(data.graphs[0].edges[0], { animation: 'none', live: false, dash: 'none' });
      expect(() => assertEdges(data, [run])).not.toThrow();
    }
    const { run, data } = sample(); expect(() => assertEdges(data, [run], false)).toThrow();
  });
  test('rejects completion latching after a source retry', () => {
    const { run, data } = sample(); run.nodes[0].state = 'pending';
    expect(() => assertEdges(data, [run])).toThrow();
    Object.assign(data.graphs[0].edges[0], { strokeRGBA: data.tokens['--th-border-strong'], headRGBA: data.tokens['--th-border-strong'], animation: 'none', live: false, dash: 'none' });
    expect(() => assertEdges(data, [run])).not.toThrow();
  });
});
