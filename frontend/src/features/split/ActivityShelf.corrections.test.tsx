import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityState, click, makeDag, mountActivityShelf, renderShelf, unmountActivityShelf, type ActivityShelfHarness } from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";

let harness: ActivityShelfHarness;
beforeEach(() => { harness = mountActivityShelf(); });
afterEach(async () => { await unmountActivityShelf(harness); });
const node = () => requireElement(harness.container.querySelector<SVGGElement>('[data-node="c"]'), "node c");
const button = (selector: string) => requireElement(harness.container.querySelector(selector), selector);
function showGraph() {
  renderShelf(harness, activityState({ dags: [makeDag()] }));
  expect(harness.container.querySelectorAll('[data-activity-tab]')).toHaveLength(3);
  click(button('[data-activity-tab="dag"]'));
}
function event(type: string, animationName: string) {
  act(() => {
    const e = new Event(type, { bubbles: true });
    Object.defineProperty(e, "animationName", { value: animationName });
    node().dispatchEvent(e);
  });
}
describe("activity rendering corrections", () => {
  it("keeps the permanent peer controls before opening", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    expect(harness.container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(harness.container.querySelector('.th-activity-bar')?.tagName).toBe('SPAN');
  });
  it("uses a separate single-rectangle clip for each title row", () => {
    showGraph();
    const labels = [...node().querySelectorAll('.th-activity-glabel')];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const ref = label.getAttribute('clip-path')!;
      expect(document.getElementById(ref.slice(5, -1))?.children.length).toBe(1);
    }
  });
  it("consumes pending motion when the graph unmounts without a fold click", () => {
    showGraph();
    event('animationstart', 'th-dag-node-enter');
    const todo = [{ name: 'Retained', tasks: [{ content: 'Retained row', status: 'pending' as const }] }];
    renderShelf(harness, activityState({ todo }));
    renderShelf(harness, activityState({ todo, dags: [makeDag()] }));
    expect(node().classList.contains('th-activity-gnode--enter')).toBe(false);
  });
  it.each(['animationcancel', 'animationend'])("consumes entry on %s", type => {
    showGraph();
    event('animationstart', 'th-dag-node-enter');
    event(type, 'th-dag-node-enter');
    expect(node().classList.contains('th-activity-gnode--enter')).toBe(false);
  });
  it.each(['tab', 'fold', 'list'])("consumes interrupted terminal motion across %s", kind => {
    showGraph();
    event('animationstart', 'th-dag-node-enter');
    event('animationend', 'th-dag-node-enter');
    const run = makeDag();
    renderShelf(harness, activityState({ dags: [{ ...run, nodes: run.nodes.map(n => n.id === 'c' ? { ...n, state: 'completed' } : n) }] }));
    expect(node().classList.contains('th-activity-gnode--settle')).toBe(true);
    event('animationstart', 'th-dag-node-settle');
    if (kind === 'tab') { click(button('[data-activity-tab="todo"]')); click(button('[data-activity-tab="dag"]')); }
    if (kind === 'fold') { click(button('.th-activity-fold')); click(button('.th-activity-fold')); }
    if (kind === 'list') { click(button('[data-view="list"]')); click(button('[data-view="graph"]')); }
    expect(node().classList.contains('th-activity-gnode--settle')).toBe(false);
  });
});
