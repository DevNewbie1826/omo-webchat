import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { SessionTreeProps } from "./SessionTree";
import type { Workspace, WorkspaceSession } from "../features/workspace/workspace";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => (vars ? `${key} ${Object.values(vars).join(" ")}` : key),
};

const workspace: Workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/work",
  chats: [
    { id: "tm-1", name: "Stored dangling", provider: "omo" },
    { id: "tm-2", name: "Stored session", provider: "omo" },
  ],
};

const discoveredSession: WorkspaceSession = {
  id: "disk-1",
  name: "Discovered session",
  source: "discovered",
  recencyMs: 1,
  resumeIdentity: "/sessions/disk-1.jsonl",
};

const unnamedId = "ses-abcd-efghijkl";
const unnamedSession: WorkspaceSession = {
  id: unnamedId,
  name: "",
  source: "discovered",
  recencyMs: 4,
  resumeIdentity: "/sessions/unnamed.jsonl",
};

const sessions: readonly WorkspaceSession[] = [
  unnamedSession,
  {
    id: "tm-1",
    name: "Stored dangling",
    source: "stored",
    recencyMs: 3,
    dangling: true,
  } as WorkspaceSession,
  { id: "tm-2", name: "Stored session", source: "stored", recencyMs: 2 },
  discoveredSession,
];

describe("SessionTree session-row activation target", () => {
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
    vi.unstubAllGlobals();
  });

  function render(
    onOpen: SessionTreeProps["onOpen"] = async () => undefined,
    onToggle: SessionTreeProps["onToggle"] = () => undefined,
    workspaces: readonly Workspace[] = [workspace],
  ): void {
    act(() => {
      root.render(
        <I18nContext.Provider value={i18n}>
          <SessionTree
            workspaces={workspaces}
            liveSessions={new Set()}
            activeTerminalId={null}
            placedSessions={new Set()}
            expanded={new Set([workspace.id])}
            sessionLists={new Map([[workspace.id, sessions]])}
            sessionPages={new Map()}
            onToggle={onToggle}
            onLoadMoreSessions={() => undefined}
            onSelect={() => undefined}
            onOpen={onOpen}
            onAddTerminal={() => undefined}
            onDeleteWorkspace={() => undefined}
            onDeleteTerminal={() => undefined}
            onRenameWorkspace={async () => undefined}
            onRenameTerminal={async () => undefined}
            notify={() => undefined}
          />
        </I18nContext.Provider>,
      );
    });
  }

  function row(name: string): HTMLElement {
    const match = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"))
      .find((item) => item.textContent?.includes(name));
    expect(match).toBeDefined();
    return match!;
  }

  it("renders a non-empty placeholder label carrying the short id when a discovered session has no name", () => {
    render();
    const unnamed = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-children > .th-tree-node"))
      .find((item) => item.querySelector(".th-tree-activation")?.getAttribute("aria-label")?.includes(unnamedId.slice(0, 8))
        || item.querySelector(".th-tree-label")?.textContent?.includes(unnamedId.slice(0, 8)));
    expect(unnamed).toBeDefined();
    const label = unnamed!.querySelector(".th-tree-label");
    expect(label?.textContent ?? "").not.toBe("");
    expect(label?.textContent).toContain(unnamedId.slice(0, 8));
    const activation = unnamed!.querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(activation?.getAttribute("aria-label") ?? "").not.toBe("");
  });

  it("keeps missing-original metadata but removes discovered-session source badges", () => {
    render();
    const discovered = row("Discovered session");
    expect(discovered.querySelector(".th-tree-source")).toBeNull();

    const dangling = row("Stored dangling");
    expect(dangling.querySelector(".th-tree-source")).not.toBeNull();
  });

  it("opens a discovered session when its primary row action is clicked", () => {
    const onOpen = vi.fn(async () => undefined);
    render(onOpen);
    const activation = row("Discovered session").querySelector<HTMLButtonElement>(".th-tree-activation");
    expect(activation).not.toBeNull();
    act(() => activation?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(workspace, discoveredSession, false);
  });

  it("toggles the workspace through one name-and-caret disclosure", () => {
    const onToggle = vi.fn();
    render(async () => undefined, onToggle);
    const parent = container.querySelector(".th-tree-workspace > .th-tree-node");
    const disclosure = parent?.querySelector<HTMLButtonElement>(".th-tree-workspace-activation");

    expect(parent?.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure?.getAttribute("aria-label")).toBe(workspace.name);
    expect(disclosure?.querySelector(".th-tree-chevron")?.getAttribute("aria-hidden")).toBe("true");

    act(() => disclosure?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(workspace.id);
  });

  it("keeps every workspace's distinguishing number outside the shrinkable name head", () => {
    const numbered = Array.from({ length: 12 }, (_, index) => ({
      ...workspace,
      id: `ws-${index + 1}`,
      name: `Earlier workspace ${index + 1}`,
    }));
    render(undefined, undefined, numbered);

    const disclosures = container.querySelectorAll<HTMLButtonElement>(".th-tree-workspace-activation");
    expect(disclosures).toHaveLength(12);
    disclosures.forEach((disclosure, index) => {
      const name = `Earlier workspace ${index + 1}`;
      const label = disclosure.querySelector(".th-tree-label-text");
      const head = label?.querySelector(".th-tree-label-head");
      const tail = label?.querySelector(".th-tree-label-tail");
      expect(label?.textContent).toBe(name);
      expect(head?.textContent).toBe("Earlier workspace");
      expect(head?.getAttribute("class")).toBe("th-tree-label-head");
      expect(tail?.textContent).toBe(` ${index + 1}`);
      expect(label?.getAttribute("aria-hidden")).toBe("true");
      expect(disclosure.getAttribute("aria-label")).toBe(name);
      expect(disclosure.getAttribute("title")).toBe(workspace.path);
    });
  });

  it("reserves the final characters when a workspace name has no separate word", () => {
    const longName = "very-long-unbrokenname";
    render(undefined, undefined, [{ ...workspace, name: longName }]);

    const disclosure = container.querySelector<HTMLButtonElement>(".th-tree-workspace-activation");
    expect(disclosure?.querySelector(".th-tree-label-head")?.textContent).toBe("very-long-unbroke");
    expect(disclosure?.querySelector(".th-tree-label-tail")?.textContent).toBe("nname");
    expect(disclosure?.getAttribute("aria-label")).toBe(longName);
  });

  it("keeps short workspace names continuous and their accessible names intact", () => {
    render();

    const disclosure = container.querySelector<HTMLButtonElement>(".th-tree-workspace-activation");
    expect(disclosure?.querySelector(".th-tree-label-text")?.textContent).toBe(workspace.name);
    expect(disclosure?.querySelector(".th-tree-label-head")?.textContent).toBe("Work");
    expect(disclosure?.getAttribute("aria-label")).toBe(workspace.name);
  });
});
