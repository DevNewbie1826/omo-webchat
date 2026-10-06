import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTree } from "../../components/SessionTree";
import type { LayoutApi } from "../split/useLayout";
import { DISCOVERY_RETRY_DELAYS_MS, useWorkspaces } from "./useWorkspaces";
import { deleteWorkspace, listWorkspaceSessions, listWorkspaces } from "./workspace";
import type { Workspace } from "./workspace";

vi.mock("./workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace")>();
  return {
    ...actual,
    deleteWorkspace: vi.fn(),
    listWorkspaceSessions: vi.fn(),
    listWorkspaces: vi.fn(),
  };
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

const layout: LayoutApi = {
  root: { kind: "leaf", id: "pane-1", sessionId: null },
  focusedPaneId: "pane-1",
  placed: new Set(),
  focusPane: vi.fn(),
  hasPane: vi.fn(() => true),
  assignSession: vi.fn(),
  split: vi.fn(),
  closePane: vi.fn(),
  changeRatio: vi.fn(),
  unplaceSession: vi.fn(),
  focusSession: vi.fn(() => false),
};

/** The row a REST-created (or daemon-enrolled) chat reaches the catalog as. */
const enrolledWorkspace: Workspace = {
  id: "ws-enrolled",
  name: "owa1",
  path: "/work/owa1",
  chats: [{ id: "chat-enrolled", name: "Enrolled chat", provider: "omo" }],
};
const enrolledPage = {
  items: [{
    id: "chat-enrolled",
    name: "Enrolled chat",
    source: "stored" as const,
    recencyMs: 42,
    live: true,
  }],
  nextCursor: "",
};

