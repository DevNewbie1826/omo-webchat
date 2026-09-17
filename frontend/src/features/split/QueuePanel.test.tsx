import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue } from "../../i18n";
import { QueuePanel } from "./QueuePanel";
import type { QueueEngineItem, QueueEngineSummary, QueuePlaceholder, QueueSlotItem } from "./chatSessionTypes";

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
  let styleEl: HTMLStyleElement | null = null;
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
    styleEl?.remove();
    styleEl = null;
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  interface RenderOptions {
    readonly items?: readonly QueueSlotItem[];
    readonly placeholders?: readonly QueuePlaceholder[];
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

  it("names the engine queue by what is parked in it", () => {
    // A parked steer and a queued follow-up mean different things to the user;
    // the mirrored rows carry the mode, so the header says which it is.
    render({ engine: engineOf(1, [{ text: "redirect now", mode: "steer" }]) });
    expect(header()?.textContent).toContain(translate("en", "queue.engineSteer", { count: 1 }));

    render({ engine: engineOf(2, [{ text: "later", mode: "followUp" }, { text: "also later", mode: "followUp" }]) });
    expect(header()?.textContent).toContain(translate("en", "queue.engineFollowUp", { count: 2 }));

    render({ engine: engineOf(3, [
      { text: "redirect now", mode: "steer" },
      { text: "later", mode: "followUp" },
      { text: "also later", mode: "followUp" },
    ]) });
    expect(header()?.textContent).toContain(translate("en", "queue.engineSteer", { count: 1 }));
    expect(header()?.textContent).toContain(translate("en", "queue.engineFollowUp", { count: 2 }));
  });

  it("falls back to the plain engine count when only a count arrived", () => {
    // get_state reports the count without the rows; there is no mode to name.
    render({ engine: engineOf(2, []) });
    expect(header()?.textContent).toContain(translate("en", "queue.engineCount", { count: 2 }));
  });

  it("mirrors an engine queue whose live event reported rows without a count", () => {
    // Observed engine behavior: queue_update carries steering/followUp/ordered
    // and no pendingMessageCount, so the mirrored rows are the only evidence
    // that a steer is parked. Hiding the panel on the missing count erased it.
    render({ engine: engineOf(0, [{ text: "redirect now", mode: "steer" }]) });
    expect(panel()).not.toBeNull();
    expect(header()?.textContent).toContain(translate("en", "queue.engineSteer", { count: 1 }));

    act(() => header()?.click());
    const engineRow = container.querySelector<HTMLElement>(".th-queue-row--engine");
    expect(engineRow?.textContent).toContain("redirect now");
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

  it("shows the complete parked steer original in the expanded engine row", () => {
    // The status strip's inspect dialog is retired: the expanded queue panel
    // is the record, so a long parked steer must read in full there. jsdom
    // runs the real cascade (selector matching, specificity, order) once the
    // real stylesheet is injected, so getComputedStyle observes the same
    // truncation a browser paints; it needs no layout for the declarations
    // asserted here, which carry no var() (see typeScale.test.ts).
    styleEl = document.createElement("style");
    styleEl.textContent = readFileSync("src/styles/chat-pane.css", "utf8");
    document.head.appendChild(styleEl);

    // 210 characters: the original that measured 966px of content inside a
    // 332px box in the real Chromium render of the truncated panel.
    const sentence =
      "steer: hold the queue, rework the migration around the renamed fields, and confirm the plan before resuming; ";
    const original = (sentence + sentence).slice(0, 210);
    expect(original).toHaveLength(210);

    render({
      items: [item("q-1", "queued webchat message")],
      engine: engineOf(0, [{ text: original, mode: "steer" }]),
    });
    act(() => header()?.click());

    const row = container.querySelector<HTMLElement>(".th-queue-row--engine");
    const text = row?.querySelector<HTMLElement>(".th-queue-text");
    expect(row && text).toBeTruthy();
    // The row carries the complete original, not a truncation of it.
    expect(row?.textContent).toBe(original);
    expect(text?.getAttribute("title")).toBe(original);
    // ...and the cascade lets it read instead of ellipsizing: the engine
    // mirror wraps over as many lines as it needs and breaks long unbroken
    // strings rather than clipping them.
    const computed = getComputedStyle(text as HTMLElement);
    expect(computed.whiteSpace).toBe("pre-wrap");
    expect(computed.overflowWrap).toBe("anywhere");
    expect(computed.overflow).toBe("visible");

    // The webchat-owned waiting rows keep their single-line truncation.
    const waitingText = container.querySelector<HTMLElement>(".th-queue-row--waiting .th-queue-text");
    const waitingComputed = getComputedStyle(waitingText as HTMLElement);
    expect(waitingComputed.whiteSpace).toBe("nowrap");
    expect(waitingComputed.textOverflow).toBe("ellipsis");
  });
});
