import { readFileSync } from "node:fs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ActivityShelf } from "./ActivityShelf";
import { activityState, mountActivityShelf, unmountActivityShelf, type ActivityShelfHarness } from "./ActivityShelf.support";
import { i18n, requireElement } from "./chatPaneTestHarness";

/**
 * Real-layout regression coverage for the DAG list continuation sentinel.
 *
 * The r2 QA boundary: with the DAG tabpanel scrolled flush to its end, the
 * settled sentinel rendered with zero height and the browser's intersection
 * contract reported it NOT intersecting, so scroll continuation never fired
 * and no second catalog request left the app. These tests pin the two sides
 * of that contract against the real shipped layout, not a forced stub:
 *
 *  - jsdom runs the real cascade (selector matching, specificity, sheet
 *    order) over the actual stylesheets, so the sentinel's cascaded
 *    min-height — the only height-giving declaration on the empty box — is
 *    the rendered-height contract the browser lays out.
 *  - The IntersectionObserver stand-in below computes isIntersecting from
 *    getBoundingClientRect geometry exactly as the observed browser
 *    contract behaves: a zero-height target never intersects, and a
 *    non-zero target intersects only while it vertically overlaps the
 *    observing root's clip rect. Tests position the sentinel and the
 *    scrollport through those rects, never by forcing isIntersecting.
 */

const revision = "2026-09-08T10:00:00Z";
const base = "/api/workspaces/ws/chats/chat/dag-runs";
const firstPage = `${base}?limit=10`;
const pageAfter = (cursor: string) => `${base}?limit=10&cursor=${encodeURIComponent(cursor)}`;
const states = ["pending", "blocked", "scheduled", "running", "completed", "failed", "cancelled", "skipped"] as const;

function full(runId: string) {
  const nodes = Array.from({ length: 3 }, (_, index) => ({
    id: `${runId}-node-${index}`, label: `node-${index}`, prompt: `${runId} step ${index}`,
    depends_on: index === 0 ? [] : [`${runId}-node-${index - 1}`],
    state: states[index % states.length] ?? "pending", attempt: index, task_id: `task-${index}`,
    started_at: revision, completed_at: revision,
  }));
  const counts = { total: 3, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const node of nodes) counts[node.state]++;
  return { complete: true, content_token: `token-${runId}`, run: {
    run_id: runId, run_key: "key", name: runId, status: "running", updated_at: revision, counts, nodes,
    edges: nodes.flatMap(node => node.depends_on.map(from => ({ from, to: node.id }))), waves: [],
  } };
}
function catalog(ids: readonly string[], next: string | null) {
  return { runs: ids.map(run_id => ({ run_id, run_key: "key", name: run_id, status: "running", total: 3, content_token: `catalog-${run_id}` })), next_cursor: next };
}

type Request = { readonly url: string; readonly signal: AbortSignal | null | undefined; readonly resolve: (response: Response) => void };

/** Recorded observer arming: callback, the root it was constructed with, and
 *  its live targets. The root is what the arming contract is asserted on. */
