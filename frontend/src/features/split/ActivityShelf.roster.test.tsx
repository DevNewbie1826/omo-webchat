import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import { apiJson } from "../../lib/api";
import { ActivityShelf } from "./ActivityShelf";
import {
  activityState,
  click,
  makeTask,
  mountActivityShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import { i18n, requireElement } from "./chatPaneTestHarness";
import type { ActivityState } from "./activityTypes";

vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  apiJson: vi.fn(),
}));

const TASKS = "/api/workspaces/ws/chats/chat/tasks";
const CYCLES = 5;

type Pending = {
  readonly path: string;
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
};

function rosterBody(count: number) {
  return {
    parent_session_id: "sess",
    truncated_tasks: false,
    tasks: Array.from({ length: count }, (_, index) => ({
      task_id: `full-${index}`,
      name: `Full agent ${index}`,
      status: index === 0 ? "running" : "completed",
    })),
  };
}

describe("ActivityShelf agents tab roster fetch", () => {
  let harness: ActivityShelfHarness;
  let pending: Pending[];

  beforeEach(() => {
    harness = mountActivityShelf();
    pending = [];
    vi.mocked(apiJson).mockImplementation((path: string) => {
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<unknown>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      pending.push({ path, promise, resolve, reject });
      return promise;
    });
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
    vi.mocked(apiJson).mockReset();
  });

  function render(activities: ActivityState, connected = true): void {
    const props = { activities, dagSource: { wsId: "ws", chatId: "chat", connected } };
    act(() => {
      harness.root.render(
        <I18nContext.Provider value={i18n}>
          <ActivityShelf {...props} />
        </I18nContext.Provider>,
      );
    });
  }

  function truncatedDigest(): ActivityState {
    return activityState({
      tasks: [makeTask({ taskId: "full-0", name: "Full agent 0" })],
      truncatedTasks: true,
    });
  }

  function tab(id: string): HTMLButtonElement {
    return requireElement(
      harness.container.querySelector<HTMLButtonElement>(`[data-activity-tab="${id}"]`),
      `${id} tab`,
    );
  }

  function rosterCalls(): readonly string[] {
    return vi.mocked(apiJson).mock.calls.map(([path]) => path).filter((path) => path === TASKS);
  }

  function takeRoster(): Pending {
    const index = pending.findIndex((item) => item.path === TASKS);
    expect(index, "pending roster request").toBeGreaterThanOrEqual(0);
    return pending.splice(index, 1)[0]!;
  }

  async function resolveRoster(body: unknown = rosterBody(5)): Promise<void> {
    const request = takeRoster();
    await act(async () => {
      request.resolve(body);
      await request.promise;
    });
  }

  function agentNames(): readonly string[] {
    return [...harness.container.querySelectorAll(".th-activity-agent-name")].map((row) => row.textContent ?? "");
  }

  function cycleClosed(activities: ActivityState): void {
    for (let index = 0; index < CYCLES; index += 1) {
      render(activities, index % 2 === 0);
    }
  }

  it("does not fetch the roster while the tab is closed through polling and render cycles", () => {
    const activities = truncatedDigest();
    cycleClosed(activities);
    expect(rosterCalls()).toHaveLength(0);
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
  });

  it("does not fetch the roster when another tab is selected, including reconnect and reopen", () => {
    const activities = activityState({
      todo: [{ name: "phase", tasks: [{ content: "item", status: "pending" }] }],
      tasks: [makeTask({ taskId: "full-0", name: "Full agent 0" })],
      truncatedTasks: true,
    });
    cycleClosed(activities);
    click(tab("todo"));
    expect(harness.container.querySelector(".th-activity-panel")).not.toBeNull();
    expect(rosterCalls()).toHaveLength(0);
    cycleClosed(activities);
    click(tab("todo"));
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    click(tab("todo"));
    render(activities, false);
    render(activities, true);
    expect(rosterCalls()).toHaveLength(0);
    expect(harness.container.querySelector('[data-activity-tabpanel="todo"]')?.hasAttribute("hidden")).toBe(false);
  });

  it("fetches the roster exactly once when the agents tab opens and renders every row", async () => {
    render(truncatedDigest());
    expect(rosterCalls()).toHaveLength(0);
    click(tab("agents"));
    expect(rosterCalls()).toEqual([TASKS]);
    expect(harness.container.querySelector("[data-activity-roster-status]")?.getAttribute("data-activity-roster-status")).toBe("loading");
    await resolveRoster(rosterBody(5));
    expect(rosterCalls()).toEqual([TASKS]);
    expect(agentNames()).toEqual([
      "Full agent 0",
      "Full agent 1",
      "Full agent 2",
      "Full agent 3",
      "Full agent 4",
    ]);
    // The tab strip is the count surface: exactly the label plus the exact
    // local running/total scalar — no additional numeric or marker text.
    expect([...tab("agents").querySelectorAll("span")].map(span => span.textContent))
      .toEqual(["activity.subagents", "1/1"]);
  });

  it("stops fetching after the agents tab closes", async () => {
    const activities = truncatedDigest();
    render(activities);
    click(tab("agents"));
    await resolveRoster(rosterBody(5));
    expect(rosterCalls()).toHaveLength(1);
    click(tab("agents"));
    expect(harness.container.querySelector(".th-activity-panel")).toBeNull();
    cycleClosed(activities);
    render(activities, false);
    render(activities, true);
    expect(rosterCalls()).toHaveLength(1);
  });
});
