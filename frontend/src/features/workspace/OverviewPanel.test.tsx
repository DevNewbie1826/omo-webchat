import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { I18nValue } from "../../i18n";
import { OverviewPanel } from "./OverviewPanel";
import type { LiveSessionSummary } from "./useLiveSessionSummaries";
import type { Terminal, Workspace, WorkspaceSession } from "./workspace";

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
    truncatedTasks: false,
    taskOversized: false,
    dagOversized: false,
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
    truncatedTasks: false,
    taskOversized: false,
    dagOversized: false,
  },
];

function card(index: number): HTMLElement {
  const cards = document.body.querySelectorAll<HTMLElement>(".th-overview-card");
  expect(cards.length).toBeGreaterThan(index);
  return cards[index]!;
}

describe("OverviewPanel", () => {
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

  interface PanelHandlers {
    onClose?: () => void;
    onSelect?: (ws: Workspace, tm: Terminal) => void;
    onImport?: (ws: Workspace, session: WorkspaceSession) => Promise<void>;
  }

  function renderPanel(
    props: Partial<{ summaries: readonly LiveSessionSummary[]; open: boolean }> = {},
    handlers: PanelHandlers = {},
  ): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <OverviewPanel
            open={props.open ?? true}
            onClose={handlers.onClose ?? (() => undefined)}
            summaries={props.summaries ?? summaries}
            workspaces={[workspace]}
            sessionLists={new Map([["ws-1", discoveredSessions]])}
            onSelect={handlers.onSelect ?? (() => undefined)}
            onImport={handlers.onImport ?? (async () => undefined)}
          />
        </I18nContext.Provider>,
      );
    });
  }

  it("renders one alive card per live session with counts, dag progress, and last line", () => {
    renderPanel();

    const first = card(0);
    expect(first.querySelector(".th-overview-card-name")?.textContent).toBe("Refactor auth");
    const running = first.querySelector(".th-overview-card-running");
    expect(running?.textContent).toBe("2");
    expect(running?.getAttribute("aria-label")).toBe("overview.runningAria 2");
    expect(running?.querySelector(".th-overview-card-running-dot")).not.toBeNull();

    const partialSummary: LiveSessionSummary = {
      id: "tm-1",
      title: "Refactor auth",
      runningCount: 2,
      doneCount: 1,
      dagDone: 2,
      dagTotal: 3,
      lastLine: "ls -la /work",
      dagRunning: 0,
      truncatedTasks: true,
      taskOversized: false,
      dagOversized: false,
    };
    renderPanel({ summaries: [partialSummary] });
    const partialRunning = card(0).querySelector(".th-overview-card-running");
    expect(partialRunning?.textContent).toBe("2+");
    expect(partialRunning?.getAttribute("aria-label")).toBe("overview.runningAriaPartial 2");
    renderPanel();
    expect(first.querySelector(".th-overview-card-meta")?.textContent).toContain("overview.done 1");
    expect(first.querySelector(".th-overview-card-meta")?.textContent).toContain("overview.dag 2/3");
    expect(first.querySelector(".th-overview-card-line")?.textContent).toBe("ls -la /work");
    expect(first.tagName).toBe("BUTTON");

    const second = card(1);
    // No running agents, no dag, no line: the card degrades to title + done only,
    // and an empty title falls back to the session id.
    expect(second.querySelector(".th-overview-card-name")?.textContent).toBe("disk-9");
    expect(second.querySelector(".th-overview-card-running")).toBeNull();
    expect(second.querySelector(".th-overview-card-meta")?.textContent).not.toContain("overview.dag");
    expect(second.querySelector(".th-overview-card-line")).toBeNull();
  });

  it("opens a stored session's chat through the sidebar select flow", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    renderPanel({}, { onClose, onSelect });

    act(() => {
      card(0).click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(workspace, workspace.chats[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("imports a discovered session that has no stored chat yet", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const onImport = vi.fn(async () => undefined);
    renderPanel({}, { onClose, onSelect, onImport });

    act(() => {
      card(1).click();
    });

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith(workspace, discoveredSessions[1]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when nothing is running", () => {
    renderPanel({ summaries: [] });

    expect(document.body.querySelector(".th-overview-empty")?.textContent).toBe("overview.empty");
    expect(document.body.querySelectorAll(".th-overview-card")).toHaveLength(0);
  });
});
