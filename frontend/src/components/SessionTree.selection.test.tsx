import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTree } from "./SessionTree";
import type { Workspace } from "../features/workspace/workspace";

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [
    { id: "tm-alpha", name: "Alpha", provider: "omo" },
    { id: "tm-beta", name: "Beta", provider: "omo" },
    { id: "tm-gamma", name: "Gamma", provider: "omo" },
  ],
};

const sessions = [
  { id: "tm-alpha", name: "Alpha", source: "stored" as const, recencyMs: 3 },
  { id: "tm-beta", name: "Beta", source: "stored" as const, recencyMs: 2 },
  { id: "tm-gamma", name: "Gamma", source: "stored" as const, recencyMs: 1 },
];

const TREE = { left: 10, top: 100 };
const rowTops = new Map<string, number>();

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

class ManualResizeObserver {
  static instances: ManualResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe("SessionTree selection indicator", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", ManualResizeObserver);
    ManualResizeObserver.instances = [];
    rowTops.clear();
    rowTops.set("Workspace", 100).set("Alpha", 138).set("Beta", 176).set("Gamma", 214);
    // jsdom has no layout: rows report the geometry a real browser would.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("th-tree")) return box(TREE.left, TREE.top, 248, 400);
      if (this.classList.contains("th-tree-node")) {
        const label = this.querySelector(".th-tree-label")?.textContent ?? "";
        const nested = this.closest(".th-tree-children") !== null;
        return box(nested ? TREE.left + 20 : TREE.left, rowTops.get(label) ?? 0, nested ? 228 : 248, 36);
      }
      return box(0, 0, 0, 0);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(activeTerminalId: string | null, expanded: ReadonlySet<string> = new Set(["ws-1"])): void {
    act(() => {
      root.render(
        <SessionTree
          workspaces={[workspace]}
          liveSessions={new Set()}
          activeTerminalId={activeTerminalId}
          placedSessions={new Set(activeTerminalId ? [activeTerminalId] : [])}
          expanded={expanded}
          sessionLists={new Map([["ws-1", sessions]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
          onOpen={async () => undefined}
          onAddTerminal={() => undefined}
          onDeleteWorkspace={() => undefined}
          onDeleteTerminal={() => undefined}
          onRenameWorkspace={async () => undefined}
          onRenameTerminal={async () => undefined}
          notify={() => undefined}
        />,
      );
    });
  }

  const indicators = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(".th-tree-indicator"));
  const visible = (element: HTMLElement): boolean => element.classList.contains("th-tree-indicator--visible");

  it("renders one decorative indicator placed on the active row", () => {
    render("tm-beta");

    const [indicator, ...rest] = indicators();
    expect(rest).toHaveLength(0);
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".th-tree")?.firstElementChild).toBe(indicator);
    expect(visible(indicator!)).toBe(true);
    expect(indicator?.style.transform).toBe("translateY(76px)");
    expect(indicator?.style.left).toBe("20px");
    expect(indicator?.style.width).toBe("228px");
    expect(indicator?.style.height).toBe("36px");
    expect(container.querySelector(".th-tree-node--active .th-tree-activation")?.getAttribute("aria-current")).toBe("true");
  });

  it("moves the same element when the selection changes, ending on the last target", () => {
    render("tm-alpha");
    const indicator = indicators()[0];
    expect(indicator?.style.transform).toBe("translateY(38px)");

    render("tm-beta");
    render("tm-gamma");

    expect(indicators()).toHaveLength(1);
    expect(indicators()[0]).toBe(indicator);
    expect(indicator?.style.transform).toBe("translateY(114px)");
    expect(visible(indicator!)).toBe(true);
  });

  it("hides while the active row is collapsed or absent and returns on the row", () => {
    render("tm-gamma");
    const indicator = indicators()[0]!;

    render("tm-gamma", new Set());
    expect(visible(indicator)).toBe(false);

    render("tm-gamma");
    expect(visible(indicator)).toBe(true);
    expect(indicator.style.transform).toBe("translateY(114px)");

    render(null);
    expect(visible(indicator)).toBe(false);
  });

  it("follows the active row when layout moves it without a render", () => {
    render("tm-beta");
    const indicator = indicators()[0]!;
    expect(indicator.style.transform).toBe("translateY(76px)");

    rowTops.set("Beta", 196);
    act(() => ManualResizeObserver.instances.at(-1)?.fire());

    expect(indicator.style.transform).toBe("translateY(96px)");
    expect(visible(indicator)).toBe(true);
  });
});
