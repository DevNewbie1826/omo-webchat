import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { SystemStatsModal } from "./SystemStatsModal";
import { getSystemStats } from "./system";
import type { SystemStats } from "./system";

vi.mock("./system", () => ({ getSystemStats: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const stats: SystemStats = {
  cpuPercent: 1,
  memUsedBytes: 1,
  memTotalBytes: 2,
  memPercent: 50,
  numGoroutine: 1,
  goHeapAllocBytes: 1,
  uptimeSeconds: 1,
  os: "linux",
  arch: "amd64",
  numCpu: 1,
};

describe("SystemStatsModal polling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not start another poll until the current request settles", async () => {
    const pending = deferred<SystemStats>();
    const getStats = vi.mocked(getSystemStats);
    getStats.mockReturnValueOnce(pending.promise).mockReturnValue(new Promise<SystemStats>(() => undefined));

    act(() => {
      root.render(<SystemStatsModal open onClose={() => undefined} />);
    });
    expect(getStats).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(getStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(stats);
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(getStats).toHaveBeenCalledTimes(2);
  });
});
