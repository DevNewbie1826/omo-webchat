import { describe, expect, it } from "vitest";
import { splitLeaf } from "./paneTree";
import type { PaneNode } from "./paneTree";
import { parseLayout } from "./useLayout";

function paneIds(node: PaneNode): readonly string[] {
  if (node.kind === "leaf") return [node.id];
  return [node.id, ...paneIds(node.first), ...paneIds(node.second)];
}

describe("restored pane layouts", () => {
  it("generates ids that cannot collide with restored pane ids", () => {
    const restored = parseLayout({
      kind: "split",
      id: "pane-1",
      dir: "h",
      ratio: 0.5,
      first: { kind: "leaf", id: "pane-2", sessionId: "terminal-1" },
      second: { kind: "leaf", id: "pane-3", sessionId: null },
    });
    expect(restored).not.toBeNull();
    if (!restored) return;

    const restoredIds = new Set(paneIds(restored));
    const split = splitLeaf(restored, "pane-2", "v");
    const generatedIds = paneIds(split).filter((id) => !restoredIds.has(id));

    expect(generatedIds).toHaveLength(2);
    expect(new Set(generatedIds).size).toBe(generatedIds.length);
  });
});
