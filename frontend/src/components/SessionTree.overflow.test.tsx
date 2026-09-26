import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTree } from "./SessionTree";
import type { Workspace } from "../features/workspace/workspace";
import { NewChatDialog } from "./NewChatDialog";
import { useConfirm } from "./ConfirmDialog";
import { useT } from "../i18n";

const workspaceOne: Workspace = {
  id: "ws-1",
  name: "One",
  path: "/one",
  chats: [{ id: "tm-alpha", name: "Alpha", provider: "omo" }],
};

const workspaceTwo: Workspace = {
  id: "ws-2",
  name: "Two",
  path: "/two",
  chats: [{ id: "tm-beta", name: "Beta", provider: "omo" }],
};

const sessionsOne = [{ id: "tm-alpha", name: "Alpha", source: "stored" as const, recencyMs: 1 }];
const sessionsTwo = [{ id: "tm-beta", name: "Beta", source: "stored" as const, recencyMs: 1 }];

// PR #202 review r2 required change 1: the workspace More actions popup is a
// disclosure, not a menu. jsdom performs no native button key activation, so
// `activate` dispatches the Enter/Space key sequence and then the click a
// browser synthesizes from it; the component's own contract is the click.
const pressKey = (element: Element, key: string): void => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
};

const activate = (element: Element, key: "Enter" | " " = "Enter"): void => {
  pressKey(element, key);
  if (element instanceof HTMLButtonElement) element.click();
};

