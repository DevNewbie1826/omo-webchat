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
});
