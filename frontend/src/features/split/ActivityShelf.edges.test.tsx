import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityState, click, makeDag, mountActivityShelf, openShelf, renderShelf, unmountActivityShelf, type ActivityShelfHarness } from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";
import type { ActivityDagRun } from "./activityTypes";

let harness: ActivityShelfHarness;
beforeEach(() => { harness = mountActivityShelf(); });
afterEach(async () => { vi.useRealTimers(); await unmountActivityShelf(harness); });
const states = ["pending", "scheduled", "blocked", "running", "completed", "failed", "cancelled", "skipped", "future-state"];
function pair(source: string, destination: string, status = "running"): ActivityDagRun {
  return makeDag({ status, nodes: [
    { id: "a", prompt: "Source", state: source, dependsOn: [] },
    { id: "c", prompt: "Destination", state: destination, dependsOn: ["a"] },
  ], edges: [{ from: "a", to: "c" }] });
}
function openGraph(container: ParentNode) {
  openShelf(container);
  const tab = requireElement(container.querySelector('[data-activity-tab="dag"]'), "DAG tab");
  if (tab.getAttribute("aria-selected") !== "true") click(tab);
}
function show(run: ActivityDagRun) {
  renderShelf(harness, activityState({ dags: [run] }));
  openGraph(harness.container);
}
const lines = () => [...harness.container.querySelectorAll<SVGLineElement>(".th-activity-gedge")];
function check(line: SVGLineElement, fulfilled: boolean, flow: boolean) {
  expect(line.classList.contains("th-activity-gedge--fulfilled")).toBe(fulfilled);
  expect(line.classList.contains("th-activity-gedge--flow")).toBe(flow);
  const ref = line.getAttribute("marker-end")!;
  expect(ref).toMatch(/^url\(#th-dag-arrow-[A-Za-z0-9_-]+\)$/);
  const marker = requireElement(document.getElementById(ref.slice(5, -1)), "resolved marker");
  expect(marker.closest("svg")).toBe(line.closest("svg"));
  expect(marker.querySelector("path")?.classList.contains("th-activity-gedge-head--fulfilled")).toBe(fulfilled);
}
const press = (selector: string) => click(requireElement(harness.container.querySelector(selector), selector));

describe("derived DAG dependency edges", () => {
  it.each(states)("completed source fulfills line and arrow for %s destination", destination => {
    show(pair("completed", destination));
    expect(lines()).toHaveLength(1);
    check(lines()[0]!, true, destination === "running");
  });
  it.each(states.filter(state => state !== "completed"))("%s source never fulfills or animates an outgoing dependency", source => {
    show(pair(source, "running"));
    check(lines()[0]!, false, false);
  });
  it.each(["completed", "failed", "cancelled", "skipped", "pending", "scheduled", "blocked", "future-run"])("%s run remains static despite stale running destination", status => {
    show(pair("completed", "running", status));
    check(lines()[0]!, true, false);
  });
  it("omits missing endpoints while evaluating mixed fan-in and fan-out independently", () => {
    const run = makeDag({ nodes: [
      { id: "a", prompt: "a", state: "completed", dependsOn: [] },
      { id: "b", prompt: "b", state: "failed", dependsOn: [] },
      { id: "c", prompt: "c", state: "running", dependsOn: ["a", "b"] },
      { id: "d", prompt: "d", state: "pending", dependsOn: ["a", "c"] },
    ], edges: [
      { from: "a", to: "c" }, { from: "b", to: "c" },
      { from: "a", to: "d" }, { from: "c", to: "d" },
      { from: "missing", to: "c" }, { from: "a", to: "missing" },
    ] });
    show(run);
    expect(lines()).toHaveLength(4);
    [[true, true], [false, false], [true, false], [false, false]].forEach(([fulfilled, flow], i) => check(lines()[i]!, fulfilled!, flow!));
    // This legal four-node layout has collinear a -> c flow and static a -> d.
    const [flow, , fanOut] = lines();
    expect(flow!.getAttribute("y1")).toBe(flow!.getAttribute("y2"));
    expect(fanOut!.getAttribute("y1")).toBe(flow!.getAttribute("y1"));
    expect(fanOut!.getAttribute("y2")).toBe(flow!.getAttribute("y2"));
    // Emphasizing the moving stroke must not magnify either arrow variant.
    for (const marker of harness.container.querySelectorAll("marker")) {
      expect(marker.getAttribute("markerUnits")).toBe("userSpaceOnUse");
      expect(marker.getAttribute("markerWidth")).toBe("7");
      expect(marker.getAttribute("markerHeight")).toBe("6");
      expect(marker.getAttribute("viewBox")).toBe("0 0 8 6");
    }
  });
  it("recomputes retries without latching color and keeps DOM, geometry, keys and markers through elapsed ticks", () => {
    vi.useFakeTimers();
    show(pair("completed", "running"));
    const line = lines()[0]!;
    const geometry = ["x1", "y1", "x2", "y2"].map(key => line.getAttribute(key));
    const marker = line.getAttribute("marker-end");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(lines()[0]).toBe(line);
    expect(line.getAttribute("marker-end")).toBe(marker);
    check(line, true, true);
    for (const [source, destination, status, fulfilled, flow] of [
      ["completed", "running", "failed", true, false],
      ["pending", "running", "running", false, false],
      ["completed", "pending", "running", true, false],
      ["completed", "running", "running", true, true],
    ] as const) {
      show(pair(source, destination, status));
      expect(lines()[0]).toBe(line);
      expect(["x1", "y1", "x2", "y2"].map(key => line.getAttribute(key))).toEqual(geometry);
      check(line, fulfilled, flow);
    }
  });
  it.each(["tab", "close", "list"])("stops flow on %s and resumes without replaying node one-shots", exit => {
    show(makeDag());
    // A real state update initiates settle on b while a -> c stays eligible.
    show(makeDag({ nodes: makeDag().nodes.map(n => n.id === "b" ? { ...n, state: "failed" } : n) }));
    expect(harness.container.querySelector('[data-node="b"]')?.classList.contains("th-activity-gnode--settle")).toBe(true);
    check(lines()[0]!, true, true);
    if (exit === "tab") press('[data-activity-tab="todo"]');
    if (exit === "close") press('[data-activity-tab="dag"]');
    if (exit === "list") press('[data-view="list"]');
    expect(harness.container.querySelectorAll(".th-activity-gedge--flow")).toHaveLength(0);
    if (exit === "list") press('[data-view="graph"]'); else press('[data-activity-tab="dag"]');
    check(lines()[0]!, true, true);
    expect(harness.container.querySelectorAll(".th-activity-gnode--enter,.th-activity-gnode--settle")).toHaveLength(0);
  });
  it.each(["tab", "close", "list"])("consumes seen-node transitions arriving during %s but preserves new-node first entry", exit => {
    const initial = makeDag();
    show(initial);
    if (exit === "tab") press('[data-activity-tab="todo"]');
    if (exit === "close") press('[data-activity-tab="dag"]');
    if (exit === "list") press('[data-view="list"]');
    const updated = { ...initial, nodes: [
      ...initial.nodes.map(n => n.id === "b" ? { ...n, state: "failed" } : n),
      { id: "new", prompt: "First visible entry", dependsOn: ["a"], state: "running" },
    ], edges: [...initial.edges, { from: "a", to: "new" }] };
    renderShelf(harness, activityState({ dags: [updated] }));
    expect(harness.container.querySelectorAll(".th-activity-gnode--enter,.th-activity-gnode--settle")).toHaveLength(0);
    if (exit === "list") press('[data-view="graph"]'); else press('[data-activity-tab="dag"]');
    check(lines()[0]!, true, true);
    expect([...harness.container.querySelectorAll(".th-activity-gnode--enter")].map(n => n.getAttribute("data-node"))).toEqual(["new"]);
    expect(harness.container.querySelectorAll(".th-activity-gnode--settle")).toHaveLength(0);
  });
  it("defers unseen nodes' first entry until Graph is actually selected", () => {
    renderShelf(harness, activityState({ dags: [makeDag()] }));
    openShelf(harness.container); // Workflow task rows initially select Subagents.
    expect(harness.container.querySelectorAll(".th-activity-gnode--enter")).toHaveLength(0);
    press('[data-activity-tab="dag"]');
    expect(harness.container.querySelectorAll(".th-activity-gnode--enter")).toHaveLength(3);
  });
  it("consumes initial reduced-motion paints and suppressed transitions before normal motion resumes", () => {
    const original = window.matchMedia;
    const media = Object.assign(new EventTarget(), { matches: true, media: "(prefers-reduced-motion: reduce)", onchange: null, addListener() {}, removeListener() {} });
    vi.stubGlobal("matchMedia", (query: string) => query === media.media ? media : original(query));
    show(makeDag());
    expect(harness.container.querySelectorAll(".th-activity-gnode--enter,.th-activity-gnode--settle")).toHaveLength(0);
    show(makeDag({ nodes: makeDag().nodes.map(n => n.id === "b" ? { ...n, state: "failed" } : n) }));
    act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
    check(lines()[0]!, true, true);
    expect(harness.container.querySelectorAll(".th-activity-gnode--enter,.th-activity-gnode--settle")).toHaveLength(0);
  });
  it("uses safe shelf/run-scoped marker variants even with unsafe raw IDs and sibling unmount", async () => {
    const sibling = mountActivityShelf();
    try {
      const run = pair("completed", "running");
      const runs = ["run(/# one)", "run(/# two)"].map(runId => ({ ...run, runId }));
      renderShelf(harness, activityState({ dags: runs })); openGraph(harness.container);
      renderShelf(sibling, activityState({ dags: runs })); openGraph(sibling.container);
      const markers = [...document.querySelectorAll("marker")].map(e => e.id);
      expect(new Set(markers).size).toBe(markers.length);
      expect(markers.every(id => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
      for (const line of document.querySelectorAll<SVGLineElement>(".th-activity-gedge")) check(line, true, true);
      const survivor = sibling.container.querySelector("line")!;
      const ref = survivor.getAttribute("marker-end");
      renderShelf(harness, activityState());
      expect(survivor.getAttribute("marker-end")).toBe(ref);
      expect(document.getElementById(ref!.slice(5, -1))).not.toBeNull();
    } finally { await unmountActivityShelf(sibling); }
  });
});