describe("SessionTree workspace overflow disclosure", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onAddTerminal: ReturnType<typeof vi.fn<(ws: Workspace) => void>>;
  let onDeleteWorkspace: ReturnType<typeof vi.fn<(ws: Workspace) => void>>;
  let onRenameWorkspace: ReturnType<typeof vi.fn<(ws: Workspace, name: string) => Promise<void>>>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onAddTerminal = vi.fn();
    onDeleteWorkspace = vi.fn();
    onRenameWorkspace = vi.fn(async () => undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    function OverflowHarness() {
      const { t } = useT();
      const [chatOpen, setChatOpen] = useState(false);
      const { confirm, dialog } = useConfirm(t);
      return (
        <>
          <aside className="th-sidebar">
            <SessionTree
              workspaces={[workspaceOne, workspaceTwo]}
              touchActions
              activeTerminalId={null}
              placedSessions={new Set()}
              liveSessions={new Set()}
              expanded={new Set(["ws-1", "ws-2"])}
              sessionLists={
                new Map([
                  ["ws-1", sessionsOne],
                  ["ws-2", sessionsTwo],
                ])
              }
              sessionPages={new Map()}
              onToggle={() => undefined}
              onLoadMoreSessions={() => undefined}
              onSelect={() => undefined}
              onOpen={async () => undefined}
              onAddTerminal={(ws) => {
                onAddTerminal(ws);
                setChatOpen(true);
              }}
              onDeleteWorkspace={(ws) => {
                onDeleteWorkspace(ws);
                void confirm({
                  title: t("sidebar.ws.delete"),
                  message: t("sidebar.confirmDeleteWs", { name: ws.name }),
                  danger: true,
                });
              }}
              onDeleteTerminal={() => undefined}
              onRenameWorkspace={onRenameWorkspace}
              onRenameTerminal={async () => undefined}
              notify={() => undefined}
            />
          </aside>
          <main className="th-main">
            <section className="th-pane--focused"><div className="th-chat-input"><textarea /></div></section>
          </main>
          <NewChatDialog
            open={chatOpen}
            providerDiscovery={{ status: "loading" }}
            onRetryProviders={() => undefined}
            onClose={() => setChatOpen(false)}
          />
          {dialog}
        </>
      );
    }
    act(() => {
      root.render(<OverflowHarness />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const triggerOf = (wsId: string): HTMLButtonElement => {
    const trigger = container.querySelector<HTMLButtonElement>(`button[aria-controls="th-tree-overflow-${wsId}"]`);
    expect(trigger, `trigger for ${wsId}`).not.toBeNull();
    return trigger!;
  };
  const popups = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(".th-tree-overflow"));
  const popupOf = (wsId: string): HTMLElement | null => container.querySelector<HTMLElement>(`#th-tree-overflow-${wsId}`);
  const actionButtons = (popup: HTMLElement): HTMLButtonElement[] =>
    Array.from(popup.querySelectorAll<HTMLButtonElement>("button"));

  it("exposes the trigger as a disclosure: expanded + controls, no menu semantics", () => {
    const trigger = triggerOf("ws-1");
    expect(trigger.hasAttribute("aria-haspopup")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe("th-tree-overflow-ws-1");
    expect(popups()).toHaveLength(0);
  });

  it.each(["Enter", " "] as const)("opens from the trigger on %s and labels the disclosed group", (key) => {
    const trigger = triggerOf("ws-1");
    act(() => {
      trigger.focus();
      activate(trigger, key);
    });

    expect(popups(), `popup after ${key === " " ? "Space" : key}`).toHaveLength(1);
    const popup = popupOf("ws-1");
    expect(popup, "popup wired via aria-controls").not.toBeNull();
    expect(popup!.getAttribute("role")).toBe("group");
    expect(popup!.getAttribute("aria-label")).toBe("sidebar.ws.moreActions");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    act(() => pressKey(trigger, "Escape"));
    expect(popups()).toHaveLength(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the three actions in natural Tab order after the trigger", () => {
    act(() => triggerOf("ws-1").click());
    const popup = popupOf("ws-1")!;
    const buttons = actionButtons(popup);
    expect(buttons.map((button) => button.textContent)).toEqual([
      "sidebar.ws.rename",
      "sidebar.ws.addTerminal",
      "sidebar.ws.delete",
    ]);

    // DOM order is Tab order: trigger, then the three actions, then the next
    // workspace's controls. jsdom has no layout, so assert the order
    // directly instead of simulating Tab presses.
    const focusables = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const order = [
      triggerOf("ws-1"),
      ...buttons,
      triggerOf("ws-2"),
    ].map((element) => focusables.indexOf(element));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const button of buttons) {
      act(() => button.focus());
      expect(document.activeElement).toBe(button);
    }
  });

  it.each(["sidebar.ws.rename", "sidebar.ws.addTerminal", "sidebar.ws.delete"])(
    "Escape from %s closes and returns focus to that workspace's trigger, never body",
    (actionLabel) => {
      const trigger = triggerOf("ws-2");
      act(() => trigger.click());
      const popup = popupOf("ws-2")!;
      const action = actionButtons(popup).find((button) => button.textContent === actionLabel)!;
      act(() => action.focus());
      expect(document.activeElement).toBe(action);

      act(() => pressKey(action, "Escape"));

      expect(popups()).toHaveLength(0);
      expect(document.activeElement).toBe(trigger);
      expect(document.activeElement).not.toBe(document.body);
    },
  );

  it("closes on Escape from the trigger itself and keeps focus there", () => {
    const trigger = triggerOf("ws-1");
    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(popups()).toHaveLength(1);

    act(() => pressKey(trigger, "Escape"));

    expect(popups()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside press without stealing focus from the trigger", () => {
    const trigger = triggerOf("ws-1");
    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(popups()).toHaveLength(1);
    const outside = container.querySelector<HTMLElement>(".th-tree")!;

    act(() => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    });

    expect(popups()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps exactly one popup across rapid toggling and workspace switches", () => {
    const triggerOne = triggerOf("ws-1");
    const triggerTwo = triggerOf("ws-2");

    act(() => triggerOne.click());
    expect(popups()).toHaveLength(1);
    expect(popupOf("ws-1")).not.toBeNull();

    act(() => triggerOne.click());
    expect(popups()).toHaveLength(0);

    act(() => triggerOne.click());
    expect(popups()).toHaveLength(1);

    act(() => triggerTwo.click());
    expect(popups()).toHaveLength(1);
    expect(popupOf("ws-1")).toBeNull();
    expect(popupOf("ws-2")).not.toBeNull();

    act(() => triggerTwo.click());
    expect(popups()).toHaveLength(0);
  });

  it("starts the rename flow focused and commits through the existing input contract", () => {
    act(() => triggerOf("ws-1").click());
    const popup = popupOf("ws-1")!;
    const rename = actionButtons(popup).find((button) => button.textContent === "sidebar.ws.rename")!;

    act(() => rename.click());
    expect(popups()).toHaveLength(0);
    const input = container.querySelector<HTMLInputElement>(".th-tree-rename");
    expect(input, "rename input from the existing flow").not.toBeNull();
    expect(document.activeElement).toBe(input);

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Renamed one");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => pressKey(input!, "Enter"));
    expect(onRenameWorkspace).toHaveBeenCalledWith(workspaceOne, "Renamed one");
    expect(container.querySelector(".th-tree-rename")).toBeNull();
  });

  it("cancelling the rename flow keeps its existing dismissal behavior", () => {
    const trigger = triggerOf("ws-2");
    act(() => trigger.click());
    const popup = popupOf("ws-2")!;
    const rename = actionButtons(popup).find((button) => button.textContent === "sidebar.ws.rename")!;

    act(() => rename.click());
    const input = container.querySelector<HTMLInputElement>(".th-tree-rename");
    expect(input).not.toBeNull();
    expect(onRenameWorkspace).not.toHaveBeenCalled();

    act(() => pressKey(input!, "Escape"));
    expect(container.querySelector(".th-tree-rename")).toBeNull();
    expect(onRenameWorkspace).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("returns focus after an empty rename commit", () => {
    const trigger = triggerOf("ws-1");
    act(() => trigger.click());
    act(() => actionButtons(popupOf("ws-1")!)[0]?.click());
    const input = container.querySelector<HTMLInputElement>(".th-tree-rename")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => pressKey(input, "Enter"));
    expect(container.querySelector(".th-tree-rename")).toBeNull();
    expect(onRenameWorkspace).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses the composer fallback when the rename trigger becomes hidden", () => {
    act(() => triggerOf("ws-2").click());
    act(() => actionButtons(popupOf("ws-2")!)[0]?.click());
    const input = container.querySelector<HTMLInputElement>(".th-tree-rename")!;
    const composer = container.querySelector<HTMLTextAreaElement>(".th-pane--focused .th-chat-input textarea");
    container.querySelector<HTMLElement>(".th-sidebar")?.setAttribute("inert", "");
    act(() => pressKey(input, "Escape"));
    expect(container.querySelector(".th-tree-rename")).toBeNull();
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("runs the add-chat flow from its action", () => {
    const trigger = triggerOf("ws-2");
    act(() => trigger.click());
    const popup = popupOf("ws-2")!;
    const add = actionButtons(popup).find((button) => button.textContent === "sidebar.ws.addTerminal")!;

    act(() => add.click());
    expect(popups()).toHaveLength(0);
    expect(onAddTerminal).toHaveBeenCalledWith(workspaceTwo);
    expect(document.activeElement?.closest(".th-modal[role='dialog']")).not.toBeNull();
    act(() => pressKey(document.activeElement!, "Escape"));
    expect(document.querySelector(".th-new-chat")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("runs the delete flow from its action", () => {
    const trigger = triggerOf("ws-1");
    act(() => trigger.click());
    const popup = popupOf("ws-1")!;
    const del = actionButtons(popup).find((button) => button.textContent === "sidebar.ws.delete")!;

    act(() => del.click());
    expect(popups()).toHaveLength(0);
    expect(onDeleteWorkspace).toHaveBeenCalledWith(workspaceOne);
    expect(document.activeElement?.closest(".th-modal[role='dialog']")).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>(".th-confirm-actions button")?.click());
    expect(document.querySelector(".th-confirm")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("uses the modal fallback when add-chat cancellation finds its drawer hidden", () => {
    const trigger = triggerOf("ws-2");
    const composer = container.querySelector<HTMLTextAreaElement>(".th-pane--focused .th-chat-input textarea");
    act(() => trigger.click());
    act(() => actionButtons(popupOf("ws-2")!)[1]?.click());
    const sidebar = container.querySelector<HTMLElement>(".th-sidebar")!;
    sidebar.setAttribute("inert", "");
    sidebar.style.display = "none";
    act(() => document.querySelector<HTMLButtonElement>(".th-new-chat-actions button")?.click());
    expect(document.querySelector(".th-new-chat")).toBeNull();
    expect(document.activeElement).toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });
});
