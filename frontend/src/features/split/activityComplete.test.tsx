import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ActivityShelf } from "./ActivityShelf";
import { activityState, click, makeDag, mountActivityShelf, unmountActivityShelf, type ActivityShelfHarness } from "./ActivityShelf.support";
import { i18n, renderChatPane, requireElement } from "./chatPaneTestHarness";
import { applyActivityEvent, applyActivityHistorySnapshot } from "./activityState";
import type { ActivityState } from "./activityTypes";

const revision = "2026-09-08T10:00:00Z";
const newer = "2026-09-08T10:01:00Z";
const base = "/api/workspaces/ws/chats/chat/dag-runs";
/** The DAG tab restores the vertical run list: the catalog is paged by a
 *  fixed page size of ten newest-first runs, one page per sentinel reveal. */
const firstPage = `${base}?limit=10`;
const pageAfter = (cursor: string) => `${base}?limit=10&cursor=${encodeURIComponent(cursor)}`;
const states = ["pending", "blocked", "scheduled", "running", "completed", "failed", "cancelled", "skipped"] as const;
function full(runId = "r1", updatedAt = revision, size = 3) {
  const nodes = Array.from({ length: size }, (_, index) => ({
    id: `original-${index}-${"x".repeat(520)}`, label: `node-${index}`, prompt: `${index}:\n${"description ".repeat(200)}`,
    depends_on: index === 0 ? [] : [`original-${index - 1}-${"x".repeat(520)}`],
    state: states[index % states.length] ?? "pending", attempt: index, task_id: `task-${index}`,
    started_at: revision, completed_at: newer,
  }));
  const counts = { total: size, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const node of nodes) counts[node.state]++;
  return { complete: true, content_token: `token-${runId}-${updatedAt}`, run: {
    run_id: runId, run_key: "key", name: runId, status: "running", updated_at: updatedAt, counts, nodes,
    edges: nodes.flatMap(node => node.depends_on.map(from => ({ from, to: node.id }))), waves: [],
  } };
}
function catalog(ids = ["r1"], next: string | null = null) {
  return { runs: ids.map(run_id => ({ run_id, run_key: "key", name: run_id, status: "running", total: 3, content_token: `catalog-${run_id}` })), next_cursor: next };
}
function projected(document = full(), retained = 1) {
  const parsed = applyActivityEvent(activityState(), "omo.dag.updated", { runs: [document.run] });
  return activityState({ dags: [...parsed.dags.values()].map(run => {
    const nodes = run.nodes.slice(0, retained).map(node => ({ ...node, prompt: node.prompt.slice(0, 512), dependsOn: [] }));
    const counts = { ...run.counts, total: nodes.length };
    for (const state of states) counts[state] = nodes.filter(node => node.state === state).length;
    return { ...run, truncated: true, nodes, counts, edges: [], waves: [] };
  }), truncatedDags: true });
}
const partial = () => projected();
function uniform(state: "running" | "completed", updatedAt = revision, token: string = state) {
  const document = full("r1", updatedAt, 2);
  return { ...document, content_token: token, run: { ...document.run, status: state,
    counts: { ...document.run.counts, pending: 0, blocked: 0, [state]: 2 },
    nodes: document.run.nodes.map(node => ({ ...node, state, attempt: 1 })),
  } };
}

type Request = { readonly url: string; readonly signal: AbortSignal | null | undefined; readonly resolve: (response: Response) => void };
/** Controllable IntersectionObserver stand-in: the sentinel test decides when
 *  the browser would report visibility, so no timing enters the assertions. */
const observers: { readonly callback: IntersectionObserverCallback; readonly targets: Set<Element> }[] = [];
class IntersectionObserverStub {
  readonly callback: IntersectionObserverCallback;
  readonly targets = new Set<Element>();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void {
    this.targets.clear();
    const index = observers.indexOf(this);
    if (index >= 0) observers.splice(index, 1);
  }
}
function revealSentinel(target: Element): void {
  const entry = { target, isIntersecting: true } as IntersectionObserverEntry;
  act(() => {
    for (const observer of [...observers]) {
      if (observer.targets.has(target)) observer.callback([entry], observer as unknown as IntersectionObserver);
    }
  });
}

