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

const discoveredSessions: readonly WorkspaceSession[] = [
  { id: "tm-1", name: "Stored session", source: "stored", recencyMs: 2 },
  { id: "disk-9", name: "Disk session", source: "discovered", recencyMs: 1, resumeIdentity: "/s/disk-9.jsonl" },
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
    onOpen?: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active" | "failed" | void>;
    onActivated?: () => void;
    openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  }

  function renderList(
    props: Partial<{
      summaries: readonly LiveSessionSummary[];
      workspaces: readonly Workspace[];
      sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
      focusedSessionId: string | null;
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
            sessionLists={props.sessionLists ?? new Map([["ws-1", discoveredSessions]])}
            onSelect={handlers.onSelect ?? (() => undefined)}
            onOpen={handlers.onOpen ?? (async () => undefined)}
            {...(handlers.openAttempts ? { openAttempts: handlers.openAttempts } : {})}
            {...(handlers.onActivated ? { onActivated: handlers.onActivated } : {})}
            {...(props.focusedSessionId !== undefined ? { focusedSessionId: props.focusedSessionId } : {})}
            {...(props.showLastLine !== undefined ? { showLastLine: props.showLastLine } : {})}
            {...(props.listClassName !== undefined ? { listClassName: props.listClassName } : {})}
          />
        </I18nContext.Provider>,
      );
    });
  }

  it("renders one card per summary with counts, dag progress, and last line", () => {
    renderList();

    const first = card(0);
    expect(first.querySelector(".th-overview-card-name")?.textContent).toBe("Refactor auth");
    const running = first.querySelector(".th-overview-card-running");
    expect(running?.textContent).toBe("2");
    expect(running?.getAttribute("aria-label")).toBe("overview.runningAria 2");
    expect(running?.querySelector(".th-overview-card-running-dot")).not.toBeNull();
    expect(first.querySelector(".th-overview-card-meta")?.textContent).toContain("overview.done 1");
    expect(first.querySelector(".th-overview-card-meta")?.textContent).toContain("overview.dag 2/3");
    expect(first.querySelector(".th-overview-card-line")?.textContent).toBe("ls -la /work");
    expect(first.tagName).toBe("DIV");
    expect(first.querySelector(".th-overview-card-open")?.tagName).toBe("BUTTON");

    const second = card(1);
    // No running agents, nothing done, no dag, no line: the card degrades to
    // title only ("Done 0" would be noise), and an empty title falls back to
    // the session id.
    expect(second.querySelector(".th-overview-card-name")?.textContent).toBe("disk-9");
    expect(second.querySelector(".th-overview-card-running")).toBeNull();
    expect(second.querySelector(".th-overview-card-meta")).toBeNull();
    expect(second.textContent).not.toContain("overview.done");
    expect(second.querySelector(".th-overview-card-line")).toBeNull();
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

  it("orders the focused session first and marks its card", () => {
    renderList({ focusedSessionId: "disk-9" });

    const first = card(0);
    expect(first.querySelector(".th-overview-card-name")?.textContent).toBe("disk-9");
    expect(first.className).toContain("th-overview-card--focused");
    expect(card(1).className).not.toContain("th-overview-card--focused");
  });

  it("selects a stored session and reports activation", () => {
    const onSelect = vi.fn();
    const onActivated = vi.fn();
    renderList({}, { onSelect, onActivated });

    act(() => {
      card(0).querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
    expect(onActivated).toHaveBeenCalledTimes(1);
  });

  it("opens a stored session that exists only in the loaded session list", async () => {
    // Regression: the session is absent from workspace.chats, so the chats-mapped
    // select path cannot see it; the card must open it through the stored union row,
    // exactly as the session picker does.
    const storedOnlyWorkspace: Workspace = { ...workspace, chats: [] };
    const storedEntry: WorkspaceSession = { id: "chat-1", name: "Stored session", source: "stored", recencyMs: 2 };
    const storedSummary: LiveSessionSummary = { ...summaries[0]!, id: "chat-1" };
    const onSelect = vi.fn();
    const onActivated = vi.fn();
    let resolve!: (result: "opened") => void;
    const pending = new Promise<"opened">((done) => { resolve = done; });
    const onOpen = vi.fn(() => pending);
    renderList(
      { summaries: [storedSummary], workspaces: [storedOnlyWorkspace], sessionLists: new Map([["ws-1", [storedEntry]]]) },
      { onSelect, onOpen, onActivated },
    );

    act(() => {
      card(0).querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });

    expect(onOpen).toHaveBeenCalledWith(storedOnlyWorkspace, storedEntry, false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onActivated).not.toHaveBeenCalled();
    await act(async () => { resolve("opened"); await pending; });
    expect(onActivated).toHaveBeenCalledTimes(1);
  });

  it("awaits a discovered open before reporting activation", async () => {
    const onSelect = vi.fn();
    const onActivated = vi.fn();
    let resolve!: (result: "opened") => void;
    const pending = new Promise<"opened">((done) => { resolve = done; });
    const onOpen = vi.fn(() => pending);
    renderList({}, { onSelect, onOpen, onActivated });

    act(() => {
      card(1).querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });

    expect(onOpen).toHaveBeenCalledWith(workspace, discoveredSessions[1], false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onActivated).not.toHaveBeenCalled();
    await act(async () => { resolve("opened"); await pending; });
    expect(onActivated).toHaveBeenCalledTimes(1);
  });

  it("does not report activation when a discovered open does not open", async () => {
    const onOpen = vi.fn(async () => "session-active" as const);
    const onActivated = vi.fn();
    renderList({}, { onOpen, onActivated });

    act(() => {
      card(1).querySelector<HTMLButtonElement>(".th-overview-card-open")?.click();
    });
    // Flush the openSession continuation; the click itself is synchronous.
    await act(async () => { await Promise.resolve(); });

    expect(onOpen).toHaveBeenCalledWith(workspace, discoveredSessions[1], false);
    expect(onActivated).not.toHaveBeenCalled();
  });

  it("renders the read-only active state with a force path", () => {
    const onOpen = vi.fn(async () => "opened" as const);
    const key = sessionOpenAttemptKey(workspace.id, discoveredSessions[1]!.id);
    renderList({}, { onOpen, openAttempts: new Map([[key, "session-active"]]) });

    const active = card(1);
    expect(active.textContent).toContain("overview.readOnlyLive");
    expect(active.querySelector<HTMLButtonElement>(".th-overview-card-open")?.disabled).toBe(true);
    act(() => active.querySelector<HTMLButtonElement>(".th-overview-force-open")?.click());
    expect(onOpen).toHaveBeenLastCalledWith(workspace, discoveredSessions[1], true);
  });

  it("renders the failed state with a retry path", () => {
    const onOpen = vi.fn(async () => "opened" as const);
    const key = sessionOpenAttemptKey(workspace.id, discoveredSessions[1]!.id);
    renderList({}, { onOpen, openAttempts: new Map([[key, "failed"]]) });

    const failed = card(1);
    expect(failed.textContent).toContain("sidebar.tm.openFailed");
    act(() => failed.querySelector<HTMLButtonElement>(".th-overview-retry-open")?.click());
    expect(onOpen).toHaveBeenLastCalledWith(workspace, discoveredSessions[1], false);
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
