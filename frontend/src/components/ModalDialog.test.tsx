import { StrictMode, act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ModalDialog } from "./ModalDialog";

interface PairProps {
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;
  readonly onLowerClose?: () => void;
  readonly onUpperClose?: () => void;
}

function DialogPair({ lowerOpen, upperOpen, onLowerClose = () => undefined, onUpperClose = () => undefined }: PairProps) {
  return (
    <>
      <button type="button" data-opener>Open dialogs</button>
      <ModalDialog
        open={lowerOpen}
        onClose={onLowerClose}
        labelledBy="lower-title"
        closeLabel="Close lower"
        initialFocusSelector="[data-lower-first]"
      >
        <h2 id="lower-title">Lower</h2>
        <button type="button" data-lower-first>Lower first</button>
        <button type="button" data-lower-last>Lower last</button>
      </ModalDialog>
      <ModalDialog
        open={upperOpen}
        onClose={onUpperClose}
        labelledBy="upper-title"
        closeLabel="Close upper"
        initialFocusSelector="[data-upper-first]"
      >
        <h2 id="upper-title">Upper</h2>
        <button type="button" data-upper-first>Upper first</button>
        <button type="button" data-upper-last>Upper last</button>
      </ModalDialog>
    </>
  );
}

describe("ModalDialog stack", () => {
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
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("closes simultaneous dialogs one at a time with Escape and restores the opener after the last", () => {
    const lowerClose = vi.fn();
    const upperClose = vi.fn();

    function Harness() {
      const [lowerOpen, setLowerOpen] = useState(false);
      const [upperOpen, setUpperOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            data-opener
            onClick={() => {
              setLowerOpen(true);
              setUpperOpen(true);
            }}
          >
            Open dialogs
          </button>
          <ModalDialog
            open={lowerOpen}
            onClose={() => {
              lowerClose();
              setLowerOpen(false);
            }}
            labelledBy="lower-title"
            initialFocusSelector="[data-lower-first]"
          >
            <h2 id="lower-title">Lower</h2>
            <button type="button" data-lower-first>Lower action</button>
          </ModalDialog>
          <ModalDialog
            open={upperOpen}
            onClose={() => {
              upperClose();
              setUpperOpen(false);
            }}
            labelledBy="upper-title"
            initialFocusSelector="[data-upper-first]"
          >
            <h2 id="upper-title">Upper</h2>
            <button type="button" data-upper-first>Upper action</button>
          </ModalDialog>
        </>
      );
    }

    document.body.style.overflow = "clip";
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
    const opener = container.querySelector<HTMLButtonElement>("[data-opener]");
    opener?.focus();
    act(() => opener?.click());

    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(document.activeElement).toBe(document.querySelector("[data-upper-first]"));
    expect(document.body.style.overflow).toBe("hidden");

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(upperClose).toHaveBeenCalledOnce();
    expect(lowerClose).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(document.querySelector("[data-lower-first]"));
    expect(document.body.style.overflow).toBe("hidden");

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(lowerClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("clip");
  });

  it("isolates Tab and backdrop handling to the top dialog", () => {
    const lowerClose = vi.fn();
    const upperClose = vi.fn();
    act(() => root.render(
      <StrictMode>
        <DialogPair lowerOpen upperOpen onLowerClose={lowerClose} onUpperClose={upperClose} />
      </StrictMode>,
    ));

    const lowerPanel = document.querySelector<HTMLElement>('[aria-labelledby="lower-title"]');
    const upperPanel = document.querySelector<HTMLElement>('[aria-labelledby="upper-title"]');
    const upperLast = document.querySelector<HTMLButtonElement>("[data-upper-last]");
    const upperCloseButton = upperPanel?.querySelector<HTMLButtonElement>(".th-modal-close");
    if (!lowerPanel || !upperPanel || !upperLast || !upperCloseButton) throw new Error("missing modal controls");

    const lowerFocus = vi.fn();
    lowerPanel.addEventListener("focusin", lowerFocus);

    upperLast.focus();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(upperCloseButton);

    upperCloseButton.focus();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(upperLast);
    expect(lowerFocus).not.toHaveBeenCalled();

    const lowerBackdrop = lowerPanel.parentElement?.querySelector<HTMLButtonElement>(".th-modal-backdrop");
    const upperBackdrop = upperPanel.parentElement?.querySelector<HTMLButtonElement>(".th-modal-backdrop");
    act(() => lowerBackdrop?.click());
    expect(lowerClose).not.toHaveBeenCalled();
    expect(upperClose).not.toHaveBeenCalled();

    act(() => upperBackdrop?.click());
    expect(upperClose).toHaveBeenCalledOnce();
  });

  it("exposes only the top dialog to assistive tech and reacts when the top changes", () => {
    act(() => root.render(<StrictMode><DialogPair lowerOpen upperOpen /></StrictMode>));

    const lowerPanel = document.querySelector<HTMLElement>('[aria-labelledby="lower-title"]');
    const upperPanel = document.querySelector<HTMLElement>('[aria-labelledby="upper-title"]');
    const lowerOverlay = lowerPanel?.parentElement;
    const upperOverlay = upperPanel?.parentElement;
    if (!lowerPanel || !upperPanel || !lowerOverlay || !upperOverlay) throw new Error("missing modal panels");

    // Only the top dialog is modal/exposed; the lower one is inert + hidden.
    expect(upperPanel.getAttribute("aria-modal")).toBe("true");
    expect(lowerPanel.hasAttribute("aria-modal")).toBe(false);
    expect(lowerOverlay.hasAttribute("inert")).toBe(true);
    expect(lowerOverlay.getAttribute("aria-hidden")).toBe("true");
    expect(upperOverlay.hasAttribute("inert")).toBe(false);
    expect(upperOverlay.hasAttribute("aria-hidden")).toBe(false);

    // Closing the top promotes the lower dialog reactively.
    act(() => root.render(<StrictMode><DialogPair lowerOpen upperOpen={false} /></StrictMode>));
    const promoted = document.querySelector<HTMLElement>('[aria-labelledby="lower-title"]');
    const promotedOverlay = promoted?.parentElement;
    if (!promoted || !promotedOverlay) throw new Error("missing promoted panel");
    expect(promoted.getAttribute("aria-modal")).toBe("true");
    expect(promotedOverlay.hasAttribute("inert")).toBe(false);
    expect(promotedOverlay.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps focus and the body lock when a lower dialog closes out of order", () => {
    document.body.style.overflow = "scroll";
    act(() => root.render(<StrictMode><DialogPair lowerOpen={false} upperOpen={false} /></StrictMode>));
    const opener = container.querySelector<HTMLButtonElement>("[data-opener]");
    opener?.focus();

    act(() => root.render(<StrictMode><DialogPair lowerOpen upperOpen /></StrictMode>));
    const upperFirst = document.querySelector<HTMLButtonElement>("[data-upper-first]");
    expect(document.activeElement).toBe(upperFirst);
    expect(document.body.style.overflow).toBe("hidden");

    // Non-LIFO isolation: the top dialog is exposed, the lower one is inert.
    const upperPanel = document.querySelector<HTMLElement>('[aria-labelledby="upper-title"]');
    const lowerOverlay = document.querySelector<HTMLElement>('[aria-labelledby="lower-title"]')?.parentElement;
    expect(upperPanel?.getAttribute("aria-modal")).toBe("true");
    expect(upperPanel?.parentElement?.hasAttribute("inert")).toBe(false);
    expect(lowerOverlay?.hasAttribute("inert")).toBe(true);

    act(() => root.render(<StrictMode><DialogPair lowerOpen={false} upperOpen /></StrictMode>));
    expect(document.querySelector('[aria-labelledby="lower-title"]')).toBeNull();
    expect(document.activeElement).toBe(upperFirst);
    expect(document.body.style.overflow).toBe("hidden");

    // The surviving top dialog stays exposed and focusable after the lower
    // dialog unmounts out of order.
    const surviving = document.querySelector<HTMLElement>('[aria-labelledby="upper-title"]');
    expect(surviving?.getAttribute("aria-modal")).toBe("true");
    expect(surviving?.parentElement?.hasAttribute("inert")).toBe(false);

    act(() => root.render(<StrictMode><DialogPair lowerOpen={false} upperOpen={false} /></StrictMode>));
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("scroll");
  });
});
