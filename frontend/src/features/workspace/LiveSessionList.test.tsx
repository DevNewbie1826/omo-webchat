import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { I18nValue } from "../../i18n";
import { LiveSessionList } from "./LiveSessionList";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { Terminal, Workspace, WorkspaceSession } from "./workspace";
import { sessionOpenAttemptKey, type SessionOpenAttemptStatus } from "./useSessionOpenAttempts";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => (vars ? `${key} ${Object.values(vars).join(" ")}` : key),
};

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [{ id: "tm-1", name: "Stored session", provider: "omo" }],
};

const catalogSessions: readonly WorkspaceSession[] = [
  { id: "tm-1", name: "Stored session", source: "stored", recencyMs: 2 },
  { id: "disk-9", name: "Disk session", source: "stored", recencyMs: 1 },
];

const summaries: readonly LiveSessionSummary[] = [
  {
    id: "tm-1",
    title: "Refactor auth",
    runningCount: 2,
    doneCount: 1,
    dagDone: 2,
    dagTotal: 3,
    dagRunning: 0,
    lastLine: "ls -la /work",
    taskSideOversized: false,
    dagSideOversized: false,
  },
  {
    id: "disk-9",
    title: "",
    runningCount: 0,
    doneCount: 0,
    dagDone: 0,
    dagTotal: 0,
    lastLine: null,
    dagRunning: 0,
    taskSideOversized: false,
    dagSideOversized: false,
  },
];

