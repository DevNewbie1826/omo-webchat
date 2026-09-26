import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectChat, parseChatServerFrame } from "../../lib/chatWs";
import type { ChatHandlers } from "../../lib/chatWs";
import { apiJson } from "../../lib/api";
import { useLiveSessionSummaries } from "./useLiveSessionSummaries";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import { __resetLiveBadgeStoreForTests, useMergedLiveSummaries } from "./liveBadgeStore";

vi.mock("../../lib/chatWs", async original => ({ ...await original<object>(), connectChat: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiJson: vi.fn() }));

const running = { id: "s", title: "Session", active: true, last_activity_ms: 200,
  running: { agents: 7, tasks: 5, dag: 4 }, done: 0, last_line: "old progress" };
const completed = { ...running, active: false, running: { agents: 0, tasks: 0, dag: 0 }, done: 7 };

describe("lean revision transport fences", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: ChatHandlers;
  let settle: (response: unknown) => void;
  let overview: readonly LiveSessionSummary[];
  let merged: readonly LiveSessionSummary[];
  function Host(): null {
    overview = useLiveSessionSummaries(true);
    merged = useMergedLiveSummaries(overview);
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    __resetLiveBadgeStoreForTests();
    vi.mocked(apiJson).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    vi.mocked(connectChat).mockImplementation(h => {
      handlers = h;
      return { send: () => true, close: () => undefined };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Host />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    __resetLiveBadgeStoreForTests();
    vi.useRealTimers();
  });
  async function poll(row: object): Promise<void> {
    await act(async () => settle({ sessions: [row] }));
  }
  function push(fields: object, connection?: number): void {
    const frame = parseChatServerFrame({ type: "sessions.activity", sessionId: "s", durableSessionId: "s",
      overflow: false, ...fields });
    if (frame === null) throw new TypeError("Invalid activity fixture");
    act(() => handlers.onFrame(frame, connection));
  }
  it("keeps completed counts when an older pre-push poll settles", async () => {
    // Given an outstanding request overtaken by completion.
    push(completed);
    // When the old server returns an earlier running revision.
    await poll({ ...running, last_activity_ms: 199 });
    // Then neither summary consumer resurrects work.
    for (const summaries of [overview, merged]) {
      expect(summaries[0]).toMatchObject({ active: false, runningCount: 0, doneCount: 7, dagRunning: 0 });
    }
  });
  it("accepts later same-transport pushes with newer revisions", () => {
    // Given an accepted running push.
    push(running);
    // When completion arrives with its own server revision.
    push({ ...completed, last_activity_ms: 201 });
    // Then the later observation wins.
    expect(overview[0]).toMatchObject({ active: false, runningCount: 0, doneCount: 7 });
  });
  it("lets a strictly newer REST receipt overtake an earlier push", async () => {
    // Given completion during the request.
    push(completed);
    // When the response contains genuinely newer work.
    await poll({ ...running, last_activity_ms: 201 });
    // Then server revision outranks the transport fence.
    expect(overview[0]).toMatchObject({ active: true, runningCount: 7 });
  });
  it("merges a newer main-activity flip without resurrecting children", async () => {
    // Given completed children followed by a partial main-activity push.
    push(completed);
    push({ active: true, last_activity_ms: 201 });
    // When the outstanding earlier poll settles.
    await poll(running);
    // Then main activity changes independently from cleared child counts.
    expect(overview[0]).toMatchObject({ active: true, runningCount: 0, doneCount: 7, dagRunning: 0 });
  });
  it("prefers a newer push over an already accepted REST row", async () => {
    // Given an accepted running poll.
    await poll(running);
    // When completion is pushed at a higher revision.
    push({ ...completed, last_activity_ms: 201 });
    // Then the push wins even though REST was observed first.
    expect(overview[0]).toMatchObject({ active: false, runningCount: 0 });
  });
  it.each([false, true])("resets backwards revisions on a new WS hello and rejects late old REST (overflow=%s)", async overflow => {
    // Given old-instance row and an outstanding request for the old instance.
    handlers.onHello?.("old-instance");
    push({ ...running, last_activity_ms: 500, overflow });
    expect(overview[0]?.runningCount).toBe(7);

    // When the new instance announces itself with a lower revision.
    act(() => handlers.onHello?.("new-instance"));
    push({ ...completed, last_activity_ms: 100, overflow });
    await act(async () => settle({ instanceId: "old-instance", sessions: [{ ...running, last_activity_ms: 600 }] }));

    // Then the previous instance cannot resurrect its larger revision.
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({ active: false, runningCount: 0, lean: { last_activity_ms: 100 } });
    expect(merged[0]).toMatchObject({ active: false, runningCount: 0 });
  });
  it.each([false, true])("revalidates pre-hello REST before accepting the new instance and rejecting the old socket (overflow=%s)", async overflow => {
    // Given an old-instance push with a larger revision and a pending mount request.
    vi.useFakeTimers();
    act(() => handlers.onOpen?.(1));
    act(() => handlers.onHello?.("old-instance", 1));
    push({ ...running, last_activity_ms: 500, overflow }, 1);

    // A request made before the current hello cannot establish a newer epoch.
    await act(async () => settle({ instanceId: "new-instance", sessions: [{ ...completed, last_activity_ms: 100 }] }));
    expect(overview[0]).toMatchObject({ active: true, runningCount: 7, lean: { last_activity_ms: 500 } });

    // The reconnect hello, followed by a fresh REST request, establishes it.
    act(() => handlers.onClose?.(1006, 1));
    act(() => handlers.onOpen?.(2));
    act(() => handlers.onHello?.("new-instance", 2));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await act(async () => settle({ instanceId: "new-instance", sessions: [{ ...completed, last_activity_ms: 100 }] }));
    expect(overview[0]).toMatchObject({ active: false, runningCount: 0, lean: { last_activity_ms: 100 } });
    push({ ...running, last_activity_ms: 600, overflow }, 1);
    expect(overview[0]).toMatchObject({ active: false, runningCount: 0 });
    push({ ...running, last_activity_ms: 101, overflow }, 2);

    // Only the current socket's lower revision advances the row.
    expect(overview[0]).toMatchObject({ active: true, runningCount: 7, lean: { last_activity_ms: 101 } });
  });
  for (const transport of ["REST", "WS"] as const) {
    for (const scenario of ["clear", "omit", "clear then omit"] as const) {
      it(`${scenario} preserves progress-field semantics through ${transport}`, async () => {
        // Given an accepted progress line (and, where relevant, an explicit clear).
        push(running);
        if (scenario === "clear then omit") push({ last_activity_ms: 201, last_line: "" });
        const fields = { id: "s", last_activity_ms: 202,
          ...(scenario === "clear" ? { last_line: "" } : {}) };
        // When a newer row arrives through the selected real consumer.
        if (transport === "REST") await poll(fields);
        else push(fields);
        // Then absence preserves the accepted value, including an explicit empty value.
        for (const summaries of [overview, merged]) {
          expect(summaries[0]?.lastLine).toBe(scenario === "omit" ? "old progress" : "");
        }
      });
    }
  }
});
