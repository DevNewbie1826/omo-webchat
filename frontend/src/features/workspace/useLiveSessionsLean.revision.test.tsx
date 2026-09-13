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
  });
  async function poll(row: object): Promise<void> {
    await act(async () => settle({ sessions: [row] }));
  }
  function push(fields: object): void {
    const frame = parseChatServerFrame({ type: "sessions.activity", sessionId: "s", durableSessionId: "s",
      overflow: false, ...fields });
    if (frame === null) throw new TypeError("Invalid activity fixture");
    act(() => handlers.onFrame(frame));
  }
  it("keeps completed counts when a pre-push poll settles at the same receipt", async () => {
    // Given an outstanding request overtaken by completion.
    push(completed);
    // When the old server returns a tied running snapshot.
    await poll(running);
    // Then neither summary consumer resurrects work.
    for (const summaries of [overview, merged]) {
      expect(summaries[0]).toMatchObject({ active: false, runningCount: 0, doneCount: 7, dagRunning: 0 });
    }
  });
  it("accepts later same-transport pushes at the same receipt", () => {
    // Given an accepted running push.
    push(running);
    // When completion arrives without a changed receipt.
    push(completed);
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
  it("merges a same-receipt main-activity flip without resurrecting children", async () => {
    // Given completed children followed by a partial main-activity push.
    push(completed);
    push({ active: true, last_activity_ms: 200 });
    // When the outstanding stale poll settles.
    await poll(running);
    // Then main activity changes independently from cleared child counts.
    expect(overview[0]).toMatchObject({ active: true, runningCount: 0, doneCount: 7, dagRunning: 0 });
  });
  it("prefers a tied push over an already accepted REST row", async () => {
    // Given an accepted running poll.
    await poll(running);
    // When completion is pushed at the same receipt.
    push(completed);
    // Then the push wins even though REST was observed first.
    expect(overview[0]).toMatchObject({ active: false, runningCount: 0 });
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
