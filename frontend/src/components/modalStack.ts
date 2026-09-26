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
  /**
   * Focus target chosen by the code that opened the root modal. Used only
   * when the recorded trigger can no longer take focus. Nested modals do
   * not replace the root modal's choice.
   */
  readonly getRestoreFallback?: () => HTMLElement | null;
}

export interface ModalStack {
  push(entry: ModalStackEntry): void;
  remove(token: symbol): void;
  isTop(token: symbol): boolean;
  size(): number;
  subscribe(listener: () => void): () => void;
}

const FOCUSED_PANE_COMPOSER = ".th-pane--focused .th-chat-input textarea";
const MAIN_CONTENT_REGION = "main.th-main";

function isHiddenFromFocus(element: HTMLElement): boolean {
  const visibility = getComputedStyle(element).visibility;
  if (visibility === "hidden" || visibility === "collapse") return true;
  let node: Element | null = element;
  while (node !== null) {
    if (node instanceof HTMLElement && node.hidden) return true;
    if (getComputedStyle(node).display === "none") return true;
    node = node.parentElement;
  }
  return false;
}

function canTakeFocus(element: HTMLElement | null): element is HTMLElement {
  if (element === null || !element.isConnected) return false;
  if (element.matches(":disabled") || element.closest("[inert]") !== null) return false;
  return !isHiddenFromFocus(element);
}

function focusIfRestorable(element: HTMLElement | null): boolean {
  if (!canTakeFocus(element)) return false;
  element.focus();
  return document.activeElement === element;
}

function focusMainContent(): boolean {
  const main = document.querySelector<HTMLElement>(MAIN_CONTENT_REGION);
  if (main === null) return false;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  return focusIfRestorable(main);
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
  let restoreFallback: (() => HTMLElement | null) | null = null;
  let restoreActions: HTMLElement | null = null;
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

  const onPointerMove = (ev: PointerEvent): void => {
    const row = restoreActions?.closest(".th-tree-node");
    if (!row) return;
    const bounds = row.getBoundingClientRect();
    restoreActions?.toggleAttribute(
      "data-th-restore-focus",
      ev.clientX >= bounds.left && ev.clientX <= bounds.right &&
        ev.clientY >= bounds.top && ev.clientY <= bounds.bottom,
    );
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

  // The trigger is often gone by close: a hover-only row action is
  // display:none once focus leaves it, and the mobile drawer is inert.
  // Restore that trigger only when focus actually lands on it. Otherwise
  // use the opener's fallback, the focused pane composer, then main.
  function restoreRootFocus(): void {
    const target = rootRestoreTarget;
    const designated = restoreFallback;
    rootRestoreTarget = null;
    restoreFallback = null;
    if (focusIfRestorable(target)) return;
    if (focusIfRestorable(designated?.() ?? null)) return;
    const composer = document.querySelector<HTMLTextAreaElement>(FOCUSED_PANE_COMPOSER);
    if (focusIfRestorable(composer)) return;
    focusMainContent();
  }

  function push(entry: ModalStackEntry): void {
    if (entries.some((existing) => existing.token === entry.token)) return;
    if (entries.length === 0) {
      savedOverflow = document.body.style.overflow;
      rootRestoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      restoreFallback = entry.getRestoreFallback ?? null;
      restoreActions = rootRestoreTarget?.closest<HTMLElement>(".th-tree-actions") ?? null;
      restoreActions?.setAttribute("data-th-restore-focus", "");
      if (restoreActions) document.addEventListener("pointermove", onPointerMove, true);
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
      restoreRootFocus();
      restoreActions?.removeAttribute("data-th-restore-focus");
      if (restoreActions) document.removeEventListener("pointermove", onPointerMove, true);
      restoreActions = null;
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
