import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityState,
  click,
  makeDag,
  mountActivityShelf,
  openShelf,
  renderShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { requireElement } from "./chatPaneTestHarness";
import type { ActivityDagNode } from "./activityTypes";
import { splitNodeLabel } from "./activityShelfDag";

/** Synthetic but realistic English sentences, repeated to length. The real
 *  run payload ships 5-10K prompts per node; the title sites must never
 *  touch them. */
const SENTENCE = "Review the cold history loader for the v4 hydration path, "
  + "confirm the recovery server replays every retained frame before the client "
  + "transport resumes, and keep the parse cache warm while the ws bridge drains "
  + "its liveness queue without dropping acked entries. ";

function promptOf(length: number): string {
  return SENTENCE.repeat(Math.ceil(length / SENTENCE.length)).slice(0, length);
}

interface FixtureNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly state: "completed" | "running" | "pending";
  readonly promptLength: number;
}

const FIXTURE_NODES: readonly FixtureNode[] = [
  { id: "contract", dependsOn: [], state: "completed", promptLength: 5_230 },
  { id: "coldhistory", dependsOn: ["contract"], state: "completed", promptLength: 5_512 },
  { id: "recovery-server", dependsOn: ["contract"], state: "completed", promptLength: 6_104 },
  { id: "hydrate-v4", dependsOn: ["coldhistory", "recovery-server"], state: "running", promptLength: 10_185 },
  { id: "wsbridge-v4", dependsOn: ["hydrate-v4"], state: "pending", promptLength: 5_356 },
  { id: "rest-history", dependsOn: ["hydrate-v4"], state: "completed", promptLength: 5_861 },
  { id: "ws-liveness", dependsOn: ["wsbridge-v4"], state: "pending", promptLength: 5_447 },
  { id: "parse-cache", dependsOn: ["rest-history"], state: "running", promptLength: 6_620 },
  { id: "client-transport", dependsOn: ["wsbridge-v4", "rest-history"], state: "pending", promptLength: 7_208 },
  { id: "client-history", dependsOn: ["parse-cache", "client-transport"], state: "pending", promptLength: 6_873 },
  { id: "client-view", dependsOn: ["client-history", "client-transport"], state: "pending", promptLength: 5_999 },
  { id: "docs", dependsOn: ["client-view"], state: "pending", promptLength: 5_130 },
  { id: "verify-suites", dependsOn: ["docs", "client-view"], state: "pending", promptLength: 8_440 },
  { id: "verify-live", dependsOn: ["verify-suites", "ws-liveness"], state: "pending", promptLength: 9_377 },
  { id: "pr", dependsOn: ["verify-live", "verify-suites"], state: "pending", promptLength: 5_705 },
  { id: "review", dependsOn: ["pr"], state: "pending", promptLength: 6_266 },
];

function fixtureNodes(): ActivityDagNode[] {
  return FIXTURE_NODES.map((node) => ({
    id: node.id,
    prompt: promptOf(node.promptLength),
    dependsOn: node.dependsOn,
    state: node.state,
  }));
}

function freezeRun(overrides: { nodes?: ActivityDagNode[]; status?: "running" | "completed" } = {}) {
  const nodes = overrides.nodes ?? fixtureNodes();
  const counts = { total: 16, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const node of nodes) counts[node.state as "completed" | "running" | "pending"] += 1;
  return makeDag({
    runId: "run-freeze",
    runKey: "history-hybrid",
    name: "History hybrid v4",
    status: overrides.status ?? "running",
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id }))),
    waves: [],
    counts,
  });
}

/** At the harness font (13), the desktop card basis is 120px, so the cap is
 *  240px. A single short-id run paints the base width; only a pathological
 *  label can push a card toward the ceiling. */
const CARD_WIDTH_CAP = 240;

