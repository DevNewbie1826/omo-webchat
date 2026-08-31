import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModalStack } from "./modalStack";
import type { ModalStack, ModalStackEntry } from "./modalStack";

interface FakeModal {
  entry: ModalStackEntry;
  token: symbol;
  panel: HTMLElement;
  initial: HTMLButtonElement;
  onClose: ReturnType<typeof vi.fn>;
  focusInitial: ReturnType<typeof vi.fn>;
}

function makeModal(name: string): FakeModal {
  const panel = document.createElement("div");
  panel.setAttribute("data-panel", name);
  panel.tabIndex = -1;
  const initial = document.createElement("button");
  initial.setAttribute("type", "button");
  initial.textContent = `${name}-initial`;
  panel.appendChild(initial);
  document.body.appendChild(panel);

  const onClose = vi.fn();
  const focusInitial = vi.fn(() => initial.focus());
  const token = Symbol(name);
  const entry: ModalStackEntry = {
    token,
    getPanel: () => panel,
    getOnClose: () => onClose,
    focusInitial,
  };
  return { entry, token, panel, initial, onClose, focusInitial };
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

describe("modalStack", () => {
  let stack: ModalStack;
  let opener: HTMLButtonElement;
  const modals: FakeModal[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stack = createModalStack();
    opener = document.createElement("button");
    opener.setAttribute("type", "button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();
  });

  afterEach(() => {
    for (const modal of modals.splice(0)) modal.panel.remove();
    opener.remove();
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const track = (name: string): FakeModal => {
    const modal = makeModal(name);
    modals.push(modal);
    return modal;
  };

  it("locks body on first push and restores the original overflow after the last remove", () => {
    document.body.style.overflow = "clip";
    const lower = track("lower");
    const upper = track("upper");

    stack.push(lower.entry);
    expect(document.body.style.overflow).toBe("hidden");

    stack.push(upper.entry);
    expect(document.body.style.overflow).toBe("hidden");

    stack.remove(upper.token);
    expect(document.body.style.overflow).toBe("hidden");

    stack.remove(lower.token);
    expect(document.body.style.overflow).toBe("clip");
    expect(stack.size()).toBe(0);
  });

  it("routes Escape to the top entry only, one close per press", () => {
    const lower = track("lower");
    const upper = track("upper");
    stack.push(lower.entry);
    stack.push(upper.entry);

    pressEscape();
    expect(upper.onClose).toHaveBeenCalledOnce();
    expect(lower.onClose).not.toHaveBeenCalled();

    pressEscape();
    expect(upper.onClose).toHaveBeenCalledTimes(2);
    expect(lower.onClose).not.toHaveBeenCalled();

    stack.remove(upper.token);
    pressEscape();
    expect(lower.onClose).toHaveBeenCalledOnce();
  });

  it("ignores Escape entirely when the stack is empty", () => {
    pressEscape();
    expect(stack.size()).toBe(0);
    expect(document.body.style.overflow).toBe("");
  });

  it("reports the top via isTop and keeps it when a lower entry is removed", () => {
    const lower = track("lower");
    const upper = track("upper");
    stack.push(lower.entry);
    stack.push(upper.entry);

    expect(stack.isTop(upper.token)).toBe(true);
    expect(stack.isTop(lower.token)).toBe(false);

    stack.remove(lower.token);
    expect(stack.isTop(upper.token)).toBe(true);
    expect(stack.size()).toBe(1);
  });

  it("does not steal focus or unlock body when a lower entry unmounts out of order", () => {
    document.body.style.overflow = "scroll";
    const lower = track("lower");
    const upper = track("upper");
    stack.push(lower.entry);
    stack.push(upper.entry);
    expect(document.activeElement).toBe(upper.initial);

    stack.remove(lower.token);
    expect(document.activeElement).toBe(upper.initial);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("returns focus to the new top on a top close and to the opener after the last close", () => {
    const lower = track("lower");
    const upper = track("upper");
    stack.push(lower.entry);
    stack.push(upper.entry);
    expect(document.activeElement).toBe(upper.initial);

    stack.remove(upper.token);
    expect(document.activeElement).toBe(lower.initial);
    expect(document.body.style.overflow).toBe("hidden");

    stack.remove(lower.token);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("stays consistent under StrictMode-style setup/cleanup/setup", () => {
    document.body.style.overflow = "clip";
    const lower = track("lower");
    const upper = track("upper");

    stack.push(lower.entry);
    stack.push(upper.entry);
    stack.remove(lower.entry.token);
    stack.remove(upper.entry.token);
    stack.push(lower.entry);
    stack.push(upper.entry);

    expect(stack.size()).toBe(2);
    expect(stack.isTop(upper.token)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(upper.initial);

    stack.remove(upper.token);
    stack.remove(lower.token);
    expect(stack.size()).toBe(0);
    expect(document.body.style.overflow).toBe("clip");
    expect(document.activeElement).toBe(opener);
  });

  it("treats push as idempotent for an already-registered token", () => {
    const lower = track("lower");
    stack.push(lower.entry);
    stack.push(lower.entry);
    expect(stack.size()).toBe(1);
    stack.remove(lower.token);
    expect(stack.size()).toBe(0);
  });

  it("notifies subscribers on every push and remove until unsubscribed", () => {
    const lower = track("lower");
    const upper = track("upper");
    const listener = vi.fn();
    const unsubscribe = stack.subscribe(listener);

    stack.push(lower.entry);
    expect(listener).toHaveBeenCalledTimes(1);
    stack.push(upper.entry);
    expect(listener).toHaveBeenCalledTimes(2);
    stack.remove(upper.token);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    stack.remove(lower.token);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("makes every non-top overlay inert and clears it before refocusing the new top", () => {
    const makeOverlaid = (name: string) => {
      const overlay = document.createElement("div");
      const panel = document.createElement("div");
      panel.tabIndex = -1;
      const initial = document.createElement("button");
      initial.setAttribute("type", "button");
      panel.appendChild(initial);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      modals.push({ panel: overlay } as unknown as FakeModal);
      const token = Symbol(name);
      const entry: ModalStackEntry = {
        token,
        getPanel: () => panel,
        getOverlay: () => overlay,
        getOnClose: () => () => undefined,
        focusInitial: () => initial.focus(),
      };
      return { entry, token, overlay, initial };
    };

    const lower = makeOverlaid("lower");
    const upper = makeOverlaid("upper");
    stack.push(lower.entry);
    stack.push(upper.entry);

    expect(lower.overlay.hasAttribute("inert")).toBe(true);
    expect(lower.overlay.getAttribute("aria-hidden")).toBe("true");
    expect(upper.overlay.hasAttribute("inert")).toBe(false);

    stack.remove(upper.token);
    // Isolation is cleared before focus so the promoted top is focusable.
    expect(lower.overlay.hasAttribute("inert")).toBe(false);
    expect(lower.overlay.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(lower.initial);
  });
});
