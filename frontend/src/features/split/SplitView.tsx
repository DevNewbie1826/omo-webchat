import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../i18n";
import { ChatPane } from "./ChatPane";
import { connectChat } from "../../lib/chatWs";
import { IconX } from "../../components/icons";
import type { PaneNode, SplitDir } from "./paneTree";
import type { ToastKind } from "../../components/SessionTree";
import type { ChatSessionRef, Workspace, WorkspaceSession } from "../workspace/workspace";
import type { WorkspaceSessionPaging } from "../workspace/useWorkspaces";

export interface SplitActions {
  readonly onFocusPane: (paneId: string) => void;
  readonly onAssign: (paneId: string, tmId: string, wsId?: string) => void;
  readonly onCreateTerminal: (paneId: string, wsId: string) => void;
  readonly onSplit: (paneId: string, dir: SplitDir) => void;
  readonly onClosePane: (paneId: string) => void;
  readonly onRatioChange: (splitId: string, ratio: number) => void;
  readonly onOpenSidebar: () => void;
  readonly notify: (msg: string, kind?: ToastKind) => void;
}

export interface SplitViewProps {
  readonly node: PaneNode;
  readonly workspaces: readonly Workspace[];
  readonly placed: ReadonlySet<string>;
  readonly sessions: ReadonlyMap<string, ChatSessionRef>;
  /** Paged MRU session history per workspace; drives the picker list order. */
  readonly sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]>;
  readonly sessionPages: ReadonlyMap<string, WorkspaceSessionPaging>;
  /** Requests the selected workspace's first session page when it is absent. */
  readonly onEnsureSessions: (wsId: string) => void;
  readonly focusedPaneId: string;
  readonly splitEnabled: boolean;
  readonly actions: SplitActions;
  readonly onChatName?: (wsId: string, chatId: string, name: string) => void;
}

type LeafData = Extract<PaneNode, { readonly kind: "leaf" }>;
type SplitData = Extract<PaneNode, { readonly kind: "split" }>;

const DIVIDER_SIZE = 4;
const MIN_PANE_SIZE = 320;

function safeRatioBounds(containerSize: number): { readonly min: number; readonly max: number } {
  const usableSize = Math.max(0, containerSize - DIVIDER_SIZE);
  if (usableSize < MIN_PANE_SIZE * 2) return { min: 0.5, max: 0.5 };
  const min = MIN_PANE_SIZE / usableSize;
  return { min, max: 1 - min };
}

function clampRatio(ratio: number, bounds: { readonly min: number; readonly max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, ratio));
}