interface Arming {
  readonly callback: IntersectionObserverCallback;
  readonly root: Element | Document | null;
  readonly targets: Set<Element>;
}
const armings: Arming[] = [];
class ScrollportIntersectionObserver {
  readonly callback: IntersectionObserverCallback;
  readonly root: Element | Document | null;
  readonly targets = new Set<Element>();
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    armings.push(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void {
    this.targets.clear();
    const index = armings.indexOf(this);
    if (index >= 0) armings.splice(index, 1);
  }
}

interface Rect { readonly top: number; readonly bottom: number }
/** The observed browser intersection contract: a zero-height target box
 *  never intersects; a taller one intersects only while it vertically
 *  overlaps the clip rect it is judged against (the root element's rect, or
 *  the viewport rect for an unrooted observer). */
function intersects(target: Element, root: Element | Document | null): boolean {
  const targetBox = target.getBoundingClientRect();
  // An element root clips by its own rect; a document or unrooted observer
  // clips by the viewport band.
  const clip: Rect = root instanceof Element ? root.getBoundingClientRect() : { top: 0, bottom: 800 };
  return targetBox.bottom - targetBox.top > 0 && targetBox.bottom > clip.top && targetBox.top < clip.bottom;
}
/** Delivers the current geometry to every live arming, synchronously, as the
 *  browser would deliver its initial and scroll entries. */
function deliver(): void {
  act(() => {
    for (const arming of [...armings]) {
      const visible = [...arming.targets].filter(target => intersects(target, arming.root));
      if (visible.length === 0) continue;
      arming.callback(visible.map(target => ({ target, isIntersecting: true } as IntersectionObserverEntry)),
        arming as unknown as IntersectionObserver);
    }
  });
}
function placeAt(el: Element, rect: Rect): void {
  const height = rect.bottom - rect.top;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top: rect.top, bottom: rect.bottom, height, y: rect.top, left: 0, right: 742, width: 742, x: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** The DAG tabpanel's visible band, matching the shipped panel: a 262px
 *  scrollport inside an 800px viewport. */
const PANEL_CLIP: Rect = { top: 500, bottom: 762 };

describe("complete DAG list-end sentinel layout and continuation geometry", () => {
  let harness: ActivityShelfHarness;
  let requests: Request[];
  let styleElements: HTMLStyleElement[];

  beforeEach(() => {
    // The real stylesheets, so jsdom's genuine cascade answers the layout
    // contract instead of test-authored geometry.
    styleElements = ["tokens.css", "activity-shelf.css"].map(file => {
      const el = document.createElement("style");
      el.textContent = readFileSync(`src/styles/${file}`, "utf8");
      document.head.appendChild(el);
      return el;
    });
    harness = mountActivityShelf();
    requests = [];
    armings.length = 0;
    vi.stubGlobal("IntersectionObserver", ScrollportIntersectionObserver);
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => new Promise<Response>(resolve => {
      requests.push({ url: input, signal: init?.signal, resolve });
    }));
  });
  afterEach(async () => {
    await unmountActivityShelf(harness);
    for (const el of styleElements) el.remove();
    styleElements = [];
  });

  function render() {
    act(() => harness.root.render(<I18nContext.Provider value={i18n}><ActivityShelf
      activities={activityState()} dagSource={{ wsId: "ws", chatId: "chat", connected: true }} /></I18nContext.Provider>));
  }
  function open() {
    act(() => { requireElement(harness.container.querySelector('[data-activity-tab="dag"]'), "DAG tab").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })); });
  }
  function request(url: string, index = 0): Request {
    const found = requests.filter(item => item.url === url)[index];
    expect(found, `request ${url} #${index}`).toBeDefined();
    if (!found) throw new Error(`Missing request: ${url}`);
    return found;
  }
  async function reply(item: Request, body: unknown, status = 200) {
    await act(async () => { item.resolve(new Response(JSON.stringify(body), { status })); });
  }
  const rowIds = () => [...harness.container.querySelectorAll("[data-activity-dag-run]")].map(row => row.getAttribute("data-activity-dag-run"));
  const sentinel = () => requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "sentinel");
  /** The sentinel's rendered-height contract: its only height-giving
   *  declaration is the cascaded min-height on the empty box. */
  const sentinelHeight = (target: Element): number => Number.parseFloat(getComputedStyle(target).minHeight) || 0;
  const askedFor = (url: string): number => requests.filter(item => item.url === url).length;

  it("renders the settled sentinel as a non-zero-height box at the end of the list flow", async () => {
    render(); open();
    await reply(request(firstPage), catalog(["r1"], "cursor-2"));
    await reply(request(`${base}/r1`), full("r1"));
    const section = requireElement(harness.container.querySelector(".th-activity-dag-complete"), "complete DAG section");
    const target = sentinel();
    // In the list flow: the sentinel is the section's trailing layout box,
    // after every run row, and is not removed from flow.
    expect(section.lastElementChild).toBe(target);
    expect(getComputedStyle(target).display).not.toBe("none");
    // The zero-height geometry that stalled continuation cannot return: the
    // empty box must carry a guaranteed non-zero rendered height.
    expect(sentinelHeight(target)).toBeGreaterThanOrEqual(1);
  });

  it("arms continuation against the real DAG tabpanel scrollport, not the viewport", async () => {
    render(); open();
    await reply(request(firstPage), catalog(["r1"], "cursor-2"));
    await reply(request(`${base}/r1`), full("r1"));
    const panel = requireElement(harness.container.querySelector('[data-activity-tabpanel="dag"]'), "DAG tabpanel");
    // The shipped layout really makes this element the scrollport the
    // sentinel travels in: its overflow clips the list. Both forms are read
    // because some layout engines expose the `overflow` shorthand without
    // its `overflow-y` longhand; the sheet declares plain `overflow: auto`.
    const overflow = getComputedStyle(panel);
    expect(overflow.overflowY === "auto" || overflow.overflowY === "scroll"
      || overflow.overflow === "auto" || overflow.overflow === "scroll", "tabpanel clips its list").toBe(true);
    expect(sentinel().parentElement?.parentElement).toBe(panel);
    const live = armings.filter(arming => arming.targets.has(sentinel()));
    expect(live.length).toBeGreaterThan(0);
    for (const arming of live) expect(arming.root, "observer root").toBe(panel);
  });

  it("continues the settled list only when the real sentinel box intersects the real scrollport", async () => {
    const firstTen = Array.from({ length: 10 }, (_unused, index) => `first-${index}`);
    const secondTen = Array.from({ length: 10 }, (_unused, index) => `second-${index}`);
    render(); open();
    await reply(request(firstPage), catalog(firstTen, "cursor-2"));
    const target = sentinel();
    const panel = requireElement(harness.container.querySelector('[data-activity-tabpanel="dag"]'), "DAG tabpanel");
    placeAt(panel, PANEL_CLIP);
    const height = sentinelHeight(target);
    expect(height).toBeGreaterThanOrEqual(1);
    // Not scrolled to the end: the sentinel box sits wholly below the
    // scrollport band — no continuation may fire.
    placeAt(target, { top: PANEL_CLIP.bottom + 40, bottom: PANEL_CLIP.bottom + 40 + height });
    deliver();
    expect(askedFor(pageAfter("cursor-2"))).toBe(0);
    // Placeholders flush at the list end: their provisional height keeps the
    // sentinel in the band, but an unsettled list end must not consume a page.
    placeAt(target, { top: PANEL_CLIP.bottom - height, bottom: PANEL_CLIP.bottom });
    deliver();
    expect(askedFor(pageAfter("cursor-2"))).toBe(0);
    for (const id of firstTen) await reply(request(`${base}/${id}`), full(id));
    // The r2 boundary, restated as the browser contract: a zero-height
    // sentinel — even flush inside the scrollport band — never intersects,
    // so nothing fires. The shipped min-height is what makes it fire.
    placeAt(target, { top: PANEL_CLIP.bottom, bottom: PANEL_CLIP.bottom });
    deliver();
    expect(askedFor(pageAfter("cursor-2"))).toBe(0);
    // Settled list end scrolled flush: the real-height box intersects the
    // scrollport and consumes exactly one further page of ten.
    placeAt(target, { top: PANEL_CLIP.bottom - height, bottom: PANEL_CLIP.bottom });
    deliver();
    expect(askedFor(pageAfter("cursor-2"))).toBe(1);
    await reply(request(pageAfter("cursor-2")), catalog(secondTen, "cursor-3"));
    expect(rowIds()).toEqual([...firstTen, ...secondTen]);
    // The appended rows are placeholders again: still not a settled end.
    deliver();
    expect(askedFor(pageAfter("cursor-3"))).toBe(0);
    for (const id of secondTen) await reply(request(`${base}/${id}`), full(id));
    deliver();
    expect(askedFor(pageAfter("cursor-3"))).toBe(1);
    await reply(request(pageAfter("cursor-3")), catalog([], null));
    expect(harness.container.querySelector("[data-activity-dag-sentinel]")).toBeNull();
    expect(rowIds()).toEqual([...firstTen, ...secondTen]);
    expect(askedFor(pageAfter("cursor-2"))).toBe(1);
    expect(askedFor(pageAfter("cursor-3"))).toBe(1);
  });
});
