import { afterEach, describe, expect, it, vi } from "vitest";
import { listLiveSessions } from "./workspace";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("listLiveSessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns enriched sessions with their raw task and dag payloads", async () => {
    const task = { parent_session_id: "s1", tasks: [{ task_id: "t1", name: "A", status: "running" }] };
    const dag = { parent_session_id: "s1", runs: [] };
    const fetchMock = vi.fn(async () =>
      okResponse({ sessions: [{ id: "s1", title: "Refactor auth", task, dag }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listLiveSessions();

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/live", expect.objectContaining({ method: "GET" }));
    expect(sessions).toEqual([{ id: "s1", title: "Refactor auth", task, dag }]);
  });

  it("normalizes pre-enrichment id-only entries and tolerates null payloads", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: ["legacy", { id: "s2", title: 42, task: null, dag: undefined }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listLiveSessions();

    expect(sessions).toEqual([
      { id: "legacy", title: "", task: null, dag: null },
      { id: "s2", title: "", task: null, dag: null },
    ]);
  });

  it("drops malformed entries without throwing", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ sessions: [null, 7, { title: "no id" }, { id: "" }, "ok"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listLiveSessions();

    expect(sessions).toEqual([{ id: "ok", title: "", task: null, dag: null }]);
  });

  it("attaches well-formed task_digest and dag_digest on live sessions", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: [{
          id: "s1",
          title: "Digest",
          task: null,
          dag: null,
          task_oversized: true,
          dag_oversized: true,
          task_digest: {
            tasks: [{ task_id: "t1", status: "running", updated_at: "2026-08-19T10:14:00.000Z" }],
            truncated: false,
          },
          dag_digest: {
            runs: [{ run_id: "r1", status: "running", running_task_ids: ["t1"] }],
            truncated: false,
          },
        }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listLiveSessions();

    expect(sessions).toEqual([{
      id: "s1",
      title: "Digest",
      task: null,
      dag: null,
      taskOversized: true,
      dagOversized: true,
      taskDigest: {
        tasks: [{ taskId: "t1", status: "running", updatedAt: "2026-08-19T10:14:00.000Z" }],
        truncated: false,
      },
      dagDigest: {
        runs: [{ runId: "r1", status: "running", runningTaskIds: ["t1"] }],
        truncated: false,
      },
    }]);
  });

  it("rejects an entire digest when any task or dag row is malformed", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: [{
          id: "s-malformed-rows",
          title: "Malformed rows",
          task: null,
          dag: null,
          task_oversized: true,
          dag_oversized: true,
          task_digest: {
            tasks: [
              { task_id: "good", status: "running" },
              { task_id: "", status: "running" },
            ],
            truncated: false,
          },
          dag_digest: {
            runs: [
              { run_id: "good", status: "running", running_task_ids: [] },
              { run_id: "bad", status: "running", running_task_ids: [7] },
            ],
            truncated: false,
          },
        }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listLiveSessions();

    expect(sessions).toEqual([{
      id: "s-malformed-rows",
      title: "Malformed rows",
      task: null,
      dag: null,
      taskOversized: true,
      dagOversized: true,
    }]);
  });

  it("omits malformed task_digest without throwing and still parses the session", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        sessions: [{
          id: "s2",
          title: "Malformed digest",
          task: null,
          dag: null,
          task_oversized: true,
          task_digest: { tasks: "nope" },
        }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessions = await listLiveSessions();

    expect(sessions).toEqual([{
      id: "s2",
      title: "Malformed digest",
      task: null,
      dag: null,
      taskOversized: true,
    }]);
  });
});