function LeafView({ node, workspaces, placed, sessions, sessionLists, sessionPages, onEnsureSessions, focusedPaneId, splitEnabled, actions, onChatName }: SplitViewProps & { readonly node: LeafData }) {
  const { t } = useT();
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const session = node.sessionId !== null ? sessions.get(node.sessionId) : undefined;
  const workspaceID = workspaces.some((workspace) => workspace.id === selectedWorkspace)
    ? selectedWorkspace
    : (workspaces[0]?.id ?? "");
  const paging = workspaceID !== "" ? sessionPages.get(workspaceID) : undefined;
  const pageLoading = paging?.loading === true && paging.ready !== true;

  // The picker reads the sidebar's paged MRU source; make sure the selected
  // workspace's first page is on its way. Repeat suppression lives in the
  // hook (ready/in-flight guard), so re-renders cannot loop fetches.
  useEffect(() => {
    if (session || workspaceID === "") return;
    onEnsureSessions(workspaceID);
  }, [session, workspaceID, onEnsureSessions]);

  if (!session) {
    const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceID);
    const unplaced = (sessionLists.get(workspaceID) ?? []).filter(
      (entry) => entry.source === "stored" && !placed.has(entry.id) && sessions.has(entry.id),
    );
    return (
      <div className="th-pane-wrap">
        {splitEnabled && (
          <button
            type="button"
            className="th-btn-icon th-btn-icon--danger th-pane-close"
            title={t("split.close")}
            aria-label={t("split.close")}
            onClick={() => actions.onClosePane(node.id)}
          >
            <IconX size={14} />
          </button>
        )}
        <div className="th-picker-pane">
          <div className="th-picker-pane-title">{t("split.pickTitle")}</div>
          <select
            aria-label={t("split.pickWorkspace")}
            value={workspaceID}
            disabled={workspaces.length === 0}
            onChange={(event) => setSelectedWorkspace(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
            ))}
          </select>
          {pageLoading ? (
            <div className="th-picker-pane-empty">{t("split.pickLoading")}</div>
          ) : unplaced.length > 0 ? (
            <div className="th-picker-pane-list">
              {unplaced.map((entry) => {
                const label = `${activeWorkspace?.name ?? ""} / ${entry.name}`;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="th-picker-pane-item"
                    title={label}
                    aria-label={label}
                    onClick={() => actions.onAssign(node.id, entry.id, workspaceID)}
                  >
                    <span className="th-picker-pane-name">{entry.name}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="th-picker-pane-empty">{t(workspaces.length === 0 ? "split.pickEmpty" : "split.pickEmptyFiltered")}</div>
          )}
          <div className="th-picker-pane-create">
            <button
              type="button"
              className="th-btn th-btn--primary"
              disabled={!workspaceID}
              onClick={() => actions.onCreateTerminal(node.id, workspaceID)}
            >
              {t("split.pickNew")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="th-pane-wrap">
      <ChatPane
        key={session.id}
        chatSession={session}
        focused={focusedPaneId === node.id}
        splitEnabled={splitEnabled}
        onFocus={() => actions.onFocusPane(node.id)}
        onSplit={(dir) => actions.onSplit(node.id, dir)}
        onClose={() => actions.onClosePane(node.id)}
        onOpenSidebar={actions.onOpenSidebar}
        connect={connectChat}
        notify={actions.notify}
        {...(onChatName ? { onChatName: (name: string) => onChatName(session.wsId, session.id, name) } : {})}
      />
    </div>
  );
}

function SplitNodeView(props: SplitViewProps & { readonly node: SplitData }) {
  const { node, actions } = props;
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [containerSize, setContainerSize] = useState(0);
  const bounds = safeRatioBounds(containerSize);
  const displayedRatio = clampRatio(node.ratio, bounds);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setContainerSize(node.dir === "h" ? entry.contentRect.width : entry.contentRect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [node.dir]);

  const onPointerDown = (ev: ReactPointerEvent<HTMLHRElement>): void => {
    ev.preventDefault();
    dragging.current = true;
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: ReactPointerEvent<HTMLHRElement>): void => {
    if (!dragging.current) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio =
      node.dir === "h"
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
    actions.onRatioChange(node.id, clampRatio(ratio, bounds));
  };

  const endDrag = (ev: ReactPointerEvent<HTMLHRElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  };

  const onSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLHRElement>): void => {
    let ratio = displayedRatio;
    if (event.key === "Home") ratio = bounds.min;
    else if (event.key === "End") ratio = bounds.max;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") ratio -= 0.05;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") ratio += 0.05;
    else return;
    event.preventDefault();
    actions.onRatioChange(node.id, clampRatio(ratio, bounds));
  };

  return (
    <div ref={containerRef} className={`th-split th-split--${node.dir}`}>
      <div className="th-split-child" style={{ flexGrow: displayedRatio }}>
        <SplitView {...props} node={node.first} />
      </div>
      <hr
        className="th-divider"
        tabIndex={0}
        aria-orientation={node.dir === "h" ? "vertical" : "horizontal"}
        aria-label={t("split.resize")}
        aria-valuemin={Math.floor(bounds.min * 100)}
        aria-valuemax={Math.ceil(bounds.max * 100)}
        aria-valuenow={Math.round(displayedRatio * 100)}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <div className="th-split-child" style={{ flexGrow: 1 - displayedRatio }}>
        <SplitView {...props} node={node.second} />
      </div>
    </div>
  );
}

export function SplitView(props: SplitViewProps) {
  const { node } = props;
  if (node.kind === "split") {
    return <SplitNodeView {...props} node={node} />;
  }
  return <LeafView {...props} node={node} />;
}
