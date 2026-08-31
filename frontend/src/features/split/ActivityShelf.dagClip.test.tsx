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

const NODE_WIDTH = 118;
const koreanLabel = "한글 라벨이 노드 폭을 넘게 길어지는 경우 상태 글리프와 겹칩니다";

describe("ActivityShelf dag graph label clipping", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  // Regression: run ids are free-form (keys may contain parens and other
  // url-unsafe characters); a clip id built from them breaks the url(#…)
  // reference in real Chrome (clip-path computes to none), which jsdom does
  // not catch. Ids must stay in a safe charset.
  // Regression (round-2 review blocker): split panes render one ActivityShelf
  // each, so positional clip ids collide document-wide; when the first pane
  // unmounts, the surviving pane's url(#…) reference dies and Chrome computes
  // clip-path: none. Clip ids must be unique per shelf and survive a sibling
  // shelf unmounting.
  it("gives each shelf unique clip ids that survive a sibling unmounting", async () => {
    const second = mountActivityShelf();
    const openGraph = async (h: ActivityShelfHarness) => {
      renderShelf(h, activityState({
        dags: [makeDag({
          nodes: [{ id: "k", label: koreanLabel, prompt: "p", dependsOn: [], state: "running" }],
          waves: [{ index: 0, nodeIds: ["k"] }],
        })],
      }));
      openShelf(h.container);
      click(requireElement(
        h.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
        "graph toggle",
      ));
      return requireElement(h.container.querySelector<SVGTextElement>(".th-activity-gnode text"), "label");
    };
    const firstLabel = await openGraph(harness);
    const secondLabel = await openGraph(second);
    const firstId = firstLabel.getAttribute("clip-path")!.slice(5, -1);
    const secondId = secondLabel.getAttribute("clip-path")!.slice(5, -1);
    expect(firstId).not.toBe(secondId);

    await unmountActivityShelf(harness);
    expect(document.getElementById(secondId)).not.toBeNull();
    await unmountActivityShelf(second);
  });

  it("builds clip ids from a safe charset regardless of run id characters", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({
        runId: "dag_(paren)+plus/slash",
        nodes: [
          { id: "a)b", label: "라벨", prompt: "p", dependsOn: [], state: "running" },
        ],
        waves: [{ index: 0, nodeIds: ["a)b"] }],
      })],
    }));
    openShelf(harness.container);
    click(requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    ));

    const label = requireElement(
      harness.container.querySelector<SVGTextElement>(".th-activity-gnode text"),
      "node label",
    );
    const clipRef = label.getAttribute("clip-path");
    expect(clipRef).toMatch(/^url\(#[A-Za-z0-9_-]+\)$/);
    const clipId = clipRef!.slice(5, -1);
    expect(clipId).toMatch(/^[A-Za-z0-9_-]+$/);
    const clipEl = requireElement(
      [...harness.container.querySelectorAll("clipPath")].find((el) => el.id === clipId) ?? null,
      "clip element",
    );
    expect(clipEl.querySelector("rect")).not.toBeNull();
  });

  it("clips graph node labels to a rect clear of the status glyph", () => {
    renderShelf(harness, activityState({
      dags: [makeDag({
        nodes: [
          { id: "k", label: "한글 라벨이 노드 폭을 넘게 길어지는 경우 상태 글리프와 겹칩니다", prompt: "korean long label", dependsOn: [], state: "running" },
        ],
        waves: [{ index: 0, nodeIds: ["k"] }],
      })],
    }));
    openShelf(harness.container);
    click(requireElement(
      harness.container.querySelector<HTMLButtonElement>('.th-activity-view-btn[data-view="graph"]'),
      "graph toggle",
    ));

    const label = requireElement(
      harness.container.querySelector<SVGTextElement>(".th-activity-gnode text"),
      "node label",
    );
    const clipRef = label.getAttribute("clip-path");
    expect(clipRef).toMatch(/^url\(#.+\)$/);

    const clipId = clipRef!.slice(5, -1);
    const clipEl = requireElement(
      [...harness.container.querySelectorAll("clipPath")].find((el) => el.id === clipId) ?? null,
      "clip rect",
    );
    const rect = requireElement(clipEl.querySelector("rect"), "clip rect") as SVGRectElement;
    const x = Number(rect.getAttribute("x"));
    const width = Number(rect.getAttribute("width"));
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(width)).toBe(true);
    // The clip must start at or after the label's x origin and end strictly
    // left of the glyph zone, which begins at NODE_WIDTH - 15.
    expect(x).toBeGreaterThanOrEqual(7);
    expect(x + width).toBeLessThanOrEqual(NODE_WIDTH - 22);
  });
});