describe("useWorkspaces event-driven discovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useWorkspaces> | undefined;

  function DiscoveryProbe(): ReactElement {
    latest = useWorkspaces({
      notify: () => undefined,
      t: (key) => key,
      layout,
      confirm: async () => true,
      discoveryEnabled: true,
    });
    if (latest.workspaces.length === 0) return <div data-testid="empty" />;
    return (
      <SessionTree
        workspaces={latest.workspaces}
        activeTerminalId={null}
        placedSessions={new Set()}
        liveSessions={new Set()}
        expanded={latest.expanded}
        sessionLists={latest.sessionLists}
        sessionPages={latest.sessionPages}
        onToggle={() => undefined}
        onLoadMoreSessions={() => undefined}
        onSelect={() => undefined}
        onAddTerminal={() => undefined}
        onDeleteWorkspace={() => undefined}
        onDeleteTerminal={() => undefined}
        onRenameWorkspace={async () => undefined}
        onRenameTerminal={async () => undefined}
        notify={() => undefined}
      />
    );
  }

  function ToggleProbe({ enabled }: { readonly enabled: boolean }): ReactElement {
    latest = useWorkspaces({
      notify: () => undefined,
      t: (key) => key,
      layout,
      confirm: async () => true,
      discoveryEnabled: enabled,
    });
    return <div data-testid="tree" />;
  }

  const chatRows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"));
  const catalogCalls = (): number => vi.mocked(listWorkspaces).mock.calls.length;

  /** jsdom leaves document.visibilityState read-only and always "visible"; the
   * visibility fallback is driven by that exact property. */
  let visibility: DocumentVisibilityState;
  function setVisibility(next: DocumentVisibilityState): void {
    visibility = next;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  }
  function fireVisibilityChange(): void {
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    vi.mocked(listWorkspaces).mockReset().mockResolvedValue([]);
    vi.mocked(listWorkspaceSessions).mockReset().mockResolvedValue(enrolledPage);
    vi.mocked(deleteWorkspace).mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("retries a failed catalog fetch on the bounded ladder and merges the row once it succeeds", async () => {
    // Given: an empty initial state whose first load has settled.
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);

    // When: the trigger requests discovery and the catalog fetch rejects.
    vi.mocked(listWorkspaces).mockRejectedValueOnce(new Error("network"));
    vi.mocked(listWorkspaces).mockResolvedValue([enrolledWorkspace]);
    await act(async () => {
      latest?.requestDiscovery();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(2);
    expect(latest?.workspaces).toHaveLength(0);

    // Then: nothing fires before the first rung, and the retry at 1s lands the
    // newly enrolled workspace+chat - without any periodic cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_RETRY_DELAYS_MS[0]! - 1);
    });
    expect(catalogCalls()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(catalogCalls()).toBe(3);
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-enrolled"]);
    expect(chatRows().map((row) => row.textContent)).toEqual(["Enrolled chat"]);

    // And the ladder is bounded: with every later fetch failing, exactly the
    // remaining rungs fire and then the hook stays silent - never a poll.
    vi.mocked(listWorkspaces).mockRejectedValue(new Error("network"));
    await act(async () => {
      latest?.requestDiscovery();
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterRequest = catalogCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(catalogCalls()).toBe(afterRequest + DISCOVERY_RETRY_DELAYS_MS.length);
  });

  it("merges a REST-created chat when the tab becomes visible again", async () => {
    // Given: a settled load and a chat created through REST elsewhere that was
    // never run, so no live frame will ever announce it.
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);
    vi.mocked(listWorkspaces).mockResolvedValue([enrolledWorkspace]);

    // When: the tab is hidden and a visibilitychange fires, nothing happens...
    setVisibility("hidden");
    await act(async () => {
      fireVisibilityChange();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(1);

    // ...and regaining visibility performs exactly one merge.
    setVisibility("visible");
    await act(async () => {
      fireVisibilityChange();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(2);
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-enrolled"]);
    expect(latest?.expanded.has("ws-enrolled")).toBe(true);
    expect(chatRows().map((row) => row.textContent)).toEqual(["Enrolled chat"]);
  });

  it("issues no catalog fetch while idle: no live change and no visibility event", async () => {
    // Given: a settled load with nothing live.
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);

    // When: two simulated minutes elapse with no trigger at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    // Then: the boot load is the only catalog request - the removed interval
    // left no periodic discovery behind.
    expect(catalogCalls()).toBe(1);
  });

  it("does not merge before the first load settles, and expands only what the load returned", async () => {
    // Given: the first load is still in flight.
    const firstLoad = deferred<readonly Workspace[]>();
    vi.mocked(listWorkspaces).mockReturnValueOnce(firstLoad.promise);
    vi.mocked(listWorkspaces).mockResolvedValue([enrolledWorkspace]);
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      void latest?.load();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(1);

    // When: a live frame's trigger arrives before the load settles. Merging
    // now would compare the catalog against the empty pre-load list, treat
    // every workspace as newly sighted and expand them all.
    await act(async () => {
      latest?.requestDiscovery();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(1);
    expect(latest?.workspaces).toHaveLength(0);

    // Then: the request is queued, not dropped - it runs exactly once after
    // the load settles, and finds the catalog it already loaded (nothing new
    // to expand).
    await act(async () => {
      firstLoad.resolve([enrolledWorkspace]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(2);
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-enrolled"]);
    expect(latest?.expanded.size).toBe(0);
  });

  it("coalesces a retry that comes due mid-request instead of running two merges, and never drops a newer row", async () => {
    // Given: a settled empty initial load.
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);

    // A catalog whose every call parks until the test settles it, so the test
    // can see exactly how many requests are outstanding at once.
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<{
      readonly resolve: (rows: readonly Workspace[]) => void;
      readonly reject: (error: Error) => void;
    }> = [];
    vi.mocked(listWorkspaces).mockImplementation(() =>
      new Promise<readonly Workspace[]>((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pending.push({
          resolve: (rows) => { inFlight -= 1; resolve(rows); },
          reject: (error) => { inFlight -= 1; reject(error); },
        });
      }));

    // When: the first merge's fetch fails, arming the 1s retry...
    await act(async () => {
      latest?.requestDiscovery();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending).toHaveLength(1);
    await act(async () => {
      pending[0]!.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
    });

    // ...a new discovery request is issued 500ms later and is still unresolved...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await act(async () => {
      latest?.requestDiscovery();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending).toHaveLength(2);

    // ...and the armed retry comes due 500ms after that, while that request is
    // still in flight. It must coalesce behind it, never start a second fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(maxInFlight).toBe(1);
    expect(pending).toHaveLength(2);

    // Then: the newer response lands first and an older catalog view after it;
    // the older response cannot drop the row the newer merge added.
    const wsA: Workspace = { id: "ws-a", name: "A", path: "/work/a", chats: [] };
    const wsB: Workspace = { id: "ws-b", name: "B", path: "/work/b", chats: [] };
    await act(async () => {
      pending[1]!.resolve([wsA, wsB]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-a", "ws-b"]);
    expect(pending).toHaveLength(3);

    await act(async () => {
      pending[2]!.resolve([wsA]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(maxInFlight).toBe(1);
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-a", "ws-b"]);
  });

  it("recovers a failed initial load by itself on the bounded ladder", async () => {
    // Given: the very first catalog load fails - the server is briefly
    // unavailable - leaving the tree empty with no live id to trigger
    // discovery.
    vi.mocked(listWorkspaces).mockRejectedValueOnce(new Error("network"));
    vi.mocked(listWorkspaces).mockResolvedValue([enrolledWorkspace]);
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);
    expect(latest?.workspaces).toHaveLength(0);
    expect(container.querySelector('[data-testid="empty"]')).not.toBeNull();

    // Then: no user action is needed - the ladder retries the canonical load
    // and the tree populates.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_RETRY_DELAYS_MS[0]! - 1);
    });
    expect(catalogCalls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(catalogCalls()).toBe(2);
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-enrolled"]);
    expect(container.querySelector('[data-testid="empty"]')).toBeNull();

    // And the ladder is cancelled by success: no further probes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(catalogCalls()).toBe(2);
  });

  it("cancels a pending load retry when discovery is disabled (logout)", async () => {
    // Given: an initial load that fails, arming the ladder.
    vi.mocked(listWorkspaces).mockRejectedValue(new Error("network"));
    act(() => {
      root.render(<ToggleProbe enabled />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);

    // When: the session ends - logout flips discoveryEnabled false.
    act(() => {
      root.render(<ToggleProbe enabled={false} />);
    });

    // Then: the pending retry is dropped; nothing keeps probing the catalog.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(catalogCalls()).toBe(1);
  });

  it("serializes the load retry and discovery so neither overlaps nor loses a newer row", async () => {
    // Given: the very first load fails, which arms the 1s load retry.
    vi.mocked(listWorkspaces).mockRejectedValueOnce(new Error("network"));
    act(() => {
      root.render(<DiscoveryProbe />);
    });
    await act(async () => {
      await latest?.load();
    });
    expect(catalogCalls()).toBe(1);

    // Every later catalog call parks until the test settles it, so the test can
    // see exactly how many requests are outstanding at once.
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<{
      readonly resolve: (rows: readonly Workspace[]) => void;
      readonly reject: (error: Error) => void;
    }> = [];
    vi.mocked(listWorkspaces).mockImplementation(() =>
      new Promise<readonly Workspace[]>((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pending.push({
          resolve: (rows) => { inFlight -= 1; resolve(rows); },
          reject: (error) => { inFlight -= 1; reject(error); },
        });
      }));

    // When: the load retry comes due and its response is held...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DISCOVERY_RETRY_DELAYS_MS[0]!);
    });
    expect(catalogCalls()).toBe(2);
    expect(pending).toHaveLength(1);

    // ...and a live id the catalog does not own requests discovery while that
    // load is still in flight.
    await act(async () => {
      latest?.requestDiscovery();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Then: the request is coalesced behind the load - never a second
    // concurrent request - and runs only once the load has settled.
    expect(maxInFlight).toBe(1);
    expect(pending).toHaveLength(1);
    expect(catalogCalls()).toBe(2);

    const wsA: Workspace = { id: "ws-a", name: "A", path: "/work/a", chats: [] };
    const wsB: Workspace = { id: "ws-b", name: "B", path: "/work/b", chats: [] };
    await act(async () => {
      pending[0]!.resolve([wsA]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-a"]);

    // And: the coalesced merge now runs, and the newer rows it reports cannot
    // be dropped by the request that started before it.
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]!.resolve([wsA, wsB]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(maxInFlight).toBe(1);
    expect(latest?.workspaces.map((workspace) => workspace.id)).toEqual(["ws-a", "ws-b"]);
  });

  it("does not retry a load that fails after the session ended (logout)", async () => {
    // Given: a load whose catalog request is still outstanding.
    const inFlightLoad = deferred<readonly Workspace[]>();
    vi.mocked(listWorkspaces).mockReturnValue(inFlightLoad.promise);
    act(() => {
      root.render(<ToggleProbe enabled />);
    });
    await act(async () => {
      void latest?.load();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(catalogCalls()).toBe(1);

    // When: the session ends while that request is still in flight, and its
    // failure only lands afterwards.
    act(() => {
      root.render(<ToggleProbe enabled={false} />);
    });
    await act(async () => {
      inFlightLoad.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
    });

    // Then: the late failure arms no retry and makes no further request -
    // logout must not leave a probing ladder behind.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(catalogCalls()).toBe(1);
  });
});
