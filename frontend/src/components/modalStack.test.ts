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
  const mounted: HTMLElement[] = [];

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
    for (const element of mounted.splice(0)) element.remove();
    opener.remove();
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mountFocusedComposer = (): HTMLTextAreaElement => {
    const pane = document.createElement("section");
    pane.className = "th-pane th-chat-pane th-pane--focused";
    const field = document.createElement("div");
    field.className = "th-chat-input";
    const textarea = document.createElement("textarea");
    field.appendChild(textarea);
    pane.appendChild(field);
    document.body.appendChild(pane);
    mounted.push(pane);
    return textarea;
  };

  const resetOpener = (): void => {
    opener.hidden = false;
    opener.style.display = "";
    opener.style.visibility = "";
    opener.disabled = false;
    document.body.appendChild(opener);
    opener.focus();
  };

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

  it("returns focus to the visible trigger when the modal closes", () => {
    const composer = mountFocusedComposer();
    const modal = track("visible");
    stack.push(modal.entry);
    stack.remove(modal.token);
    expect(document.activeElement).toBe(opener);
    expect(document.activeElement).not.toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("focuses the fallback, never body, when the trigger is removed or display:none", () => {
    const composer = mountFocusedComposer();
    const hides: Array<[string, () => void]> = [
      ["removed", () => opener.remove()],
      ["display:none", () => {
        opener.style.display = "none";
      }],
      ["display:none ancestor", () => {
        const actions = document.createElement("span");
        actions.className = "th-tree-actions";
        actions.style.display = "none";
        document.body.appendChild(actions);
        actions.appendChild(opener);
        mounted.push(actions);
      }],
    ];
    const misses: string[] = [];
    for (const [label, hide] of hides) {
      resetOpener();
      const modal = track(label);
      stack.push(modal.entry);
      hide();
      stack.remove(modal.token);
      const active = document.activeElement;
      if (active === document.body) misses.push(`${label}: focus is body`);
      else if (active !== composer) {
        const where = active instanceof Element ? active.tagName.toLowerCase() : "null";
        misses.push(`${label}: focus is <${where}> not composer`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("keeps nested modal focus restoration unchanged", () => {
    const composer = mountFocusedComposer();
    const lower = track("lower-nested");
    const upper = track("upper-nested");
    stack.push(lower.entry);
    stack.push(upper.entry);
    expect(document.activeElement).toBe(upper.initial);

    stack.remove(upper.token);
    expect(document.activeElement).toBe(lower.initial);
    expect(document.activeElement).not.toBe(composer);
    expect(document.body.style.overflow).toBe("hidden");

    stack.remove(lower.token);
    expect(document.activeElement).toBe(opener);
    expect(document.activeElement).not.toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("waits until the stack is empty before using a fallback for a hidden root trigger", () => {
    const composer = mountFocusedComposer();
    const lower = track("lower-hidden");
    const upper = track("upper-hidden");
    stack.push(lower.entry);
    stack.push(upper.entry);
    opener.style.display = "none";

    stack.remove(upper.token);
    expect(document.activeElement).toBe(lower.initial);
    expect(document.activeElement).not.toBe(composer);
    expect(document.body.style.overflow).toBe("hidden");

    stack.remove(lower.token);
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("skips an inert, disabled, or visibility-hidden trigger and focuses the composer", () => {
    const composer = mountFocusedComposer();
    const main = document.createElement("main");
    main.className = "th-main";
    document.body.appendChild(main);
    mounted.push(main);

    const inert = track("inert");
    stack.push(inert.entry);
    const drawer = document.createElement("aside");
    drawer.setAttribute("inert", "");
    document.body.appendChild(drawer);
    drawer.appendChild(opener);
    mounted.push(drawer);
    stack.remove(inert.token);
    expect(document.activeElement).toBe(composer);
    expect(main.hasAttribute("tabindex")).toBe(false);

    resetOpener();
    const disabled = track("disabled");
    stack.push(disabled.entry);
    opener.disabled = true;
    stack.remove(disabled.token);
    expect(document.activeElement).toBe(composer);

    resetOpener();
    const concealed = track("visibility");
    stack.push(concealed.entry);
    opener.style.visibility = "hidden";
    stack.remove(concealed.token);
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("prefers the root modal's designated fallback over the composer", () => {
    const composer = mountFocusedComposer();
    const designated = document.createElement("button");
    designated.type = "button";
    designated.textContent = "designated";
    const nestedChoice = document.createElement("button");
    nestedChoice.type = "button";
    nestedChoice.textContent = "nested";
    document.body.append(designated, nestedChoice);
    mounted.push(designated, nestedChoice);

    const lower = track("root-fallback");
    const upper = track("nested-fallback");
    stack.push({ ...lower.entry, getRestoreFallback: () => designated });
    stack.push({ ...upper.entry, getRestoreFallback: () => nestedChoice });
    opener.remove();

    stack.remove(upper.token);
    expect(document.activeElement).toBe(lower.initial);

    stack.remove(lower.token);
    expect(document.activeElement).toBe(designated);
    expect(document.activeElement).not.toBe(nestedChoice);
    expect(document.activeElement).not.toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("skips a hidden designated fallback and then a disabled composer for main", () => {
    const composer = mountFocusedComposer();
    composer.disabled = true;
    const designated = document.createElement("button");
    designated.type = "button";
    designated.style.display = "none";
    const main = document.createElement("main");
    main.className = "th-main";
    document.body.append(designated, main);
    mounted.push(designated, main);

    const modal = track("main-fallback");
    stack.push({ ...modal.entry, getRestoreFallback: () => designated });
    opener.remove();
    stack.remove(modal.token);

    expect(main.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(main);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(composer);
    expect(document.activeElement).not.toBe(designated);
  });

  it("keeps the recorded row action focusable while the dialog covers its hover state", () => {
    const composer = mountFocusedComposer();
    const style = document.createElement("style");
    style.textContent = ".th-tree-actions { display: none } .th-tree-actions[data-th-restore-focus], .th-tree-actions:focus-within { display: inline-flex }";
    document.head.appendChild(style);
    mounted.push(style);
    const actions = document.createElement("span");
    actions.className = "th-tree-actions";
    actions.style.display = "inline-flex";
    document.body.appendChild(actions);
    actions.appendChild(opener);
    mounted.push(actions);
    opener.focus();
    const modal = track("hover-occlusion");

    stack.push(modal.entry);
    actions.style.display = "";
    expect(getComputedStyle(actions).display).toBe("inline-flex");
    stack.remove(modal.token);
    expect(document.activeElement).toBe(opener);
    expect(document.activeElement).not.toBe(composer);
    expect(actions.hasAttribute("data-th-restore-focus")).toBe(false);
  });

  it("returns focus to the composer when the pointer leaves a hidden drawer row", () => {
    const composer = mountFocusedComposer();
    const row = document.createElement("div");
    row.className = "th-tree-node";
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 30, 180, 30));
    const actions = document.createElement("span");
    actions.className = "th-tree-actions";
    row.appendChild(actions);
    actions.appendChild(opener);
    document.body.appendChild(row);
    mounted.push(row);
    opener.focus();
    const modal = track("drawer");

    stack.push(modal.entry);
    expect(actions.hasAttribute("data-th-restore-focus")).toBe(true);
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 12 }));
    expect(actions.hasAttribute("data-th-restore-focus")).toBe(false);

    actions.style.display = "none";
    stack.remove(modal.token);
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });
});
