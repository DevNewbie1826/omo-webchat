import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../i18n";
import { ChatPane } from "./ChatPane";
import { PaneResizeControl, PaneResizeSurface, PaneSizeOverlay, usePaneResize } from "./PaneResize";
import { minimumPaneSpan, PANE_DIVIDER_SIZE, RATIO_MIN, RATIO_MAX } from "./paneTree";
import { SessionPicker } from "./SessionPicker";
import { connectChat } from "../../lib/chatWs";
import { IconX } from "../../components/icons";
import type { PaneNode, SplitDir } from "./paneTree";
import type { ToastKind } from "../../components/SessionTree";
import type { ChatSessionRef, Workspace, WorkspaceSession } from "../workspace/workspace";
import type { WorkspaceSessionPaging } from "../workspace/useWorkspaces";

export interface SplitActions {
  readonly onFocusPane: (paneId: string) => void;
  readonly onOpenSession: (paneId: string, ws: Workspace, session: WorkspaceSession, force?: boolean) => Promise<"opened" | "session-active">;
  readonly onLoadMoreSessions: (wsId: string) => Promise<void>;
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

type TreeProps = SplitViewProps & { readonly boundaries: readonly SplitData[] };

function safeRatioBounds(containerSize: number, node: SplitData): { readonly min: number; readonly max: number } {
  const usableSize = Math.max(0, containerSize - PANE_DIVIDER_SIZE);
  const first = minimumPaneSpan(node.first, node.dir), second = minimumPaneSpan(node.second, node.dir);
  // When the viewport cannot fit the intrinsic minima, distribute the deficit
  // proportionally rather than overflowing or starving a nested subtree.
  if (usableSize < first + second) {
    const ratio = first / (first + second);
    return { min: ratio, max: ratio };
  }
  return { min: Math.max(RATIO_MIN, first / usableSize), max: Math.min(RATIO_MAX, 1 - second / usableSize) };
}

function clampRatio(ratio: number, bounds: { readonly min: number; readonly max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, ratio));
}

function LeafView({ node, workspaces, sessions, sessionLists, sessionPages, onEnsureSessions, focusedPaneId, splitEnabled, actions, onChatName, boundaries }: TreeProps & { readonly node: LeafData }) {
  const { t } = useT();
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const resizeControl = <PaneResizeControl boundaries={boundaries} />;
  const session = node.sessionId !== null ? sessions.get(node.sessionId) : undefined;
  if (!session) {
    return (
      <div className={`th-pane-wrap${focusedPaneId === node.id ? " th-pane--focused" : ""}`} data-pane-id={node.id} ref={setPane}
        onPointerDown={event => { if (event.target instanceof Node && event.currentTarget.contains(event.target)) actions.onFocusPane(node.id); }}
        onFocus={event => { if (event.currentTarget.contains(event.target)) actions.onFocusPane(node.id); }}>
        {resizeControl}
        <PaneSizeOverlay pane={pane} />
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
        <SessionPicker workspaces={workspaces} sessionLists={sessionLists} sessionPages={sessionPages}
          onEnsureSessions={onEnsureSessions} onLoadMoreSessions={actions.onLoadMoreSessions}
          onOpenSession={(ws, entry, force) => actions.onOpenSession(node.id, ws, entry, force)}
          onNewChat={wsId => actions.onCreateTerminal(node.id, wsId)} />
      </div>
    );
  }
  return (
    <div className="th-pane-wrap" data-pane-id={node.id} ref={setPane}>
      <PaneSizeOverlay pane={pane} />
      <ChatPane
        key={session.id}
        chatSession={session}
        resizeControl={resizeControl}
        focused={focusedPaneId === node.id}
        splitEnabled={splitEnabled}
        onFocus={() => actions.onFocusPane(node.id)}
        onSplit={(dir) => actions.onSplit(node.id, dir)}
        onClose={() => actions.onClosePane(node.id)}
        onOpenSidebar={actions.onOpenSidebar}
        onNewChat={() => actions.onCreateTerminal(node.id, session.wsId)}
        connect={connectChat}
        notify={actions.notify}
        {...(onChatName ? { onChatName: (name: string) => onChatName(session.wsId, session.id, name) } : {})}
      />
    </div>
  );
}

function SplitNodeView(props: TreeProps & { readonly node: SplitData }) {
  const { node, actions } = props;
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const resize = usePaneResize();
  const dragging = useRef(false);
  const [containerSize, setContainerSize] = useState(0);
  const bounds = safeRatioBounds(containerSize, node);
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

  useEffect(() => () => {
    resize.dragEnded(node.id);
    resize.dividerBlurred(node.id);
  }, [node.id, resize.dragEnded, resize.dividerBlurred]);

  const onPointerDown = (ev: ReactPointerEvent<HTMLHRElement>): void => {
    ev.preventDefault();
    ev.currentTarget.focus();
    dragging.current = true;
    resize.dragStarted(node.id);
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: ReactPointerEvent<HTMLHRElement>): void => {
    if (!dragging.current) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio =
      node.dir === "h"
        ? (ev.clientX - rect.left - PANE_DIVIDER_SIZE / 2) / (rect.width - PANE_DIVIDER_SIZE)
        : (ev.clientY - rect.top - PANE_DIVIDER_SIZE / 2) / (rect.height - PANE_DIVIDER_SIZE);
    actions.onRatioChange(node.id, clampRatio(ratio, bounds));
  };

  const endDrag = (ev: ReactPointerEvent<HTMLHRElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    resize.dragEnded(node.id);
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  };

  const onSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLHRElement>): void => {
    if (event.key === "Escape") { event.preventDefault(); resize.restoreFocus(); return; }
    let ratio = displayedRatio;
    if (event.key === "Home") ratio = bounds.min;
    else if (event.key === "End") ratio = bounds.max;
    else if (event.key === (node.dir === "h" ? "ArrowLeft" : "ArrowUp")) ratio -= 0.05;
    else if (event.key === (node.dir === "h" ? "ArrowRight" : "ArrowDown")) ratio += 0.05;
    else return;
    event.preventDefault();
    actions.onRatioChange(node.id, clampRatio(ratio, bounds));
  };

  return (
    <div ref={containerRef} className={`th-split th-split--${node.dir}`} data-split-id={node.id}>
      <div className="th-split-child" style={{ flexGrow: displayedRatio }}>
        <SplitTree {...props} node={node.first} boundaries={[node, ...props.boundaries]} />
      </div>
      <hr
        className={`th-divider${resize.draggingId === node.id ? " th-divider--dragging" : ""}`}
        role="separator"
        onFocus={event => resize.dividerFocused(node.id, event.relatedTarget)}
        onBlur={() => resize.dividerBlurred(node.id)}
        aria-describedby={hintId}
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
        onLostPointerCapture={endDrag}
      />
      <span id={hintId} className="th-divider-hint">{t(node.dir === "h" ? "split.resizeHintH" : "split.resizeHintV")}</span>
      <div className="th-split-child" style={{ flexGrow: 1 - displayedRatio }}>
        <SplitTree {...props} node={node.second} boundaries={[node, ...props.boundaries]} />
      </div>
    </div>
  );
}

function SplitTree(props: TreeProps) {
  const { node } = props;
  if (node.kind === "split") {
    return <SplitNodeView {...props} node={node} />;
  }
  return <LeafView {...props} node={node} />;
}

export function SplitView(props: SplitViewProps) {
  return <PaneResizeSurface><SplitTree {...props} boundaries={[]} /></PaneResizeSurface>;
}
