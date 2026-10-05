import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import {
  IconEdit,
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconPlus,
  IconTerminal,
  IconTrash,
} from "./icons";
import type { Terminal, Workspace, WorkspaceSession } from "../features/workspace/workspace";
import type { WorkspaceSessionPaging } from "../features/workspace/useWorkspaces";
import { sessionOpenAttemptKey, type SessionOpenAttemptResult, type SessionOpenAttemptStatus } from "../features/workspace/useSessionOpenAttempts";
import { formatRpcLiveRecency, type RpcLiveSession } from "../features/workspace/rpcSessions";

export type ToastKind = "info" | "success" | "error";

export interface SessionTreeProps {
  readonly workspaces: readonly Workspace[];
  readonly touchActions?: boolean;
  readonly activeTerminalId: string | null;
  readonly placedSessions: ReadonlySet<string>;
  readonly liveSessions: ReadonlySet<string>;
  /** Exact child-agent counts, never including main-session work. */
  readonly runningCounts?: ReadonlyMap<string, number> | undefined;
  readonly activeSessions?: ReadonlySet<string> | undefined;
  readonly aggregateSessionIds?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  readonly expanded: ReadonlySet<string>;
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly sessionPages: ReadonlyMap<string, WorkspaceSessionPaging>;
  readonly onToggle: (wsId: string) => void;
  readonly onLoadMoreSessions: (wsId: string) => void;
  readonly onSelect: (ws: Workspace, tm: Terminal) => void;
  readonly onOpen: (ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<SessionOpenAttemptResult>;
  readonly openAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  /** Unbound watcher rows pinned above the paged history. */
  readonly rpcLiveRows?: ReadonlyMap<string, readonly RpcLiveSession[]> | undefined;
  /** Watcher status for bound chats the manager does not route, by chat id. */
  readonly rpcLiveChats?: ReadonlyMap<string, RpcLiveSession> | undefined;
  /** Activates a watcher row through the rpc open endpoint. */
  readonly onOpenRpc?: (ws: Workspace, live: RpcLiveSession) => Promise<SessionOpenAttemptResult>;
  readonly rpcOpenAttempts?: ReadonlyMap<string, SessionOpenAttemptStatus>;
  readonly onViewLive?: (sessionId: string) => void;
  readonly onAddTerminal: (ws: Workspace) => void;
  readonly onDeleteWorkspace: (ws: Workspace) => void;
  readonly onDeleteTerminal: (ws: Workspace, tm: Terminal) => void;
  readonly onRenameWorkspace: (ws: Workspace, name: string) => Promise<void>;
  readonly onRenameTerminal: (ws: Workspace, tm: Terminal, name: string) => Promise<void>;
  readonly notify: (msg: string, kind?: ToastKind) => void;
}

interface RenameTarget {
  readonly kind: "workspace" | "terminal";
  readonly wsId: string;
  readonly tmId: string;
}

interface SelectionIndicatorState {
  /** Session the indicator last tracked, placed or hidden. */
  key: string | null;
  /** Last applied geometry; null while hidden so the next placement jumps. */
  box: string | null;
}

const INDICATOR_VISIBLE = "th-tree-indicator--visible";
const INDICATOR_INSTANT = "th-tree-indicator--instant";

const roundPx = (value: number): number => Math.round(value * 100) / 100;

/** Moves the tree's single selection indicator onto the active row. Only a
 * selection change between two visible rows travels (CSS transform
 * transition, retargeted mid-flight); first placement and layout-only moves
 * jump, and a hidden or collapsed active row hides the indicator. */
function placeSelectionIndicator(
  tree: HTMLElement,
  indicator: HTMLElement,
  key: string | null,
  state: SelectionIndicatorState,
): void {
  const row = tree.querySelector<HTMLElement>(".th-tree-node--active");
  if (row === null || row.closest(".th-tree-children--closed") !== null) {
    indicator.classList.remove(INDICATOR_VISIBLE);
    state.key = key;
    state.box = null;
    return;
  }
  const origin = tree.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  const left = roundPx(bounds.left - origin.left);
  const top = roundPx(bounds.top - origin.top);
  const width = roundPx(bounds.width);
  const height = roundPx(bounds.height);
  const box = `${left},${top},${width},${height}`;
  if (state.key === key && state.box === box) return;
  const travel = state.box !== null && state.key !== key;
  if (!travel) indicator.classList.add(INDICATOR_INSTANT);
  indicator.style.left = `${left}px`;
  indicator.style.width = `${width}px`;
  indicator.style.height = `${height}px`;
  indicator.style.transform = `translateY(${top}px)`;
  indicator.classList.add(INDICATOR_VISIBLE);
  if (!travel) {
    // Flush the jump while transitions are off, then restore them.
    void indicator.offsetHeight;
    indicator.classList.remove(INDICATOR_INSTANT);
  }
  state.key = key;
  state.box = box;
}

export function SessionTree({
  workspaces,
  touchActions = false,
  activeTerminalId,
  placedSessions,
  liveSessions,
  runningCounts,
  activeSessions,
  aggregateSessionIds,
  expanded,
  sessionLists,
  sessionPages,
  onToggle,
  onLoadMoreSessions,
  onSelect,
  onOpen,
  openAttempts = new Map(),
  rpcLiveRows,
  rpcLiveChats,
  onOpenRpc,
  rpcOpenAttempts = new Map(),
  onViewLive,
  onAddTerminal,
  onDeleteWorkspace,
  onDeleteTerminal,
  onRenameWorkspace,
  onRenameTerminal,
  notify,
}: SessionTreeProps) {
  const { t } = useT();
  const [rename, setRename] = useState<RenameTarget | null>(null);
  // Workspace-row overflow menu (coarse pointers, G40): three row actions
  // collapse behind one trigger so the disclosure, the workspace identity,
  // and every 44px hit area fit the 264px shell. The popup is a disclosure
  // (labelled group of buttons), not a menu: aria-expanded + aria-controls,
  // no aria-haspopup, natural Tab order, and Escape returns focus to the
  // workspace's own trigger instead of dropping it on the body when the
  // popup unmounts.
  const [overflowFor, setOverflowFor] = useState<string | null>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (overflowFor === null) return;
    const onPointerDown = (event: PointerEvent) => {
      // Outside press closes without touching focus: the press lands where
      // the user aimed it, never on the trigger.
      if (event.target instanceof Element && event.target.closest(".th-tree-actions--overflow")) return;
      setOverflowFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Dismissed from inside the popup, the focused action button is about
      // to unmount; move focus to the surviving trigger first so Escape
      // never leaves focus on the body. Escape on the trigger itself keeps
      // focus there without help.
      const active = document.activeElement;
      const focusInPopup = active instanceof Element && active.closest(".th-tree-overflow") !== null;
      setOverflowFor(null);
      if (focusInPopup) overflowTriggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [overflowFor]);
  const openingRef = useRef(new Set<string>());
  const treeRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const indicatorState = useRef<SelectionIndicatorState>({ key: null, box: null });
  const activeKeyRef = useRef(activeTerminalId);

  // Any render can move, reveal, or hide the active row.
  useLayoutEffect(() => {
    activeKeyRef.current = activeTerminalId;
    const tree = treeRef.current;
    const indicator = indicatorRef.current;
    if (tree && indicator) placeSelectionIndicator(tree, indicator, activeTerminalId, indicatorState.current);
  });

  // Type-size changes and font swaps resize rows without a render.
  useEffect(() => {
    const tree = treeRef.current;
    const indicator = indicatorRef.current;
    if (!tree || !indicator || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      placeSelectionIndicator(tree, indicator, activeKeyRef.current, indicatorState.current);
    });
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);

  const openDiscovered = (ws: Workspace, session: WorkspaceSession, force = false): void => {
    const key = sessionOpenAttemptKey(ws.id, session.id);
    if (openingRef.current.has(key)) return;
    openingRef.current.add(key);
    void onOpen(ws, session, force).finally(() => openingRef.current.delete(key));
  };

  const openRpcLive = (ws: Workspace, live: RpcLiveSession): void => {
    if (onOpenRpc === undefined) return;
    const key = sessionOpenAttemptKey(ws.id, live.sessionId);
    if (openingRef.current.has(key)) return;
    openingRef.current.add(key);
    void onOpenRpc(ws, live).finally(() => openingRef.current.delete(key));
  };

  const commitRename = (target: RenameTarget, value: string): void => {
    const name = value.trim();
    const trigger = renameTriggerRef.current;
    renameTriggerRef.current = null;
    if (name.length === 0 && trigger) {
      // Rename is inline, not a modal: follow modalStack's trigger ->
      // focused composer -> main focus-return policy before removing input.
      const canFocus = (element: HTMLElement | null): element is HTMLElement => {
        if (!element?.isConnected || element.matches(":disabled") || element.closest("[inert]")) return false;
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || style.display === "none" || style.visibility !== "visible") return false;
        }
        return true;
      };
      if (canFocus(trigger)) trigger.focus();
      if (document.activeElement !== trigger) {
        const composer = document.querySelector<HTMLTextAreaElement>(".th-pane--focused .th-chat-input textarea");
        if (canFocus(composer)) composer.focus();
        if (document.activeElement !== composer) {
          const main = document.querySelector<HTMLElement>("main.th-main");
          if (canFocus(main)) {
            if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
            main.focus();
          }
        }
      }
    }
    setRename(null);
    if (name.length === 0) return;
    const ws = workspaces.find((w) => w.id === target.wsId);
    if (!ws) return;
    if (target.kind === "workspace") {
      if (name === ws.name) return;
      onRenameWorkspace(ws, name).catch(() => notify(t("toast.error"), "error"));
    } else {
      const item = (sessionLists.get(ws.id) ?? []).find(
        (session) => session.id === target.tmId && session.source === "stored" && session.dangling !== true,
      );
      const tm = ws.chats.find((x) => x.id === target.tmId) ?? (item
        ? { id: item.id, name: item.name, provider: "omo" as const }
        : undefined);
      if (!tm || name === tm.name) return;
      onRenameTerminal(ws, tm, name).catch(() => notify(t("toast.error"), "error"));
    }
  };

  return (
    <div
      ref={treeRef}
      className={`th-tree${touchActions ? " th-tree--touch" : ""}`}
      role="navigation"
      aria-label={t("sidebar.title")}
    >
      <span ref={indicatorRef} className="th-tree-indicator" aria-hidden="true" />
      {workspaces.map((ws) => {
        const isOpen = expanded.has(ws.id);
        const paging = sessionPages.get(ws.id);
        const mergedSessionIds = new Set(ws.chats.map((chat) => chat.id));
        for (const session of sessionLists.get(ws.id) ?? []) mergedSessionIds.add(session.id);
        for (const id of aggregateSessionIds?.get(ws.id) ?? []) mergedSessionIds.add(id);
        const workspaceRunning = Array.from(mergedSessionIds).reduce((total, id) => total + (runningCounts?.get(id) ?? 0), 0);
        const workspaceMainRunning = Array.from(mergedSessionIds).some((id) => activeSessions?.has(id));
        const rpcRows = rpcLiveRows?.get(ws.id) ?? [];
        // A live watcher row is the single representation of its session:
        // it suppresses the disk-discovered history row at the same path.
        const rpcSuppressedPaths = new Set(rpcRows.map((row) => row.sessionPath));
        const historyRows = (sessionLists.get(ws.id) ?? []).filter((item) =>
          !(item.source === "discovered" && item.resumeIdentity !== undefined && rpcSuppressedPaths.has(item.resumeIdentity)));
        const renamingWs =
          rename && rename.kind === "workspace" && rename.wsId === ws.id ? rename : null;
        const nameTail = ws.name.match(/\s\S{1,4}$/u)?.[0] ?? Array.from(ws.name).slice(-5).join("");
        const nameHead = ws.name.slice(0, ws.name.length - nameTail.length);
        return (
          <div key={ws.id} className="th-tree-workspace">
            <div className="th-tree-node">
              {renamingWs ? (
                <>
                  <button
                    type="button"
                    className="th-tree-chevron th-tree-icon"
                    aria-label={isOpen ? t("sidebar.collapse") : t("sidebar.expand")}
                    aria-expanded={isOpen}
                    onClick={() => onToggle(ws.id)}
                  >
                    {isOpen ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
                  </button>
                  <RenameInput initial={ws.name} onCommit={(v) => commitRename(renamingWs, v)} />
                </>
              ) : (
                <button
                  type="button"
                  className="th-tree-label th-tree-chevron th-tree-activation th-tree-workspace-activation"
                  style={{ textAlign: "start" }}
                  title={ws.path}
                  aria-label={ws.name}
                  aria-expanded={isOpen}
                  onClick={() => onToggle(ws.id)}
                >
                  <span className="th-tree-icon" aria-hidden="true">
                    {isOpen ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
                  </span>
                  <span className="th-tree-label-text" aria-hidden="true">
                    <span className="th-tree-label-head">{nameHead}</span>
                    <span className="th-tree-label-tail">{nameTail}</span>
                  </span>
                </button>
              )}
              {touchActions ? (
                <span className="th-tree-actions th-tree-actions--overflow">
                  <button
                    type="button"
                    className="th-btn-icon"
                    title={t("sidebar.ws.moreActions")}
                    aria-expanded={overflowFor === ws.id}
                    aria-controls={`th-tree-overflow-${ws.id}`}
                    onClick={(event) => {
                      overflowTriggerRef.current = event.currentTarget;
                      setOverflowFor((open) => (open === ws.id ? null : ws.id));
                    }}
                  >
                    <IconMore size={14} />
                  </button>
                  {overflowFor === ws.id ? (
                    <span
                      id={`th-tree-overflow-${ws.id}`}
                      role="group"
                      aria-label={t("sidebar.ws.moreActions")}
                      className="th-tree-overflow"
                    >
                      <button
                        type="button"
                        className="th-tree-overflow-item"
                        onClick={() => {
                          renameTriggerRef.current = overflowTriggerRef.current;
                          setOverflowFor(null);
                          setRename({ kind: "workspace", wsId: ws.id, tmId: "" });
                        }}
                      >
                        <IconEdit size={13} />
                        {t("sidebar.ws.rename")}
                      </button>
                      <button
                        type="button"
                        className="th-tree-overflow-item"
                        onClick={() => {
                          overflowTriggerRef.current?.focus();
                          setOverflowFor(null);
                          onAddTerminal(ws);
                        }}
                      >
                        <IconPlus size={13} />
                        {t("sidebar.ws.addTerminal")}
                      </button>
                      <button
                        type="button"
                        className="th-tree-overflow-item th-tree-overflow-item--danger"
                        onClick={() => {
                          overflowTriggerRef.current?.focus();
                          setOverflowFor(null);
                          onDeleteWorkspace(ws);
                        }}
                      >
                        <IconTrash size={13} />
                        {t("sidebar.ws.delete")}
                      </button>
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="th-tree-actions">
                  <button
                    type="button"
                    className="th-btn-icon"
                    title={t("sidebar.ws.rename")}
                    onClick={() => {
                      renameTriggerRef.current = null;
                      setRename({ kind: "workspace", wsId: ws.id, tmId: "" });
                    }}
                  >
                    <IconEdit size={12} />
                  </button>
                  <button
                    type="button"
                    className="th-btn-icon"
                    title={t("sidebar.ws.addTerminal")}
                    onClick={() => onAddTerminal(ws)}
                  >
                    <IconPlus size={13} />
                  </button>
                  <button
                    type="button"
                    className="th-btn-icon th-btn-icon--danger"
                    title={t("sidebar.ws.delete")}
                    onClick={() => onDeleteWorkspace(ws)}
                  >
                    <IconTrash size={12} />
                  </button>
                </span>
              )}
              <span className="th-tree-count-slot">
                <span className={`th-tree-count${workspaceRunning > 0 || workspaceMainRunning ? " th-tree-count--running" : ""}`}>
                  {mergedSessionIds.size}
                </span>
                {workspaceRunning > 0 || workspaceMainRunning ? (
                  <RunningChip
                    className="th-tree-running th-tree-running--workspace"
                    count={workspaceRunning}
                    countLabelKey="sidebar.ws.runningAgents"
                    mainRunning={workspaceMainRunning}
                  />
                ) : null}
              </span>
            </div>

            <fieldset className={`th-tree-children${isOpen ? "" : " th-tree-children--closed"}`}>
              {rpcRows.map((live) => {
                const attempt = rpcOpenAttempts.get(sessionOpenAttemptKey(ws.id, live.sessionId));
                const openInFlight = attempt === "opening";
                const openFailed = attempt === "failed";
                const displayName = live.name.trim() !== "" ? live.name : live.sessionId.slice(0, 8);
                const recency = formatRpcLiveRecency(live.updatedAt, Date.now(), t);
                return (
                  <div
                    key={`rpc:${live.sessionId}`}
                    className={`th-tree-node${openInFlight ? " th-tree-node--disabled" : ""}`}
                    data-th-rpc-session={live.sessionId}
                  >
                    <span className="th-tree-placed" aria-hidden="true" />
                    <span className="th-tree-icon">
                      <IconTerminal size={13} />
                    </span>
                    <button
                      type="button"
                      className="th-tree-activation"
                      title={openFailed ? t("sidebar.tm.openFailed") : recency}
                      aria-label={t("sidebar.tm.discoveredHint", { name: displayName })}
                      aria-busy={openInFlight || undefined}
                      disabled={openInFlight}
                      onClick={() => openRpcLive(ws, live)}
                    >
                      <span className="th-tree-label">{displayName}</span>
                      <span className="th-tree-live-recency" aria-hidden="true">{recency}</span>
                      {openInFlight || openFailed ? (
                        <span className="th-tree-source" aria-hidden="true">
                          {openInFlight ? t("sidebar.tm.opening") : t("sidebar.tm.openFailed")}
                        </span>
                      ) : null}
                    </button>
                    {live.status === "blocked" ? (
                      <span className="th-tree-questions" title={live.questions.join("\n")}>
                        {t("sidebar.live.blocked")}
                      </span>
                    ) : null}
                    {live.status === "working" ? (
                      <RunningChip
                        className="th-tree-running"
                        count={0}
                        countLabelKey="sidebar.tm.runningAgents"
                        mainRunning
                      />
                    ) : null}
                  </div>
                );
              })}
              {historyRows.map((item) => {
                const stored = item.source === "stored";
                const listed = stored ? ws.chats.find((chat) => chat.id === item.id) : undefined;
                // v2 union: the sessions REST also lists cursorstore-only chats
                // the legacy workspace chat list does not carry. They are real
                // chats — activate them through the same select flow instead of
                // rendering a dead row. Dangling identities stay inert.
                const tm = listed ?? (stored && item.dangling !== true
                  ? { id: item.id, name: item.name, provider: "omo" as const }
                  : undefined);
                const discovered = item.source === "discovered";
                const openKey = sessionOpenAttemptKey(ws.id, item.id);
                const openAttempt = discovered ? openAttempts.get(openKey) : undefined;
                const openInFlight = openAttempt === "opening";
                const activeElsewhere = openAttempt === "session-active";
                const openFailed = openAttempt === "failed";
                const interactive = tm !== undefined || discovered;
                const rowDisabled = !interactive || openInFlight || activeElsewhere;
                const active = tm !== undefined && item.id === activeTerminalId;
                const live = tm !== undefined && liveSessions.has(item.id);
                const renamingTm = tm !== undefined && rename?.kind === "terminal" && rename.tmId === item.id
                  ? rename
                  : null;
                const runningInfo = runningCounts?.get(item.id);
                const running = runningInfo ?? 0;
                // A bound chat whose route the manager does not own still
                // carries the watcher status: working rows keep the running
                // chip, blocked rows grow the question pill.
                const rpcBound = rpcLiveChats?.get(item.id);
                const mainRunning = activeSessions?.has(item.id) === true || rpcBound?.status === "working";
                const boundBlocked = rpcBound?.status === "blocked";
                const displayName = item.name.trim() !== "" ? item.name : t("sidebar.tm.untitled", { id: item.id.slice(0, 8) });
                const discoveredLabel = discovered
                  ? t("sidebar.tm.discoveredHint", { name: displayName })
                  : undefined;
                const dangling = item.source === "stored" && item.dangling === true;
                const danglingHint = dangling
                  ? t("sidebar.tm.missingOriginalHint", { name: displayName })
                  : undefined;
                const title = danglingHint
                  ?? (openInFlight ? t("sidebar.tm.opening") : openFailed ? t("sidebar.tm.openFailed") : discoveredLabel)
                  ?? (live ? t("sidebar.tm.liveProcess") : undefined);
                const activate = (): void => {
                  if (tm !== undefined) onSelect(ws, tm);
                  else if (discovered) openDiscovered(ws, item);
                };
                return (
                  <div
                    key={`${item.source}:${item.id}`}
                    className={`th-tree-node${active ? " th-tree-node--active" : ""}${rowDisabled ? " th-tree-node--disabled" : ""}`}
                  >
                    <span
                      className={`th-tree-placed${tm !== undefined && placedSessions.has(item.id) ? " th-tree-placed--on" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="th-tree-icon">
                      <IconTerminal size={13} />
                      {live && <span className="th-tree-live" aria-hidden="true" />}
                    </span>
                    {renamingTm && tm ? (
                      <RenameInput initial={tm.name} onCommit={(v) => commitRename(renamingTm, v)} />
                    ) : (
                      <button
                        type="button"
                        className="th-tree-activation"
                        title={title}
                        aria-label={discoveredLabel}
                        aria-current={active ? "true" : undefined}
                        aria-busy={openInFlight || undefined}
                        disabled={rowDisabled}
                        onClick={activate}
                      >
                        <span className="th-tree-label">{displayName}</span>
                        {openInFlight ? (
                          <span className="th-tree-source" aria-hidden="true">{t("sidebar.tm.opening")}</span>
                        ) : dangling ? (
                          <span className="th-tree-source" aria-hidden="true">{t("sidebar.tm.missingOriginal")}</span>
                        ) : null}
                      </button>
                    )}
                    {(activeElsewhere || openFailed) && (
                      <span className="th-tree-session-active" role="status">
                        {t(activeElsewhere ? "sidebar.tm.sessionActive" : "sidebar.tm.openFailed")}
                        {activeElsewhere && onViewLive && (running > 0 || mainRunning) && (
                          <button
                            type="button"
                            className="th-btn th-btn--ghost th-tree-view-live"
                            onClick={() => onViewLive(item.id)}
                          >
                            {t("sidebar.tm.viewLive")}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`th-btn th-btn--ghost ${activeElsewhere ? "th-tree-force-open" : "th-tree-retry-open"}`}
                          onClick={() => openDiscovered(ws, item, activeElsewhere)}
                        >
                          {t(activeElsewhere ? "sidebar.tm.forceOpen" : "sidebar.tm.retryOpen")}
                        </button>
                      </span>
                    )}
                    {tm ? (
                      <span className="th-tree-actions">
                        <button
                          type="button"
                          className="th-btn-icon"
                          title={t("sidebar.tm.rename")}
                          onClick={() => setRename({ kind: "terminal", wsId: ws.id, tmId: tm.id })}
                        >
                          <IconEdit size={12} />
                        </button>
                        <button
                          type="button"
                          className="th-btn-icon th-btn-icon--danger"
                          title={t("sidebar.tm.delete")}
                          onClick={() => onDeleteTerminal(ws, tm)}
                        >
                          <IconTrash size={12} />
                        </button>
                      </span>
                    ) : null}
                    {boundBlocked && rpcBound ? (
                      <span className="th-tree-questions" title={rpcBound.questions.join("\n")}>
                        {t("sidebar.live.blocked")}
                      </span>
                    ) : null}
                    {/* Same trailing-edge rule as the workspace row: actions
                        left of the running chip. */}
                    {(running > 0 || mainRunning) && (
                      <RunningChip
                        className="th-tree-running"
                        count={running}
                        countLabelKey="sidebar.tm.runningAgents"
                        mainRunning={mainRunning}
                      />
                    )}
                  </div>
                );
              })}
              {paging?.hasMore ? (
                <button
                  type="button"
                  className="th-tree-more"
                  disabled={paging.loading}
                  aria-busy={paging.loading || undefined}
                  onClick={() => onLoadMoreSessions(ws.id)}
                >
                  {paging.loading ? t("sidebar.ws.moreLoading") : t("sidebar.ws.more")}
                </button>
              ) : null}
            </fieldset>
          </div>
        );
      })}
    </div>
  );
}

interface RunningChipProps {
  readonly className: string;
  /** Exact child-agent count; the chip falls back to the main-running label at 0. */
  readonly count: number;
  readonly countLabelKey: string;
  readonly mainRunning: boolean;
}

function RunningChip({ className, count, countLabelKey, mainRunning }: RunningChipProps) {
  const { t } = useT();
  return (
    <span
      className={`${className}${count > 0 ? " th-tree-running--count" : ""}`}
      role="img"
      aria-label={count > 0 ? t(countLabelKey, { n: count }) : t("sidebar.tm.mainRunning")}
      title={mainRunning ? t("sidebar.tm.mainRunning") : undefined}
    >
      <span className="th-tree-running-dot" aria-hidden="true" />
      {count > 0 ? count : null}
    </span>
  );
}

interface RenameInputProps {
  readonly initial: string;
  readonly onCommit: (value: string) => void;
}

function RenameInput({ initial, onCommit }: RenameInputProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => inputRef.current?.focus(), []);

  const commit = (v: string): void => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };

  return (
    <input
      ref={inputRef}
      className="th-input th-tree-rename"
      value={value}
      onClick={(ev) => ev.stopPropagation()}
      onChange={(ev) => setValue(ev.target.value)}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") commit(value);
        else if (ev.key === "Escape") commit("");
      }}
      onBlur={() => commit(value)}
    />
  );
}
