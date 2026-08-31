import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconX } from "./icons";
import { MODAL_FOCUSABLE, modalStack } from "./modalStack";
import type { ModalStackEntry } from "./modalStack";

export interface ModalDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy?: string;
  readonly closeLabel?: string;
  readonly initialFocusSelector?: string;
  readonly children: ReactNode;
}

export function ModalDialog({ open, onClose, labelledBy, closeLabel = "Close", initialFocusSelector, children }: ModalDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const selectorRef = useRef(initialFocusSelector);
  selectorRef.current = initialFocusSelector;
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol("modal-dialog");
  const token = tokenRef.current;
  // Reactive top-state: only the top dialog advertises aria-modal. Lower
  // dialogs are made inert + aria-hidden imperatively by the stack.
  const isTop = useSyncExternalStore(modalStack.subscribe, () => modalStack.isTop(token));

  useEffect(() => {
    if (!open) return;
    const entry: ModalStackEntry = {
      token,
      getPanel: () => panelRef.current,
      getOverlay: () => overlayRef.current,
      getOnClose: () => onCloseRef.current,
      focusInitial: () => {
        const panel = panelRef.current;
        if (!panel) return;
        const selector = selectorRef.current;
        const initial = selector ? panel.querySelector<HTMLElement>(selector) : null;
        const target = initial ?? panel.querySelector<HTMLElement>(MODAL_FOCUSABLE) ?? panel;
        target.focus();
      },
    };
    modalStack.push(entry);
    return () => modalStack.remove(token);
  }, [open, token]);

  if (!open) return null;

  return createPortal(
    <div ref={overlayRef} className="th-modal-overlay">
      <button
        type="button"
        className="th-modal-backdrop"
        tabIndex={-1}
        aria-label={closeLabel}
        onClick={() => {
          if (modalStack.isTop(token)) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="th-modal"
        role="dialog"
        aria-modal={isTop ? "true" : undefined}
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        <button type="button" className="th-modal-close" onClick={onClose} aria-label={closeLabel}>
          <IconX size={15} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