describe("LiveSessionList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function card(index: number): HTMLElement {
    const cards = container.querySelectorAll<HTMLElement>(".th-overview-card");
    expect(cards.length).toBeGreaterThan(index);
    return cards[index]!;
  }

  interface ListHandlers {
    onSelect?: (ws: Workspace, tm: Terminal) => void;
    onOpen?: (ws: Workspace, session: WorkspaceSession) => Promise<"opened" | "session-active" | "failed" | void>;
    openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  }

  function renderList(
    props: Partial<{
      summaries: readonly LiveSessionSummary[];
      workspaces: readonly Workspace[];
      sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
      showLastLine: boolean;
      listClassName: string;
    }> = {},
    handlers: ListHandlers = {},
  ): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <LiveSessionList
            summaries={props.summaries ?? summaries}
            workspaces={props.workspaces ?? [workspace]}
            sessionLists={props.sessionLists ?? new Map([["ws-1", catalogSessions]])}
            onSelect={handlers.onSelect ?? (() => undefined)}
            onOpen={handlers.onOpen ?? (async () => undefined)}
            {...(handlers.openAttempts ? { openAttempts: handlers.openAttempts } : {})}
            {...(props.showLastLine !== undefined ? { showLastLine: props.showLastLine } : {})}
            {...(props.listClassName !== undefined ? { listClassName: props.listClassName } : {})}
          />
        </I18nContext.Provider>,
      );
    });
  }

  it("renders one card per summary with running badge and last line, and no meta line", () => {
    renderList();

    const first = card(0);
    expect(first.querySelector(".th-overview-card-name")?.textContent).toBe("Refactor auth");
    const running = first.querySelector(".th-overview-card-running");
    expect(running?.textContent).toBe("2");
    expect(running?.getAttribute("aria-label")).toBe("overview.runningAria 2");
    expect(running?.querySelector(".th-overview-card-running-dot")).not.toBeNull();
    // The done/dag meta line is gone from the render even though the summary
    // still carries doneCount 1, dagDone 2, dagTotal 3.
    expect(first.querySelector(".th-overview-card-meta")).toBeNull();
    expect(first.textContent).not.toContain("overview.done");
    expect(first.textContent).not.toContain("overview.dag");
    expect(first.querySelector(".th-overview-card-line")?.textContent).toBe("ls -la /work");
    expect(first.tagName).toBe("DIV");
    expect(first.querySelector(".th-overview-card-open")?.tagName).toBe("BUTTON");

    const second = card(1);
    // An empty title falls back to the session id; with no running agents and
    // no last line the card renders title only.
    expect(second.querySelector(".th-overview-card-name")?.textContent).toBe("disk-9");
    expect(second.querySelector(".th-overview-card-running")).toBeNull();
    expect(second.querySelector(".th-overview-card-meta")).toBeNull();
    expect(second.textContent).not.toContain("overview.done");
    expect(second.querySelector(".th-overview-card-line")).toBeNull();
  });

  it("renders no card for a summary without an open target", () => {
    // A poll row keyed by an engine UUID no stored chat or loaded session row
    // owns cannot be opened; it must not render a card at all.
    const ghost: LiveSessionSummary = {
      ...summaries[0]!,
      id: "durable-uuid-9",
      title: "Ghost elsewhere",
    };
    renderList({ summaries: [...summaries, ghost] });

    expect(container.querySelectorAll(".th-overview-card")).toHaveLength(2);
    expect(container.textContent).not.toContain("Ghost elsewhere");
    expect(container.textContent).not.toContain("durable-uuid-9");
  });

  it("renders no meta line even when done and dag counts are present", () => {
    // The done/dag meta line is removed from the card render so every card
    // keeps a uniform height; the underlying summary fields stay intact.
    const withWork: LiveSessionSummary = {
      ...summaries[0]!,
      doneCount: 1,
      dagDone: 2,
      dagTotal: 3,
    };
    renderList({ summaries: [withWork] });

    const first = card(0);
    expect(first.querySelector(".th-overview-card-meta")).toBeNull();
    expect(first.textContent).not.toContain("overview.done");
    expect(first.textContent).not.toContain("overview.dag");
    expect(first.querySelector(".th-overview-card-name")?.textContent).toBe("Refactor auth");
    expect(first.querySelector(".th-overview-card-running")?.textContent).toBe("2");
  });

  it("renders a large running count with an interpolated aria-label and no tooltip", () => {
    const largeSummary: LiveSessionSummary = {
      ...summaries[0]!,
      runningCount: 50,
    };
    renderList({ summaries: [largeSummary] });

    const badge = card(0).querySelector(".th-overview-card-running");
    expect(badge?.textContent).toBe("50");
    expect(badge?.getAttribute("aria-label")).toBe(i18n.t("overview.runningAria", { n: 50 }));
    expect(badge?.getAttribute("title")).toBeNull();
  });

  it("selects a stored session", () => {
    const onSelect = vi.fn();
    renderList({}, { onSelect });

    act(() => {
      card(0).querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
  });

  it("opens a stored session that exists only in the loaded session list", async () => {
    // Regression: the session is absent from workspace.chats, so the chats-mapped
    // select path cannot see it; the card must open it through the stored union row,
    // exactly as the session picker does.
    const storedOnlyWorkspace: Workspace = { ...workspace, chats: [] };
    const storedEntry: WorkspaceSession = { id: "chat-1", name: "Stored session", source: "stored", recencyMs: 2 };
    const storedSummary: LiveSessionSummary = { ...summaries[0]!, id: "chat-1" };
    const onSelect = vi.fn();
    let resolve!: (result: "opened") => void;
    const pending = new Promise<"opened">((done) => { resolve = done; });
    const onOpen = vi.fn(() => pending);
    renderList(
      { summaries: [storedSummary], workspaces: [storedOnlyWorkspace], sessionLists: new Map([["ws-1", [storedEntry]]]) },
      { onSelect, onOpen },
    );

    act(() => {
      card(0).querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(storedOnlyWorkspace, storedEntry);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { resolve("opened"); await pending; });
    expect(container.querySelector(".th-overview-card-state")).toBeNull();
  });

  it("keeps the card active without any force or read-only branch on a session-active attempt", () => {
    // A session-active attempt no longer takes the card over: there is no
    // read-only state and no force-open control, and the card stays enabled.
    const onOpen = vi.fn(async () => "opened" as const);
    const key = sessionOpenAttemptKey(workspace.id, catalogSessions[1]!.id);
    renderList({}, { onOpen, openAttempts: new Map([[key, "session-active"]]) });

    const active = card(1);
    expect(active.textContent).not.toContain("overview.readOnlyLive");
    expect(active.querySelector(".th-overview-force-open")).toBeNull();
    expect(active.querySelector<HTMLButtonElement>(".th-overview-card-open")?.disabled).toBe(false);
  });

  it("renders the failed state with a retry path", () => {
    const onOpen = vi.fn(async () => "opened" as const);
    const key = sessionOpenAttemptKey(workspace.id, catalogSessions[1]!.id);
    renderList({}, { onOpen, openAttempts: new Map([[key, "failed"]]) });

    const failed = card(1);
    expect(failed.textContent).toContain("sidebar.tm.openFailed");
    act(() => failed.querySelector<HTMLButtonElement>(".th-overview-retry-open")?.click());
    expect(onOpen).toHaveBeenLastCalledWith(workspace, catalogSessions[1]);
  });

  it("renders an empty list container when there are no summaries", () => {
    renderList({ summaries: [] });

    expect(container.querySelector(".th-overview-list")).not.toBeNull();
    expect(container.querySelectorAll(".th-overview-card")).toHaveLength(0);
  });

  it("renders no last line when showLastLine is false", () => {
    renderList({ showLastLine: false });

    expect(container.querySelectorAll(".th-overview-card")).toHaveLength(2);
    expect(container.querySelectorAll(".th-overview-card-line")).toHaveLength(0);
  });

  it("appends listClassName to the list container", () => {
    renderList({ listClassName: "th-sidebar-live" });

    const list = container.querySelector(".th-overview-list");
    expect(list?.className).toBe("th-overview-list th-sidebar-live");
  });
});
