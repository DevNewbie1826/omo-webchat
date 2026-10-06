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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
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
});