describe("ActivityShelf DAG title freeze", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  it("renders every graph node title as the node id, never the prompt", () => {
    renderShelf(harness, activityState({ dags: [freezeRun()] }));
    openShelf(harness.container);
    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    expect(graph.querySelectorAll(".th-activity-gnode")).toHaveLength(16);

    for (const fixture of FIXTURE_NODES) {
      const group = requireElement(
        graph.querySelector(`.th-activity-gnode[data-node="${fixture.id}"]`),
        `node ${fixture.id}`,
      );
      const lines = [...group.querySelectorAll(".th-activity-glabel")];
      expect(lines.length, `title rows for ${fixture.id}`).toBeGreaterThan(0);
      expect(lines.map((line) => line.textContent ?? "").join(""), `title for ${fixture.id}`)
        .toBe(fixture.id);
    }
  });

  it("keeps every prompt substring out of visible graph and list titles", () => {
    renderShelf(harness, activityState({ dags: [freezeRun()] }));
    openShelf(harness.container);
    const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
    const visibleTitles = [...graph.querySelectorAll(".th-activity-glabel")]
      .map((line) => line.textContent ?? "")
      .join("\n");

    for (const fixture of FIXTURE_NODES) {
      const prompt = promptOf(fixture.promptLength);
      expect(visibleTitles.includes(prompt.slice(0, 120)), `prompt of ${fixture.id}`).toBe(false);
      const group = requireElement(
        graph.querySelector(`.th-activity-gnode[data-node="${fixture.id}"]`),
        `node ${fixture.id}`,
      );
      expect(group.querySelector("title")?.textContent).toContain(prompt.slice(0, 120));
    }

    click(requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="list"]'),
      "list toggle",
    ));
    const rows = [...harness.container.querySelectorAll(".th-activity-dnode")];
    expect(rows).toHaveLength(16);
    const labels = rows.map((row) => requireElement(row.querySelector(".th-activity-dnode-label"), "list label"));
    expect(labels.map((label) => label.textContent)).toEqual(FIXTURE_NODES.map((fixture) => fixture.id));
    for (let index = 0; index < labels.length; index += 1) {
      expect(labels[index]?.getAttribute("title")).toBe(promptOf(FIXTURE_NODES[index]!.promptLength));
      expect(labels[index]?.textContent?.includes(promptOf(FIXTURE_NODES[index]!.promptLength).slice(0, 120)))
        .toBe(false);
    }
  });

  it("fits a 10,000-character title with a bounded number of measure calls", () => {
    let calls = 0;
    const measure = (text: string): number => {
      calls += 1;
      return Array.from(text).length;
    };
    const text = `${"a".repeat(9_000)} ${"b".repeat(999)}`;
    const lines = splitNodeLabel(text, 4_000, 8_000, measure);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(24);
    // The second line fits after the first-line break: no ellipsis needed
    // and the original text is recovered by joining the rows.
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(false);
    expect(lines.join("")).toBe(text);
  });

  it("caps a 600-character label at two lines with an ellipsis and clamps the card width", () => {
    renderShelf(harness, activityState({
      dags: [freezeRun({
        nodes: [{
          id: "wide-label-node",
          label: "x".repeat(600),
          prompt: "p",
          dependsOn: [],
          state: "running",
        }],
      })],
    }));
    openShelf(harness.container);
    const card = requireElement(
      harness.container.querySelector<SVGRectElement>(".th-activity-gnode-card"),
      "node card",
    );
    const width = Number(card.getAttribute("width"));
    expect(Number.isFinite(width)).toBe(true);
    expect(width).toBeLessThanOrEqual(CARD_WIDTH_CAP);
    expect(width).toBeGreaterThan(120);

    const lines = [
      ...requireElement(harness.container.querySelector(".th-activity-gnode"), "graph node")
        .querySelectorAll(".th-activity-glabel"),
    ];
    expect(lines.length).toBeLessThanOrEqual(2);
    const last = lines[lines.length - 1]?.textContent ?? "";
    expect(last.endsWith("\u2026")).toBe(true);
    expect(lines.map((line) => line.textContent ?? "").join("")).not.toBe("x".repeat(600));
  });

  it("keeps card width and positions identical across a pending to running flip", () => {
    renderShelf(harness, activityState({ dags: [freezeRun()] }));
    openShelf(harness.container);
    const snapshot = () => {
      const graph = requireElement(harness.container.querySelector(".th-activity-graph"), "graph view");
      return [...graph.querySelectorAll<SVGGElement>(".th-activity-gnode")].map((node) => ({
        id: node.getAttribute("data-node"),
        transform: node.getAttribute("transform"),
        width: node.querySelector(".th-activity-gnode-card")?.getAttribute("width"),
        height: node.querySelector(".th-activity-gnode-card")?.getAttribute("height"),
      }));
    };
    const before = snapshot();

    const flipped = fixtureNodes().map((node) =>
      node.id === "wsbridge-v4" ? { ...node, state: "running" as const } : node);
    renderShelf(harness, activityState({ dags: [freezeRun({ nodes: flipped })] }));
    const after = snapshot();

    expect(after).toEqual(before);
  });
});
