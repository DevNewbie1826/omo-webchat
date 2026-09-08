import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { ActivityShelf } from "./ActivityShelf";
import { activityState, click, makeDag, mountActivityShelf, unmountActivityShelf, type ActivityShelfHarness } from "./ActivityShelf.support";
import { i18n, renderChatPane, requireElement } from "./chatPaneTestHarness";
import { applyActivityEvent } from "./activityState";
import type { ActivityState } from "./activityTypes";

const revision = "2026-09-08T10:00:00Z";
const newer = "2026-09-08T10:01:00Z";
const base = "/api/workspaces/ws/chats/chat/dag-runs";
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
describe("complete DAG dashboard", () => {
  let harness: ActivityShelfHarness;
  let requests: Request[];
  beforeEach(() => {
    harness = mountActivityShelf();
    requests = [];
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
    await reply(request(base), catalog());
    await reply(request(`${base}/r1`), full());
  }
  const nodes = () => [...harness.container.querySelectorAll(".th-activity-gnode")].map(node => node.getAttribute("data-node"));
  const status = () => harness.container.querySelector("[data-activity-dag-status]")?.getAttribute("data-activity-dag-status");
  function select(id: string) {
    const picker = requireElement(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]"), "complete run picker");
    act(() => { picker.value = id; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("automatically replaces a same-revision prefix with all original nodes, dependencies and descriptions", async () => {
    // Given a cropped same-revision legacy summary; When the DAG tab opens.
    const document = full("r1", revision, 64);
    render(projected(document, 2)); open();
    expect(nodes()).toEqual([]);
    expect(status()).toBe("loading");
    await reply(request(base), catalog());
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

  it("discovers every catalog page without relying on retained snapshot membership", async () => {
    // Given no retained DAG at all; When opening the authorized catalog.
    render(activityState()); open();
    await reply(request(base), catalog(["r1"], "opaque cursor"));
    await reply(request(`${base}?cursor=opaque%20cursor`), catalog(["r2", "r/3"]));
    const picker = requireElement(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]"), "run picker");
    expect([...picker.options].map(option => option.value)).toEqual(["r1", "r2", "r/3"]);
    select("r/3");
    await reply(request(`${base}/r%2F3`), full("r/3"));
    expect(status()).toBe("complete");
    expect(picker.value).toBe("r/3");
  });

  it("rejects equal-revision completed/tokenA to running/tokenB after a prior full response", async () => {
    render(activityState()); open(); await reply(request(base), catalog());
    const completed = uniform("completed", revision, "a".repeat(64));
    await reply(request(`${base}/r1`), completed);
    expect(status()).toBe("complete");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(`${base}/r1`, 1), uniform("running", revision, "b".repeat(64)));
    expect(status()).toBe("stale");
    expect(harness.container.querySelector("[data-content-token]")?.getAttribute("data-content-token")).toBe(completed.content_token);
    expect(harness.container.querySelector('[data-activity-dag-count="completed"]')?.getAttribute("data-count")).toBe("2");
    expect(nodes()).toEqual(completed.run.nodes.map(node => node.id));
  });

  it("rejects a same-revision running full response conflicting with known partial completed state", async () => {
    render(projected(uniform("completed"))); open(); await reply(request(base), catalog());
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
    render(projected(known)); open(); await reply(request(base), catalog());
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
    await reply(request(`${base}/r1`, 1), changed);
    expect(status()).toBe("stale"); expect(nodes()).toEqual(previous.run.nodes.map(node => node.id));
    expect(harness.container.querySelector("[data-activity-dag-prompt]")?.textContent).toBe(previous.run.nodes[0]?.prompt);
  });

  it("revalidates equal full facts with a different opaque token without ordering token values", async () => {
    render(activityState()); open(); await reply(request(base), catalog());
    await reply(request(`${base}/r1`), uniform("completed", revision, "z"));
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
    await reply(request(`${base}/r1`, 1), uniform("completed", revision, "a"));
    expect(status()).toBe("complete");
    expect(harness.container.querySelector("[data-content-token]")?.getAttribute("data-content-token")).toBe("a");
  });

  it("accepts a strictly newer legitimate retry despite completed prior full and partial states", async () => {
    const completed = uniform("completed", revision, "z");
    render(projected(completed)); open(); await reply(request(base), catalog());
    await reply(request(`${base}/r1`), completed);
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "refresh"));
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
    const doc = full();
    await reply(request(`${base}/r1`, 1), { ...doc, run: { ...doc.run, updated_at: kind === "missing" ? undefined : "unknown" } });
    expect(status()).toBe("stale"); expect(nodes()).toHaveLength(3);
  });

  it("automatically replaces an absent 512-character implicit default with the exact 601-character catalog ID", async () => {
    const exact = `${"r".repeat(600)}a`, prefix = exact.slice(0, 512);
    render(projected(full(prefix))); open();
    const invalid = request(`${base}/${prefix}`);
    await reply(invalid, { error: "DAG run not found" }, 404);
    await reply(request(base), catalog([exact]));
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe(exact);
    await reply(request(`${base}/${exact}`), full(exact));
    expect(status()).toBe("complete"); expect(nodes()).toHaveLength(3);
  });

  it("waits for catalog completion and keeps two long-prefix collision IDs distinct", async () => {
    const first = `${"r".repeat(600)}a`, second = `${"r".repeat(600)}b`, prefix = first.slice(0, 512);
    render(projected(full(prefix))); open();
    const invalid = request(`${base}/${prefix}`);
    await reply(request(base), catalog([first], "last"));
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe(prefix);
    expect(requests.some(item => item.url === `${base}/${first}`)).toBe(false);
    await reply(request(`${base}?cursor=last`), catalog([second]));
    expect(invalid.signal?.aborted).toBe(true);
    await reply(request(`${base}/${first}`), full(first));
    await reply(invalid, { error: "DAG run not found" }, 404);
    expect(status()).toBe("complete");
    const picker = requireElement(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]"), "run picker");
    expect([...picker.options].map(option => option.value)).toEqual([first, second]);
    select(second); await reply(request(`${base}/${second}`), full(second, revision, 4));
    expect(picker.value).toBe(second); expect(nodes()).toHaveLength(4);
  });

  it("preserves a valid implicit selection discovered on a later catalog page", async () => {
    render(projected(full("r2"))); open();
    await reply(request(base), catalog(["r1"], "last"));
    await reply(request(`${base}?cursor=last`), catalog(["r2"]));
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe("r2");
    expect(requests.some(item => item.url === `${base}/r1`)).toBe(false);
    await reply(request(`${base}/r2`), full("r2")); expect(status()).toBe("complete");
  });

  it("preserves explicit selection even when absent from a refreshed catalog across close/reopen", async () => {
    render(); open(); await reply(request(base), catalog(["r1", "r2"]));
    select("r2"); await reply(request(`${base}/r2`), full("r2"));
    open(); open();
    await reply(request(base, 1), catalog(["r1"]));
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe("r2");
    await reply(request(`${base}/r2`, 1), full("r2")); expect(status()).toBe("complete");
  });

  it("does not replace a newly explicit selection when a pending catalog completes", async () => {
    render(); open(); await reply(request(base), catalog(["r2"], "last"));
    select("r1");
    await reply(request(`${base}?cursor=last`), catalog(["r3"]));
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe("r1");
    await reply(request(`${base}/r1`), full()); expect(status()).toBe("complete");
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
    render(); open(); await reply(request(base), catalog());
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
    const initial = partial(); render(initial); open(); await reply(request(base), catalog());
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
    await reply(request(`${base}/r1`, 1), full("r1", newer, 4));
    expect(nodes()).toHaveLength(4);
    expect(status()).toBe("complete");
  });

  it("cancels selection generations so late responses cannot replace the selected run", async () => {
    // Given two catalog runs and an old in-flight read; When selecting the other run.
    render(); open(); await reply(request(base), catalog(["r1", "r2"]));
    const old = request(`${base}/r1`); select("r2");
    expect(old.signal?.aborted).toBe(true);
    await reply(request(`${base}/r2`), full("r2", revision, 4));
    await reply(old, full());
    expect(nodes()).toHaveLength(4);
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe("r2");
  });

  it("cancels chat generations and does not disclose the previous chat's complete graph", async () => {
    // Given a complete run; When the pane binds another chat.
    await load(); render(partial(), true, "other");
    expect(nodes()).toEqual([]);
    await reply(request("/api/workspaces/ws/chats/other/dag-runs"), catalog());
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
    render(); open(); await reply(request(base), catalog());
    await reply(request(`${base}/r1`), malformed(full()));
    expect(nodes()).toEqual([]);
    expect(status()).toBe("error");
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("shows retrieval errors without falling back to partial topology and retries explicitly", async () => {
    // Given the default selection; When full retrieval fails and is retried.
    render(); open(); await reply(request(base), catalog());
    await reply(request(`${base}/r1`), { error: "invalid checkpoint" }, 422);
    expect(nodes()).toEqual([]); expect(status()).toBe("error");
    click(requireElement(harness.container.querySelector("[data-activity-dag-retry]"), "retry"));
    await reply(request(`${base}/r1`, 1), full());
    expect(status()).toBe("complete");
  });

  it("retains selection and freshness high-water marks across closing the transient panel", async () => {
    // Given a historical selection with a newer full revision; When closing and reopening.
    render(); open(); await reply(request(base), catalog(["r1", "r2"]));
    select("r2"); await reply(request(`${base}/r2`), full("r2", newer, 4));
    open(); open();
    expect(harness.container.querySelector<HTMLSelectElement>("[data-activity-dag-select]")?.value).toBe("r2");
    await reply(request(`${base}/r2`, 1), full("r2", revision));
    expect(status()).toBe("stale"); expect(nodes()).toHaveLength(4);
  });

  it("preserves valid repeated dependency occurrences from the full source", async () => {
    // Given repeated source dependencies (not duplicate identities); When full data arrives.
    render(); open(); await reply(request(base), catalog());
    const doc = full();
    const repeated = { ...doc, run: { ...doc.run,
      nodes: doc.run.nodes.map(node => ({ ...node, depends_on: [...node.depends_on, ...node.depends_on] })),
      edges: [...doc.run.edges, ...doc.run.edges],
    } };
    await reply(request(`${base}/r1`), repeated);
    expect(status()).toBe("complete"); expect(nodes()).toHaveLength(3);
    expect(harness.container.querySelectorAll(".th-activity-gedge")).toHaveLength(4);
  });

  it("distinguishes an authoritative empty catalog from loading", async () => {
    // Given no summary; When the entire authorized catalog returns empty.
    render(activityState()); open(); await reply(request(base), catalog([]));
    expect(status()).toBe("empty"); expect(nodes()).toEqual([]);
  });

  it("preserves live progress overlays without replacing trusted topology or restarting retrieval", async () => {
    // Given full topology with matching attempt identities; When live progress arrives.
    const doc = full();
    const summary = applyActivityEvent(activityState(), "omo.dag.updated", { runs: [doc.run] });
    render(summary); open(); await reply(request(base), catalog()); await reply(request(`${base}/r1`), doc);
    const progress = { runId: "r1", nodeId: doc.run.nodes[0]?.id, at: newer, currentTool: "tool-live", activity: "working" };
    render(applyActivityEvent(summary, "omo.dag.activity", progress));
    expect(harness.container.querySelector("[data-activity-dag-progress]")?.textContent).toBe(`${progress.activity}\n${progress.currentTool}`);
    expect(status()).toBe("complete"); expect(nodes()).toHaveLength(3);
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
  });

  it("binds the real primary ChatPane to automatic authorized retrieval", async () => {
    // Given a real chat pane with no replay graph; When opening its DAG tab.
    renderChatPane(harness.root, { id: "chat", wsId: "ws", name: "chat", cwd: "/work", provider: "omo" });
    open(); await reply(request(base), catalog()); await reply(request(`${base}/r1`), full());
    expect(nodes()).toHaveLength(3); expect(status()).toBe("complete");
  });

  it("retains complete nodes through graph/list round trips", async () => {
    // Given a loaded full graph; When switching to list and back.
    await load(); const expected = nodes();
    click(requireElement(harness.container.querySelector('[data-view="list"]'), "list"));
    expect(harness.container.querySelectorAll(".th-activity-dnode")).toHaveLength(3);
    click(requireElement(harness.container.querySelector('[data-view="graph"]'), "graph"));
    expect(nodes()).toEqual(expected);
    expect(requests.filter(item => item.url === `${base}/r1`)).toHaveLength(1);
  });
});