describe("complete DAG dashboard", () => {
  let harness: ActivityShelfHarness;
  let requests: Request[];
  beforeEach(() => {
    harness = mountActivityShelf();
    requests = [];
    observers.length = 0;
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => new Promise<Response>(resolve => {
      requests.push({ url: input, signal: init?.signal, resolve });
    }));
  });
  afterEach(async () => { await unmountActivityShelf(harness); });
  function render(activities = partial(), connected = true, chatId = "chat") {
    // Spread lets this test use the existing shelf seam before the new binding exists.
    const props = { activities, dagSource: { wsId: "ws", chatId, connected } };
    act(() => harness.root.render(<I18nContext.Provider value={i18n}><ActivityShelf {...props} /></I18nContext.Provider>));
  }
  function open() {
    click(requireElement(harness.container.querySelector('[data-activity-tab="dag"]'), "DAG tab"));
  }
  function request(url: string, index = 0): Request {
    const found = requests.filter(item => item.url === url)[index];
    expect(found, `automatic authorized request ${url} #${index}`).toBeDefined();
    if (!found) throw new Error(`Missing request: ${url}`);
    return found;
  }
  async function reply(item: Request, body: unknown, status = 200) {
    await act(async () => { item.resolve(new Response(JSON.stringify(body), { status })); });
  }
  async function load() {
    render(); open();
    await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), full());
  }
  const rowOf = (id: string) => requireElement(harness.container.querySelector(`[data-activity-dag-run="${id}"]`), `run row ${id}`);
  const rowIds = () => [...harness.container.querySelectorAll("[data-activity-dag-run]")].map(row => row.getAttribute("data-activity-dag-run"));
  const nodes = (scope: ParentNode = harness.container) => [...scope.querySelectorAll(".th-activity-gnode")].map(node => node.getAttribute("data-node"));
  const status = (id?: string) => (id === undefined
    ? harness.container.querySelector("[data-activity-dag-status]")
    : rowOf(id))?.getAttribute("data-activity-dag-status");
  const catalogStatus = () => harness.container.querySelector(".th-activity-dag-complete")?.getAttribute("data-activity-dag-catalog");

  it("renders the newest ten catalog runs as a vertical list in order with per-run headers", async () => {
    const ids = Array.from({ length: 10 }, (_unused, index) => `run-${index}`);
    render(); open();
    await reply(request(firstPage), catalog(ids, "cursor-2"));
    for (const id of ids) await reply(request(`${base}/${id}`), full(id));
    expect(rowIds()).toEqual(ids);
    for (const id of ids) {
      const row = rowOf(id);
      expect(status(id)).toBe("complete");
      expect(row.querySelector(".th-activity-dag-head .th-activity-dag-name")?.textContent).toBe(id);
      expect(row.querySelector(".th-activity-chip")?.textContent).toBe("activity.status.running");
      expect(row.querySelector(".th-activity-dag-counts")).not.toBeNull();
      expect(row.querySelector("details[data-activity-dag-total]")?.getAttribute("data-activity-dag-total")).toBe("3");
      expect([...row.querySelectorAll("[data-view]")].map(button => button.getAttribute("data-view"))).toEqual(["list", "graph"]);
    }
  });

  it("renders the run list without any run picker", async () => {
    await load();
    expect(harness.container.querySelector("[data-activity-dag-select]")).toBeNull();
    expect(harness.container.querySelector(".th-activity-dag-picker")).toBeNull();
    expect(harness.container.querySelector("select")).toBeNull();
    expect(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh").textContent).toBe("activity.dagRefresh");
  });

  it("loads exactly one more catalog page of ten from the settled list end, never from placeholders", async () => {
    const firstTen = Array.from({ length: 10 }, (_unused, index) => `first-${index}`);
    const secondTen = Array.from({ length: 10 }, (_unused, index) => `second-${index}`);
    render(); open();
    expect(catalogStatus()).toBe("loading");
    expect(harness.container.querySelector(".th-activity-dag-complete > .th-activity-dag-freshness[role='status']")?.textContent).toBe("activity.dagCatalogLoading");
    await reply(request(firstPage), catalog(firstTen, "cursor-2"));
    expect(rowIds()).toEqual(firstTen);
    expect(requests.some(item => item.url === pageAfter("cursor-2"))).toBe(false);
    // While the first page's originals are still compact loading
    // placeholders, the list end is not settled: their provisional height
    // keeps the sentinel in view, so an intersection report over them is a
    // layout artifact — it must not consume the next catalog page.
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "placeholder sentinel"));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "placeholder sentinel"));
    expect(requests.some(item => item.url === pageAfter("cursor-2"))).toBe(false);
    for (const id of firstTen) await reply(request(`${base}/${id}`), full(id));
    // Settled list end: one reveal consumes exactly one more page of ten.
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "settled sentinel"));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "settled sentinel"));
    await reply(request(pageAfter("cursor-2")), catalog(secondTen, "cursor-3"));
    expect(rowIds()).toEqual([...firstTen, ...secondTen]);
    expect(requests.filter(item => item.url === pageAfter("cursor-2"))).toHaveLength(1);
    // The appended rows are placeholders again — still not a settled end.
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "sentinel after append"));
    expect(requests.some(item => item.url === pageAfter("cursor-3"))).toBe(false);
    for (const id of secondTen) await reply(request(`${base}/${id}`), full(id));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "settled sentinel after append"));
    await reply(request(pageAfter("cursor-3")), catalog([], null));
    expect(harness.container.querySelector("[data-activity-dag-sentinel]")).toBeNull();
    expect(rowIds()).toEqual([...firstTen, ...secondTen]);
    expect(requests.filter(item => item.url === pageAfter("cursor-2"))).toHaveLength(1);
    expect(requests.filter(item => item.url === pageAfter("cursor-3"))).toHaveLength(1);
  });

  it("holds the opening fetch budget at the newest ten while all originals are slow", async () => {
    const slow = Array.from({ length: 10 }, (_unused, index) => `slow-${index}`);
    const originalReads = (): number => requests.filter(item => item.url.startsWith(`${base}/slow-`)).length;
    render(); open();
    await reply(request(firstPage), catalog(slow, "cursor-2"));
    // Only the newest page's ten originals are authorized reads, and the
    // placeholder sentinel report above admits no eleventh.
    expect(originalReads()).toBe(10);
    expect(rowIds()).toEqual(slow);
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "placeholder sentinel"));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "placeholder sentinel"));
    expect(originalReads()).toBe(10);
    expect(requests.some(item => item.url === pageAfter("cursor-2"))).toBe(false);
  });

  it("fetches only the newest page again after close and reopen of a multi-page list", async () => {
    const newest = Array.from({ length: 10 }, (_unused, index) => `newest-${index}`);
    const deeper = Array.from({ length: 10 }, (_unused, index) => `deeper-${index}`);
    const reads = (prefix: string): number => requests.filter(item => item.url.startsWith(`${base}/${prefix}-`)).length;
    render(); open();
    await reply(request(firstPage), catalog(newest, "cursor-2"));
    for (const id of newest) await reply(request(`${base}/${id}`), full(id));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "settled sentinel"));
    await reply(request(pageAfter("cursor-2")), catalog(deeper, null));
    for (const id of deeper) await reply(request(`${base}/${id}`), full(id));
    expect(rowIds()).toEqual([...newest, ...deeper]);
    expect(reads("newest")).toBe(10);
    expect(reads("deeper")).toBe(10);
    // Close and reopen the tab. Until this opening's own catalog page
    // arrives, every retained row — the deeper page included — is fenced
    // from reading: no original is re-read at all.
    open(); open();
    expect(requests.filter(item => item.url === firstPage)).toHaveLength(2);
    expect(reads("newest")).toBe(10);
    expect(reads("deeper")).toBe(10);
    await reply(request(firstPage, 1), catalog(newest, "cursor-2"));
    // Only this opening's newest page re-reads; the deeper rows stay
    // unfetched until a real scroll asks for their catalog page again.
    for (const id of newest) await reply(request(`${base}/${id}`, 1), full(id));
    expect(reads("newest")).toBe(20);
    expect(reads("deeper")).toBe(10);
    expect(rowIds()).toEqual(newest);
    expect(requests.filter(item => item.url === pageAfter("cursor-2"))).toHaveLength(1);
  });

  it("surfaces catalog retrieval errors explicitly and recovers through the refresh button", async () => {
    render(); open();
    await reply(request(firstPage), { error: "catalog unavailable" }, 500);
    expect(catalogStatus()).toBe("error");
    expect(rowIds()).toEqual([]);
    expect(harness.container.querySelector(".th-activity-dag-complete > .th-activity-dag-freshness[role='alert']")?.textContent).toBe("activity.dagCatalogError");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog());
    await reply(request(`${base}/r1`), full());
    expect(catalogStatus()).toBe("ready");
    expect(status()).toBe("complete");
  });

  it("distinguishes an authoritative empty catalog from loading", async () => {
    // Given no summary; When the entire authorized catalog returns empty.
    render(activityState()); open();
    expect(catalogStatus()).toBe("loading");
    await reply(request(firstPage), catalog([]));
    expect(catalogStatus()).toBe("empty");
    expect(harness.container.querySelector('[data-activity-tabpanel="dag"] .th-activity-empty')?.textContent).toBe("activity.emptyDag");
    expect(rowIds()).toEqual([]);
    expect(harness.container.querySelector("[data-activity-dag-sentinel]")).toBeNull();
  });

  it("automatically replaces a same-revision prefix with all original nodes, dependencies and descriptions", async () => {
    // Given a cropped same-revision legacy summary; When the DAG tab opens.
    const document = full("r1", revision, 64);
    render(projected(document, 2)); open();
    expect(nodes()).toEqual([]);
    expect(catalogStatus()).toBe("loading");
    await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), document);
    // Then only the complete authorized topology is current.
    expect(nodes()).toEqual(document.run.nodes.map(node => node.id));
    expect(status()).toBe("complete");
    expect(harness.container.querySelectorAll(".th-activity-gedge")).toHaveLength(63);
    expect(harness.container.querySelector("[data-activity-dag-total]")?.getAttribute("data-activity-dag-total")).toBe("64");
    const disclosure = requireElement(harness.container.querySelector<HTMLDetailsElement>("details[data-activity-dag-node]"), "node disclosure");
    act(() => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    expect(disclosure.querySelector("[data-activity-dag-prompt]")?.textContent).toBe(document.run.nodes[0]?.prompt);
    expect(disclosure.querySelector("[data-activity-dag-attempt]")?.textContent).toBe("0");
    for (const state of states) expect(harness.container.querySelector(`[data-activity-dag-count="${state}"]`)?.getAttribute("data-count")).toBe("8");
  });

  function taskIdentityDocument(taskId: string) {
    const doc = full("r1", revision, 64);
    const nodes = doc.run.nodes.map((node, index) => ({ ...node,
      id: `node-${index.toString().padStart(2, "0")}`,
      depends_on: index === 0 ? [] : [`node-${(index - 1).toString().padStart(2, "0")}`],
      task_id: index === 0 ? taskId : node.task_id,
    }));
    return { ...doc, run: { ...doc.run, nodes,
      edges: nodes.flatMap(node => node.depends_on.map(from => ({ from, to: node.id }))),
    } };
  }
  function taskIdentityOverview(doc: ReturnType<typeof taskIdentityDocument>, projectedTask: string, lossy: boolean) {
    // Raw projection -> actual parser/reducer -> Shelf/hook, not a manually
    // annotated ActivityDagNode. The Go HTTP test covers production emission.
    return applyActivityEvent(activityState(), "omo.dag.updated", { truncated_runs: true, runs: [{ ...doc.run,
      nodes: doc.run.nodes.slice(0, 1).map(node => ({ ...node, prompt: node.prompt.slice(0, 512),
        task_id: projectedTask, ...(lossy ? { task_id_truncated: true } : {}),
      })),
    }] });
  }

  it.each([
    ["ascii601", "t".repeat(600) + "a", "t".repeat(512)],
    ["utf8Boundary", "界".repeat(201), "界".repeat(170)],
  ])("enriches F1 %s task metadata without losing the complete graph", async (_name, taskId, fragment) => {
    const doc = taskIdentityDocument(taskId);
    render(taskIdentityOverview(doc, fragment, true)); open();
    await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), doc);
    expect(status()).toBe("complete");
    expect(nodes()).toEqual(doc.run.nodes.map(node => node.id));
    expect(harness.container.querySelectorAll(".th-activity-gedge")).toHaveLength(63);
    expect(harness.container.querySelector("[data-activity-dag-total]")?.getAttribute("data-activity-dag-total")).toBe("64");
    expect([...harness.container.querySelectorAll("dd")].some(node => node.textContent === taskId)).toBe(true);
    expect(harness.container.querySelector("[data-activity-dag-prompt]")?.textContent).toBe(doc.run.nodes[0]?.prompt);
  });

  it.each([
    ["exact512", "t".repeat(512), "t".repeat(512) + "a"],
    ["short", "task-exact", "task-exact-other"],
    ["unmarked legacy loss", "t".repeat(512), "t".repeat(600) + "a"],
  ])("keeps F1 %s task conflicts stale despite matching prefixes and aggregate partial", async (_name, known, incoming) => {
    const doc = taskIdentityDocument(incoming);
    render(taskIdentityOverview(doc, known, false)); open();
    await reply(request(firstPage), catalog()); await reply(request(`${base}/r1`), doc);
    expect(status()).toBe("stale"); expect(nodes()).toEqual([]);
  });

  it.each(["state", "attempt", "started_at", "completed_at", "task_id"] as const)(
    "keeps F1 lossy-task enrichment fenced by known %s conflicts", async field => {
      const doc = taskIdentityDocument("t".repeat(600) + "a");
      const known = { ...doc, run: { ...doc.run, nodes: doc.run.nodes.map((node, index) => index !== 0 ? node : {
        ...node, ...(field === "state" ? { state: "completed" as const }
          : field === "attempt" ? { attempt: 99 }
          : field === "started_at" ? { started_at: newer }
          : field === "completed_at" ? { completed_at: revision } : {}),
      }) } };
      render(taskIdentityOverview(known, field === "task_id" ? "other".repeat(102) + "xx" : "t".repeat(512), true)); open();
      await reply(request(firstPage), catalog()); await reply(request(`${base}/r1`), doc);
      expect(status()).toBe("stale"); expect(nodes()).toEqual([]);
    },
  );

  it("keeps an exact live task fact authoritative after a lossy F1 projection", async () => {
    const doc = taskIdentityDocument("t".repeat(600) + "a");
    const summary = taskIdentityOverview(doc, "t".repeat(512), true);
    const exact = applyActivityEvent(summary, "omo.dag.activity", {
      runId: "r1", nodeId: "node-00", at: newer, taskId: "t".repeat(600) + "b",
    });
    render(exact); open(); await reply(request(firstPage), catalog()); await reply(request(`${base}/r1`), doc);
    expect(status()).toBe("stale"); expect(nodes()).toEqual([]);
  });

  it.each(["REST", "live"] as const)("recovers F1-R5 %s exact R -> lossy R+1 -> full601/64", async transport => {
    const apply = transport === "REST" ? applyActivityHistorySnapshot : applyActivityEvent;
    const taskId = "t".repeat(600) + "a";
    const doc = taskIdentityDocument(taskId);
    doc.run.updated_at = newer;
    const initial = apply(activityState(), "omo.dag.updated", { runs: [{ ...doc.run, updated_at: revision,
      nodes: [{ ...doc.run.nodes[0]!, task_id: "previous-attempt-task" }],
    }] });
    expect(initial.dags.get("r1")?.nodes[0]?.taskId).toBe("previous-attempt-task");
    const next = apply(initial, "omo.dag.updated", { runs: [{ ...doc.run,
      nodes: [{ ...doc.run.nodes[0]!, task_id: taskId.slice(0, 512), task_id_truncated: true }],
    }] });
    render(next); open(); await reply(request(firstPage), catalog());
    await replyF2(request(`${base}/r1`), doc);
    expect(status()).toBe("complete");
    expect(nodes()).toEqual(doc.run.nodes.map(node => node.id));
    expect(harness.container.querySelectorAll(".th-activity-gedge")).toHaveLength(63);
    expect(harness.container.querySelector("[data-activity-dag-total]")?.getAttribute("data-activity-dag-total")).toBe("64");
    expect([...harness.container.querySelectorAll("dd")].some(node => node.textContent === taskId)).toBe(true);
    expect(next.dags.get("r1")?.nodes[0]?.taskId).toBeUndefined();
    expect(next.dags.get("r1")?.nodes[0]?.taskIdPrefix).toBe(taskId.slice(0, 512));
    expect(next.dags.get("r1")?.updatedAt).toBe(newer);
  });

  it.each(["REST", "live"] as const)("preserves F1-R5 %s plain omitted task identity at R+1", transport => {
    const apply = transport === "REST" ? applyActivityHistorySnapshot : applyActivityEvent;
    const doc = taskIdentityDocument("previous-attempt-task");
    const initial = apply(activityState(), "omo.dag.updated", { runs: [doc.run] });
    const next = apply(initial, "omo.dag.updated", { runs: [{ ...doc.run, updated_at: newer,
      nodes: doc.run.nodes.map(node => ({ ...node, task_id: undefined })),
    }] });
    expect(next.dags.get("r1")?.updatedAt).toBe(newer);
    expect(next.dags.get("r1")?.nodes[0]?.taskId).toBe("previous-attempt-task");
    expect(next.dags.get("r1")?.nodes[0]?.taskIdPrefix).toBeUndefined();
  });

  it.each(["REST", "live"] as const)("preserves F1-R5 %s same-revision exact authority against lossy replacement", async transport => {
    const apply = transport === "REST" ? applyActivityHistorySnapshot : applyActivityEvent;
    const doc = taskIdentityDocument("t".repeat(600) + "a");
    const initial = apply(activityState(), "omo.dag.updated", { runs: [{ ...doc.run,
      nodes: [{ ...doc.run.nodes[0]!, task_id: "other-exact-task" }],
    }] });
    const next = apply(initial, "omo.dag.updated", { runs: [{ ...doc.run,
      nodes: [{ ...doc.run.nodes[0]!, task_id: "t".repeat(512), task_id_truncated: true }],
    }] });
    expect(next.dags.get("r1")).toBe(initial.dags.get("r1"));
    render(next); open(); await reply(request(firstPage), catalog()); await replyF2(request(`${base}/r1`), doc);
    expect(status()).toBe("stale"); expect(nodes()).toEqual([]);
  });

  it.each(["REST", "live"] as const)("preserves F1-R5 %s exact live activity authority after newer lossy input", async transport => {
    const apply = transport === "REST" ? applyActivityHistorySnapshot : applyActivityEvent;
    const doc = taskIdentityDocument("t".repeat(600) + "a");
    const initial = apply(activityState(), "omo.dag.updated", { runs: [{ ...doc.run,
      nodes: [{ ...doc.run.nodes[0]!, task_id: "previous-attempt-task" }],
    }] });
    doc.run.updated_at = newer;
    const lossy = apply(initial, "omo.dag.updated", { runs: [{ ...doc.run,
      nodes: [{ ...doc.run.nodes[0]!, task_id: "t".repeat(512), task_id_truncated: true }],
    }] });
    const next = applyActivityEvent(lossy, "omo.dag.activity", {
      runId: "r1", nodeId: "node-00", at: newer, taskId: "t".repeat(600) + "b",
    });
    expect(next.dags.get("r1")?.nodes[0]?.taskId).toBe("t".repeat(600) + "b");
    render(next); open(); await reply(request(firstPage), catalog()); await replyF2(request(`${base}/r1`), doc);
    expect(status()).toBe("stale"); expect(nodes()).toEqual([]);
  });

  it("discovers runs on later catalog pages without relying on retained snapshot membership", async () => {
    // Given no retained DAG at all; When the authorized catalog pages in.
    render(activityState()); open();
    await reply(request(firstPage), catalog(["r1"], "opaque cursor"));
    await reply(request(`${base}/r1`), full("r1"));
    expect(rowIds()).toEqual(["r1"]);
    expect(requests.some(item => item.url === pageAfter("opaque cursor"))).toBe(false);
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "sentinel"));
    await reply(request(pageAfter("opaque cursor")), catalog(["r2", "r/3"]));
    await reply(request(`${base}/r2`), full("r2"));
    await reply(request(`${base}/r%2F3`), full("r/3"));
    expect(rowIds()).toEqual(["r1", "r2", "r/3"]);
    expect(status("r/3")).toBe("complete");
    expect(nodes(rowOf("r/3"))).toHaveLength(3);
  });

  it("rejects equal-revision completed/tokenA to running/tokenB after a prior full response", async () => {
    render(activityState()); open(); await reply(request(firstPage), catalog());
    const completed = uniform("completed", revision, "a".repeat(64));
    await reply(request(`${base}/r1`), completed);
    expect(status()).toBe("complete");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog());
    await reply(request(`${base}/r1`, 1), uniform("running", revision, "b".repeat(64)));
    expect(status()).toBe("stale");
    expect(harness.container.querySelector("[data-content-token]")?.getAttribute("data-content-token")).toBe(completed.content_token);
    expect(harness.container.querySelector('[data-activity-dag-count="completed"]')?.getAttribute("data-count")).toBe("2");
    expect(nodes()).toEqual(completed.run.nodes.map(node => node.id));
  });

  // Observe the exact terminal DOM commit before completing the controlled
  // request. The timer is only a failure deadline, never synchronization.
  async function replyF2(item: Request, body: unknown, id?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    const committed = new Promise<void>((resolve, reject) => {
      observer = new MutationObserver(() => {
        if (["complete", "stale", "error"].includes(status(id) ?? "")) resolve();
      });
      observer.observe(harness.container, { subtree: true, attributes: true, attributeFilter: ["data-activity-dag-status"] });
      timer = setTimeout(() => reject(new Error("F2 terminal hook commit deadline")), 2000);
    });
    try {
      await reply(item, body);
      await committed;
    } finally {
      clearTimeout(timer);
      observer?.disconnect();
    }
  }
  function documentF2(state: "running" | "completed", updatedAt = revision, token = "z") {
    const doc = uniform(state, updatedAt, token);
    return { ...doc, run: { ...doc.run, run_id: "a", name: "a" } };
  }
  async function roundTripF2(doc = documentF2("completed")) {
    // Historical a and b both load through the first catalog page.
    render(activityState()); open(); await reply(request(firstPage), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`), doc, "a");
    expect(status("a")).toBe("complete");
    await replyF2(request(`${base}/b`), full("b"), "b");
    expect(status("b")).toBe("complete");
  }

  it.each(["state", "attempt", "task", "prompt", "older", "missing", "invalid"])(
    "keeps F2 historical a->b->a fenced against %s replacement", async kind => {
      await roundTripF2();
      const doc = documentF2(kind === "state" ? "running" : "completed", kind === "older" ? "2026-09-08T09:00:00Z" : revision, "a");
      doc.run.nodes = doc.run.nodes.map(node => ({ ...node,
        ...(kind === "attempt" ? { attempt: 2 } : {}),
        ...(kind === "task" ? { task_id: "other-task" } : {}),
        ...(kind === "prompt" ? { prompt: "changed full description" } : {}),
      }));
      click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
      await reply(request(firstPage, 1), catalog(["a", "b"]));
      await replyF2(request(`${base}/a`, 1), { ...doc, run: { ...doc.run,
        updated_at: kind === "missing" ? undefined : kind === "invalid" ? "unknown" : doc.run.updated_at,
      } }, "a");
      expect(status("a")).toBe("stale");
      // The fenced replacement must not replace the accepted document: the
      // painted graph keeps the accepted facts, not the fenced ones.
      expect(rowOf("a").querySelector('[data-activity-dag-count="completed"]')?.getAttribute("data-count")).toBe("2");
      expect(rowOf("a").querySelector('[data-activity-dag-count="running"]')?.getAttribute("data-count")).toBe("0");
      expect(rowOf("a").querySelector('[role="alert"]')).not.toBeNull();
      await replyF2(request(`${base}/b`, 1), full("b"), "b");
      expect(status("b")).toBe("complete");
    },
  );

  it("accepts F2 equal facts with a different lower token after a refresh", async () => {
    await roundTripF2();
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`, 1), documentF2("completed", revision, "a"), "a");
    expect(status("a")).toBe("complete");
    expect(rowOf("a").getAttribute("data-content-token")).toBe("a");
    expect(rowOf("a").querySelector('[data-activity-dag-count="completed"]')?.getAttribute("data-count")).toBe("2");
  });

  it("accepts F2 strictly newer retry and then fences that revision across another refresh", async () => {
    await roundTripF2();
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog(["a", "b"]));
    const retry = documentF2("running", newer, "a");
    retry.run.nodes = retry.run.nodes.map(node => ({ ...node, attempt: 2 }));
    await replyF2(request(`${base}/a`, 1), retry, "a");
    expect(status("a")).toBe("complete");
    expect(rowOf("a").querySelector("[data-activity-dag-attempt]")?.textContent).toBe("2");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 2), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`, 2), documentF2("completed", newer, "z"), "a");
    expect(status("a")).toBe("stale");
    // The fenced equal-revision replacement keeps the accepted retry facts.
    expect(rowOf("a").querySelector("[data-activity-dag-attempt]")?.textContent).toBe("2");
    expect(rowOf("a").querySelector('[data-activity-dag-count="running"]')?.getAttribute("data-count")).toBe("2");
  });

  it("does not let an F2 rejection poison the accepted facts on explicit retry", async () => {
    await roundTripF2();
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`, 1), documentF2("running", revision, "a"), "a");
    expect(status("a")).toBe("stale");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "retry"));
    await reply(request(firstPage, 2), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`, 2), documentF2("completed", revision, "b"), "a");
    expect(status("a")).toBe("complete");
  });

  it.each(["fold", "reconnect"])("preserves F2 accepted facts across %s after returning to a", async kind => {
    await roundTripF2();
    if (kind === "fold") { open(); open(); }
    else { render(activityState(), false); render(activityState(), true); }
    await reply(request(firstPage, kind === "fold" ? 1 : 2), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`, 1), documentF2("running", revision, "b"), "a");
    expect(status("a")).toBe("stale");
    expect(rowOf("a").querySelector('[data-activity-dag-count="completed"]')?.getAttribute("data-count")).toBe("2");
  });

  it("aborts in-flight per-run reads when the tab closes so late responses cannot poison authority", async () => {
    await roundTripF2();
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog(["a", "b"]));
    const cancelled = request(`${base}/a`, 1);
    open(); open();
    expect(cancelled.signal?.aborted).toBe(true);
    await reply(cancelled, documentF2("running", newer, "cancelled"));
    await reply(request(firstPage, 2), catalog(["a", "b"]));
    await replyF2(request(`${base}/a`, 2), documentF2("completed", revision, "b"), "a");
    expect(status("a")).toBe("complete");
  });

  it.each(["chat", "workspace"])("resets F2 equality authority for a new %s binding", async kind => {
    await roundTripF2();
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog(["a", "b"]));
    const cancelled = request(`${base}/a`, 1);
    const source = { wsId: kind === "workspace" ? "other" : "ws", chatId: kind === "chat" ? "other" : "chat", connected: true };
    act(() => harness.root.render(<I18nContext.Provider value={i18n}><ActivityShelf activities={activityState()} dagSource={source} /></I18nContext.Provider>));
    expect(cancelled.signal?.aborted).toBe(true); expect(nodes()).toEqual([]);
    const otherBase = `/api/workspaces/${source.wsId}/chats/${source.chatId}/dag-runs`;
    await reply(request(`${otherBase}?limit=10`), catalog(["a"]));
    await reply(cancelled, documentF2("running", newer, "cancelled"));
    await replyF2(request(`${otherBase}/a`), documentF2("running", revision, "a"), "a");
    expect(status("a")).toBe("complete");
    expect(rowOf("a").querySelector('[data-activity-dag-count="running"]')?.getAttribute("data-count")).toBe("2");
  });

  it("rejects a same-revision running full response conflicting with known partial completed state", async () => {
    render(projected(uniform("completed"))); open(); await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), uniform("running"));
    expect(status()).toBe("stale");
    expect(nodes()).toEqual([]);
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each([
    ["node state", (doc: ReturnType<typeof full>) => ({ ...doc.run.nodes[0]!, state: "completed" as const })],
    ["attempt", (doc: ReturnType<typeof full>) => ({ ...doc.run.nodes[0]!, attempt: 9 })],
    ["task identity", (doc: ReturnType<typeof full>) => ({ ...doc.run.nodes[0]!, task_id: "other-task" })],
    ["start timestamp", (doc: ReturnType<typeof full>) => ({ ...doc.run.nodes[0]!, started_at: newer })],
    ["completion timestamp", (doc: ReturnType<typeof full>) => ({ ...doc.run.nodes[0]!, completed_at: revision })],
  ])("rejects conflicting known partial %s without requiring a run-status change", async (_name, changedNode) => {
    const doc = full();
    const known = { ...doc, run: { ...doc.run, nodes: [changedNode(doc), ...doc.run.nodes.slice(1)] } };
    render(projected(known)); open(); await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), doc);
    expect(status()).toBe("stale"); expect(nodes()).toEqual([]);
  });

  it.each(["prompt", "topology"])("preserves full %s facts against a conflicting equal-revision token", async kind => {
    await load();
    const previous = full();
    const changed = kind === "prompt" ? { ...previous, content_token: "other-token", run: { ...previous.run,
      nodes: previous.run.nodes.map(node => ({ ...node, prompt: "conflicting full prompt" })),
    } } : full("r1", revision, 4);
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog());
    await reply(request(`${base}/r1`, 1), changed);
    expect(status()).toBe("stale"); expect(nodes()).toEqual(previous.run.nodes.map(node => node.id));
    expect(harness.container.querySelector("[data-activity-dag-prompt]")?.textContent).toBe(previous.run.nodes[0]?.prompt);
  });

  it("revalidates equal full facts with a different opaque token without ordering token values", async () => {
    render(activityState()); open(); await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), uniform("completed", revision, "z"));
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog());
    await reply(request(`${base}/r1`, 1), uniform("completed", revision, "a"));
    expect(status()).toBe("complete");
    expect(harness.container.querySelector("[data-content-token]")?.getAttribute("data-content-token")).toBe("a");
  });

  it("accepts a strictly newer legitimate retry despite completed prior full and partial states", async () => {
    const completed = uniform("completed", revision, "z");
    render(projected(completed)); open(); await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), completed);
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog());
    const retry = uniform("running", newer, "a");
    retry.run.nodes = retry.run.nodes.map(node => ({ ...node, attempt: 2 }));
    await reply(request(`${base}/r1`, 1), retry);
    expect(status()).toBe("complete");
    expect(harness.container.querySelector('[data-activity-dag-count="running"]')?.getAttribute("data-count")).toBe("2");
    expect(harness.container.querySelector("[data-activity-dag-attempt]")?.textContent).toBe("2");
  });

  it.each(["missing", "invalid"])("rejects %s full revisions after a known revision", async kind => {
    await load();
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(firstPage, 1), catalog());
    const doc = full();
    await reply(request(`${base}/r1`, 1), { ...doc, run: { ...doc.run, updated_at: kind === "missing" ? undefined : "unknown" } });
    expect(status()).toBe("stale"); expect(nodes()).toHaveLength(3);
  });

  it("automatically replaces an absent 512-character implicit default with the exact 601-character catalog ID", async () => {
    const exact = `${"r".repeat(600)}a`, prefix = exact.slice(0, 512);
    render(projected(full(prefix))); open();
    await reply(request(firstPage), catalog([exact]));
    // The lossy prefix is never an addressable run: only catalog IDs load.
    expect(requests.some(item => item.url === `${base}/${encodeURIComponent(prefix)}`)).toBe(false);
    await reply(request(`${base}/${exact}`), full(exact));
    expect(status()).toBe("complete"); expect(nodes()).toHaveLength(3);
  });

  it("keeps two long-prefix collision IDs distinct across catalog pages", async () => {
    const first = `${"r".repeat(600)}a`, second = `${"r".repeat(600)}b`, prefix = first.slice(0, 512);
    render(projected(full(prefix))); open();
    await reply(request(firstPage), catalog([first], "last"));
    expect(requests.some(item => item.url === `${base}/${encodeURIComponent(prefix)}`)).toBe(false);
    await reply(request(`${base}/${first}`), full(first));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "sentinel"));
    await reply(request(pageAfter("last")), catalog([second]));
    await reply(request(`${base}/${second}`), full(second, revision, 4));
    expect(rowIds()).toEqual([first, second]);
    expect(status(first)).toBe("complete");
    expect(status(second)).toBe("complete");
    expect(nodes(rowOf(second))).toHaveLength(4);
  });

  it("loads a run discovered on a later catalog page when the sentinel advances", async () => {
    render(projected(full("r2"))); open();
    await reply(request(firstPage), catalog(["r1"], "last"));
    await reply(request(`${base}/r1`), full("r1"));
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "sentinel"));
    await reply(request(pageAfter("last")), catalog(["r2"]));
    await reply(request(`${base}/r2`), full("r2"));
    expect(status("r2")).toBe("complete"); expect(nodes(rowOf("r2"))).toHaveLength(3);
  });

  it("drops rows absent from a refreshed first page and keeps the remaining run's facts across close/reopen", async () => {
    render(); open(); await reply(request(firstPage), catalog(["r1", "r2"]));
    await reply(request(`${base}/r1`), full("r1"));
    await reply(request(`${base}/r2`), full("r2"));
    open(); open();
    await reply(request(firstPage, 1), catalog(["r1"]));
    await reply(request(`${base}/r1`, 1), full("r1"));
    expect(rowIds()).toEqual(["r1"]);
    expect(status("r1")).toBe("complete");
    expect(harness.container.querySelector('[data-activity-dag-run="r2"]')).toBeNull();
  });

  it("keeps loaded runs stable while a later catalog page arrives", async () => {
    render(); open(); await reply(request(firstPage), catalog(["r2"], "last"));
    await reply(request(`${base}/r2`), full("r2"));
    expect(status("r2")).toBe("complete");
    revealSentinel(requireElement(harness.container.querySelector("[data-activity-dag-sentinel]"), "sentinel"));
    await reply(request(pageAfter("last")), catalog(["r3"]));
    await reply(request(`${base}/r3`), full("r3"));
    expect(rowIds()).toEqual(["r2", "r3"]);
    expect(status("r2")).toBe("complete");
    expect(requests.filter(item => item.url === `${base}/r2`)).toHaveLength(1);
  });

  it("preserves the full topology as stale when a newer prefix arrives and rejects stale full data", async () => {
    // Given a trusted full run; When a newer partial snapshot outruns its refetch.
    await load();
    const expected = nodes();
    render(activityState({ dags: [makeDag({ updatedAt: newer, truncated: true, nodes: [], counts: { ...makeDag().counts, total: 0 } })], truncatedDags: true }));
    expect(nodes()).toEqual(expected);
    expect(status()).toBe("refreshing");
    await reply(request(`${base}/r1`, 1), full());
    expect(nodes()).toEqual(expected);
    expect(status()).toBe("stale");
  });

  it("coalesces meaningful in-flight invalidations and publishes only a coherent replacement", async () => {
    // Given a full read in flight; When multiple newer snapshots arrive.
    render(); open(); await reply(request(firstPage), catalog());
    const first = request(`${base}/r1`);
    render(projected(full("r1", newer)));
    const completed = uniform("completed", newer);
    render(projected(completed));
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
    expect(first.signal?.aborted).toBe(false);
    await reply(first, full());
    expect(nodes()).toEqual([]);
    await reply(request(`${base}/r1`, 1), completed);
    expect(status()).toBe("complete");
    expect(nodes()).toHaveLength(2);
    expect(harness.container.querySelector('[data-activity-dag-count="completed"]')?.getAttribute("data-count")).toBe("2");
  });

  it("does not restart full reads for heartbeat or progress-only updates", async () => {
    // Given a full read in flight; When heartbeat/progress clocks advance.
    const initial = partial(); render(initial); open(); await reply(request(firstPage), catalog());
    let next: ActivityState = initial;
    for (let seq = 1; seq <= 3; seq++) {
      next = applyActivityEvent(next, "omo.dag.heartbeat", { at: newer, runs: [{ runId: "r1", headSeq: seq }] });
      next = applyActivityEvent(next, "omo.dag.activity", { runId: "r1", nodeId: full().run.nodes[0]?.id, at: newer, currentTool: `tool-${seq}` });
      render(next);
    }
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
    await reply(request(`${base}/r1`), full());
    expect(status()).toBe("complete");
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
  });

  it("refetches after reconnect even when the oversized replay cache has no graph", async () => {
    // Given complete data and no new replay snapshot; When the socket reconnects.
    await load(); render(partial(), false);
    expect(status()).toBe("stale");
    render(partial(), true);
    await reply(request(firstPage, 2), catalog());
    await reply(request(`${base}/r1`, 1), full("r1", newer, 4));
    expect(nodes()).toHaveLength(4);
    expect(status()).toBe("complete");
  });

  it("cancels chat generations and does not disclose the previous chat's complete graph", async () => {
    // Given a complete run; When the pane binds another chat.
    await load(); render(partial(), true, "other");
    expect(nodes()).toEqual([]);
    await reply(request("/api/workspaces/ws/chats/other/dag-runs?limit=10"), catalog());
    await reply(request("/api/workspaces/ws/chats/other/dag-runs/r1"), full("r1", newer, 4));
    expect(nodes()).toHaveLength(4);
  });

  it.each([
    ["missing nodes", (doc: ReturnType<typeof full>) => ({ ...doc, run: { ...doc.run, nodes: undefined } })],
    ["missing dependency array", (doc: ReturnType<typeof full>) => ({ ...doc, run: { ...doc.run, nodes: doc.run.nodes.map(node => ({ ...node, depends_on: undefined })) } })],
    ["duplicate identity", (doc: ReturnType<typeof full>) => ({ ...doc, run: { ...doc.run, nodes: [...doc.run.nodes, doc.run.nodes[0]] } })],
    ["dangling dependency", (doc: ReturnType<typeof full>) => ({ ...doc, run: { ...doc.run, nodes: doc.run.nodes.map(node => ({ ...node, depends_on: ["absent"] })) } })],
    ["false counts", (doc: ReturnType<typeof full>) => ({ ...doc, run: { ...doc.run, counts: { ...doc.run.counts, running: 99 } } })],
    ["missing edges", (doc: ReturnType<typeof full>) => ({ ...doc, run: { ...doc.run, edges: [] } })],
    ["untrusted response", (doc: ReturnType<typeof full>) => ({ ...doc, complete: false })],
    ["wrong run", () => full("foreign")],
  ])("rejects %s atomically instead of rendering a cropped current graph", async (_name, malformed) => {
    // Given a partial summary; When the complete HTTP boundary supplies malformed data.
    render(); open(); await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), malformed(full()));
    expect(nodes()).toEqual([]);
    expect(status()).toBe("error");
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("shows retrieval errors without falling back to partial topology and retries explicitly", async () => {
    // Given the default selection; When full retrieval fails and is retried.
    render(); open(); await reply(request(firstPage), catalog());
    await reply(request(`${base}/r1`), { error: "invalid checkpoint" }, 422);
    expect(nodes()).toEqual([]); expect(status()).toBe("error");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "retry"));
    await reply(request(firstPage, 1), catalog());
    await reply(request(`${base}/r1`, 1), full());
    expect(status()).toBe("complete");
  });

  it("retains accepted documents and freshness high-water marks across closing the transient panel", async () => {
    // Given a historical run with a newer full revision; When closing and reopening.
    render(); open(); await reply(request(firstPage), catalog(["r1", "r2"]));
    await reply(request(`${base}/r1`), full("r1"));
    await reply(request(`${base}/r2`), full("r2", newer, 4));
    open(); open();
    await reply(request(firstPage, 1), catalog(["r1", "r2"]));
    await reply(request(`${base}/r2`, 1), full("r2", revision));
    expect(status("r2")).toBe("stale"); expect(nodes(rowOf("r2"))).toHaveLength(4);
  });

  it("preserves valid repeated dependency occurrences from the full source", async () => {
    // Given repeated source dependencies (not duplicate identities); When full data arrives.
    render(); open(); await reply(request(firstPage), catalog());
    const doc = full();
    const repeated = { ...doc, run: { ...doc.run,
      nodes: doc.run.nodes.map(node => ({ ...node, depends_on: [...node.depends_on, ...node.depends_on] })),
      edges: [...doc.run.edges, ...doc.run.edges],
    } };
    await reply(request(`${base}/r1`), repeated);
    expect(status()).toBe("complete"); expect(nodes()).toHaveLength(3);
    expect(harness.container.querySelectorAll(".th-activity-gedge")).toHaveLength(4);
  });

  it("preserves live progress overlays without replacing trusted topology or restarting retrieval", async () => {
    // Given full topology with matching attempt identities; When live progress arrives.
    const doc = full();
    const summary = applyActivityEvent(activityState(), "omo.dag.updated", { runs: [doc.run] });
    render(summary); open(); await reply(request(firstPage), catalog()); await reply(request(`${base}/r1`), doc);
    const progress = { runId: "r1", nodeId: doc.run.nodes[0]?.id, at: newer, currentTool: "tool-live", activity: "working" };
    render(applyActivityEvent(summary, "omo.dag.activity", progress));
    expect(harness.container.querySelector("[data-activity-dag-progress]")?.textContent).toBe(`${progress.activity}\n${progress.currentTool}`);
    expect(status()).toBe("complete"); expect(nodes()).toHaveLength(3);
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
  });

  it("binds the real primary ChatPane to automatic authorized retrieval", async () => {
    // Given a real chat pane with no replay graph; When opening its DAG tab.
    renderChatPane(harness.root, { id: "chat", wsId: "ws", name: "chat", cwd: "/work", provider: "omo" });
    open(); await reply(request(firstPage), catalog()); await reply(request(`${base}/r1`), full());
    expect(nodes()).toHaveLength(3); expect(status()).toBe("complete");
  });

  it("retains complete nodes through per-run graph/list round trips", async () => {
    // Given loaded full graphs; When switching one run to list and back.
    render(); open();
    await reply(request(firstPage), catalog(["r1", "r2"]));
    await reply(request(`${base}/r1`), full("r1"));
    await reply(request(`${base}/r2`), full("r2", revision, 4));
    const expected = nodes(rowOf("r1"));
    click(requireElement(rowOf("r1").querySelector('[data-view="list"]'), "r1 list toggle"));
    expect(rowOf("r1").querySelectorAll(".th-activity-dnode")).toHaveLength(3);
    expect(nodes(rowOf("r1"))).toEqual([]);
    // The view toggle is per run: r2 keeps its graph while r1 lists.
    expect(nodes(rowOf("r2"))).toHaveLength(4);
    click(requireElement(rowOf("r1").querySelector('[data-view="graph"]'), "r1 graph toggle"));
    expect(nodes(rowOf("r1"))).toEqual(expected);
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
    expect(requests.filter(item => item.url === `${base}/r2`)).toHaveLength(1);
  });
});
