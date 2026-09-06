import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconSplitH } from "../../components/icons";
import { useT } from "../../i18n";
import type { PaneNode } from "./paneTree";

type Boundary = Extract<PaneNode, { readonly kind: "split" }>;
interface ResizeState {
  readonly workArea: HTMLElement | null;
  readonly active: boolean;
  readonly draggingId: string | null;
  readonly focusDivider: (id: string, origin: HTMLElement) => void;
  readonly dividerFocused: (id: string, previous: EventTarget | null) => void;
  readonly dividerBlurred: (id: string) => void;
  readonly dragStarted: (id: string) => void;
  readonly dragEnded: (id: string) => void;
  readonly restoreFocus: () => void;
}
const ResizeContext = createContext<ResizeState | null>(null);
export function usePaneResize(): ResizeState {
  const context = useContext(ResizeContext);
  if (!context) throw new Error("Pane resizing requires a work-area provider");
  return context;
}

/** One coordinator for the whole session work area, never for a split parent. */
export function PaneResizeSurface({ children }: { readonly children: ReactNode }) {
  const [workArea, setWorkArea] = useState<HTMLDivElement | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const explicitOrigin = useRef(false);
  const fallbackOrigin = useCallback(() => {
    const active = workArea?.querySelector(".th-pane--focused");
    return active?.closest(".th-pane-wrap")?.querySelector<HTMLElement>(".th-pane-resize")
      ?? workArea?.querySelector<HTMLElement>(".th-pane-resize") ?? null;
  }, [workArea]);
  const dividerFocused = useCallback((id: string, previous: EventTarget | null) => {
    if (!explicitOrigin.current) {
      origin.current = previous instanceof HTMLElement && workArea?.contains(previous) && previous.closest(".th-pane-wrap")
        ? previous : fallbackOrigin();
    }
    explicitOrigin.current = false;
    setFocusedId(id);
  }, [fallbackOrigin, workArea]);
  const focusDivider = useCallback((id: string, control: HTMLElement) => {
    const split = [...(workArea?.querySelectorAll<HTMLElement>("[data-split-id]") ?? [])].find(element => element.dataset["splitId"] === id);
    const divider = split?.querySelector<HTMLElement>(":scope > .th-divider");
    if (!divider) return;
    origin.current = control;
    explicitOrigin.current = true;
    divider.focus();
  }, [workArea]);
  const dividerBlurred = useCallback((id: string) => setFocusedId(current => current === id ? null : current), []);
  const dragEnded = useCallback((id: string) => setDraggingId(current => current === id ? null : current), []);
  const restoreFocus = useCallback(() => {
    (origin.current?.isConnected ? origin.current : fallbackOrigin())?.focus();
  }, [fallbackOrigin]);
  return (
    <ResizeContext.Provider value={{ workArea, active: focusedId !== null || draggingId !== null, draggingId,
      focusDivider, dividerFocused, dividerBlurred, dragStarted: setDraggingId, dragEnded, restoreFocus }}>
      <div className="th-session-workarea" ref={setWorkArea}>{children}</div>
    </ResizeContext.Provider>
  );
}

/** Header-first access; nested panes can choose any of their ancestor dividers. */
export function PaneResizeControl({ boundaries }: { readonly boundaries: readonly Boundary[] }) {
  const { t } = useT();
  const { focusDivider } = usePaneResize();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (open) menu.current?.querySelector<HTMLElement>("button")?.focus(); }, [open]);
  if (boundaries.length === 0) return null;
  const resize = (id: string) => {
    setOpen(false);
    if (trigger.current) focusDivider(id, trigger.current);
  };
  return (
    <div className="th-pane-resize-actions" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button type="button" ref={trigger} className="th-btn-icon th-pane-resize" aria-label={t("split.resize")}
        title={t("split.resize")} aria-haspopup={boundaries.length > 1 ? "menu" : undefined}
        aria-expanded={boundaries.length > 1 ? open : undefined}
        onClick={() => boundaries.length === 1 && boundaries[0] ? resize(boundaries[0].id) : setOpen(value => !value)}>
        <IconSplitH size={14} />
      </button>
      {open && <div className="th-pane-resize-menu" ref={menu} role="menu" aria-label={t("split.resize")}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const index = items.findIndex(item => item === document.activeElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        {boundaries.map((boundary, index) => <button type="button" role="menuitem" key={boundary.id}
          data-split-target={boundary.id} onClick={() => resize(boundary.id)}>
          {t(boundary.dir === "h" ? "split.resizeWidth" : "split.resizeHeight", { n: index + 1 })}
        </button>)}
      </div>}
    </div>
  );
}

export function PaneSizeOverlay({ pane }: { readonly pane: HTMLElement | null }) {
  const { t } = useT();
  const { workArea, active } = usePaneResize();
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!active || !pane || !workArea) return;
    const measure = () => {
      const area = workArea.getBoundingClientRect(), leaf = pane.getBoundingClientRect();
      const width = area.width > 0 ? Math.round(leaf.width / area.width * 100) : 0;
      const height = area.height > 0 ? Math.round(leaf.height / area.height * 100) : 0;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workArea); observer.observe(pane); measure();
    return () => observer.disconnect();
  }, [active, pane, workArea]);
  return active ? <div className="th-pane-size" aria-hidden="true" data-width-percent={size.width} data-height-percent={size.height}>
    {t("split.size", size)}
  </div> : null;
}
