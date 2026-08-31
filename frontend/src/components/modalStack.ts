export const MODAL_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalStackEntry {
  readonly token: symbol;
  readonly getPanel: () => HTMLElement | null;
  /**
   * The overlay wrapping the panel. Every non-top entry's overlay is made
   * inert and aria-hidden so only the top dialog is exposed and focusable.
   * Optional so headless unit fakes (panel appended to body) stay valid.
   */
  readonly getOverlay?: () => HTMLElement | null;
  readonly getOnClose: () => () => void;
  readonly focusInitial: () => void;
}

export interface ModalStack {
  push(entry: ModalStackEntry): void;
  remove(token: symbol): void;
  isTop(token: symbol): boolean;
  size(): number;
  subscribe(listener: () => void): () => void;
}

function trapFocus(panel: HTMLElement, ev: KeyboardEvent): void {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE));
  if (items.length === 0) {
    ev.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey) {
    if (active === first || !panel.contains(active)) {
      ev.preventDefault();
      last?.focus();
    }
  } else if (active === last || !panel.contains(active)) {
    ev.preventDefault();
    first?.focus();
  }
}

export function createModalStack(): ModalStack {
  const entries: ModalStackEntry[] = [];
  const listeners = new Set<() => void>();
  let savedOverflow: string | null = null;
  let rootRestoreTarget: HTMLElement | null = null;
  let listening = false;

  const top = (): ModalStackEntry | undefined => entries[entries.length - 1];

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  // Expose only the top dialog to assistive tech and the tab order: every
  // lower overlay is inert + aria-hidden. Runs before focus restoration so the
  // new top is focusable in a real browser the moment focusInitial() fires.
  const applyIsolation = (): void => {
    for (let index = 0; index < entries.length; index += 1) {
      const overlay = entries[index]?.getOverlay?.();
      if (!overlay) continue;
      if (index === entries.length - 1) {
        overlay.removeAttribute("inert");
        overlay.removeAttribute("aria-hidden");
      } else {
        overlay.setAttribute("inert", "");
        overlay.setAttribute("aria-hidden", "true");
      }
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    const current = top();
    if (!current) return;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      current.getOnClose()();
      return;
    }
    if (ev.key === "Tab") {
      const panel = current.getPanel();
      if (panel) trapFocus(panel, ev);
    }
  };

  const attach = (): void => {
    if (listening) return;
    listening = true;
    document.addEventListener("keydown", onKeyDown, true);
  };

  const detach = (): void => {
    if (!listening) return;
    listening = false;
    document.removeEventListener("keydown", onKeyDown, true);
  };

  function push(entry: ModalStackEntry): void {
    if (entries.some((existing) => existing.token === entry.token)) return;
    if (entries.length === 0) {
      savedOverflow = document.body.style.overflow;
      rootRestoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    entries.push(entry);
    document.body.style.overflow = "hidden";
    attach();
    applyIsolation();
    entry.focusInitial();
    notify();
  }

  function remove(token: symbol): void {
    const index = entries.findIndex((entry) => entry.token === token);
    if (index === -1) return;
    const wasTop = index === entries.length - 1;
    entries.splice(index, 1);
    applyIsolation();
    if (entries.length === 0) {
      document.body.style.overflow = savedOverflow ?? "";
      savedOverflow = null;
      detach();
      rootRestoreTarget?.focus();
      rootRestoreTarget = null;
      notify();
      return;
    }
    if (wasTop) top()?.focusInitial();
    notify();
  }

  function isTop(token: symbol): boolean {
    return top()?.token === token;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { push, remove, isTop, size: () => entries.length, subscribe };
}

export const modalStack = createModalStack();
