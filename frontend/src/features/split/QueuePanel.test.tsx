import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import { QueuePanel } from "./QueuePanel";
import type { QueueEngineItem, QueueEngineSummary, QueuePlaceholder, QueueSlotItem, SteerPendingItem } from "./chatSessionTypes";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => translate("en", key, vars),
};

const item = (id: string, text: string): QueueSlotItem => ({
  id,
  text,
  hasImage: false,
  createdAt: 1000,
});

describe("QueuePanel", () => {
  let root: Root;
  let container: HTMLDivElement;
  let removed: string[];
  let moved: Array<{ itemId: string; toIndex: number }>;
  let cleared: string[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    removed = [];
    moved = [];
    cleared = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  interface RenderOptions {
    readonly items?: readonly QueueSlotItem[];
    readonly placeholders?: readonly QueuePlaceholder[];
    readonly steerPending?: readonly SteerPendingItem[];
    readonly engine?: QueueEngineSummary;
  }

  const engineOf = (pendingMessageCount: number, ordered: readonly QueueEngineItem[] = []): QueueEngineSummary =>
    ({ pendingMessageCount, ordered });

  function render(options: RenderOptions = {}): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <QueuePanel
            items={options.items ?? []}
            engine={options.engine ?? { pendingMessageCount: 0, ordered: [] }}
            placeholders={options.placeholders ?? []}
            steerPending={options.steerPending ?? []}
            onRemove={(itemId) => {
              removed.push(itemId);
            }}
            onMove={(itemId, toIndex) => {
              moved.push({ itemId, toIndex });
            }}
            onClear={(scope) => {
              cleared.push(scope);
            }}
          />
        </I18nContext.Provider>,
      );
    });
  }

  const panel = (): HTMLElement | null => container.querySelector<HTMLElement>(".th-queue");
  const header = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(".th-queue-header");

  it("renders nothing while the queue is empty", () => {
    render();
    expect(panel()).toBeNull();
  });

  it("counts placeholders and confirmed items in the collapsed header", () => {
    render({
      items: [item("q-1", "first")],
      placeholders: [{ requestId: "req-1", text: "second", hasImage: false }],
    });
    expect(header()?.textContent).toContain(translate("en", "queue.count", { count: 2 }));
    expect(header()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the engine count only when the engine queue is non-empty", () => {
    render({ items: [item("q-1", "first")], engine: engineOf(3) });
    expect(header()?.textContent).toContain(translate("en", "queue.engineCount", { count: 3 }));

    render({ items: [item("q-1", "first")], engine: engineOf(0) });
    expect(header()?.textContent).not.toContain("queue.engineCount");
  });

  it("expands into a region listing rows in order with a waiting style", () => {
    render({
      items: [item("q-1", "first"), item("q-2", "second")],
      placeholders: [{ requestId: "req-1", text: "third", hasImage: false }],
    });
    expect(panel()?.getAttribute("role")).toBe("region");
    expect(panel()?.getAttribute("aria-label")).toBe(translate("en", "queue.region"));
    act(() => header()?.click());

    const rows = [...container.querySelectorAll<HTMLElement>(".th-queue-list > .th-queue-row")];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector<HTMLElement>(".th-queue-text")?.textContent).toBe("first");
    expect(rows[0]?.querySelector<HTMLElement>(".th-queue-pos")?.textContent).toBe("1");
    expect(rows[2]?.classList.contains("th-queue-row--placeholder")).toBe(true);
    expect(rows[2]?.textContent).toContain(translate("en", "queue.waiting"));
    // The waiting style must be distinct from sent transcript messages.
    expect(rows[0]?.classList.contains("th-queue-row--waiting")).toBe(true);
  });

  it("sends remove and reorder commands from the row actions", () => {
    render({ items: [item("q-1", "first"), item("q-2", "second"), item("q-3", "third")] });
    act(() => header()?.click());
    const rows = [...container.querySelectorAll<HTMLElement>(".th-queue-list > .th-queue-row")];
    const up = rows[1]?.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", "queue.moveUp")}"]`);
    const down = rows[1]?.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", "queue.moveDown")}"]`);
    const remove = rows[1]?.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", "queue.remove")}"]`);
    expect(up && down && remove).toBeTruthy();
    act(() => up?.click());
    act(() => down?.click());
    act(() => remove?.click());
    expect(moved).toEqual([
      { itemId: "q-2", toIndex: 0 },
      { itemId: "q-2", toIndex: 2 },
    ]);
    expect(removed).toEqual(["q-2"]);
  });

  it("disables reordering past the ends of the queue", () => {
    render({ items: [item("q-1", "first"), item("q-2", "second")] });
    act(() => header()?.click());
    const rows = [...container.querySelectorAll<HTMLElement>(".th-queue-list > .th-queue-row")];
    const firstUp = rows[0]?.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", "queue.moveUp")}"]`);
    const lastDown = rows[1]?.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", "queue.moveDown")}"]`);
    expect(firstUp?.disabled).toBe(true);
    expect(lastDown?.disabled).toBe(true);
  });

  it("sends one clear-all command for both queues", () => {
    render({
      items: [item("q-1", "first")],
      engine: engineOf(1, [{ text: "engine item", mode: "followUp" }]),
    });
    act(() => header()?.click());
    const clear = container.querySelector<HTMLButtonElement>(".th-queue-clear");
    expect(clear?.textContent).toBe(translate("en", "queue.clearAll"));
    act(() => clear?.click());
    expect(cleared).toEqual(["all"]);
  });

  it("renders engine rows read-only with no action buttons", () => {
    render({
      items: [item("q-1", "first")],
      engine: engineOf(2, [{ text: "engine item", mode: "steer" }]),
    });
    act(() => header()?.click());
    const engineRows = [...container.querySelectorAll<HTMLElement>(".th-queue-row--engine")];
    expect(engineRows).toHaveLength(1);
    expect(engineRows[0]?.querySelector<HTMLElement>(".th-queue-text")?.textContent).toBe("engine item");
    expect(engineRows[0]?.querySelectorAll("button")).toHaveLength(0);
  });
});
