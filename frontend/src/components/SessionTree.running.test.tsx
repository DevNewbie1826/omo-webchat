import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue } from "../i18n";
import { SessionTree } from "./SessionTree";
import type { Workspace } from "../features/workspace/workspace";

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
    { id: "tm-live", name: "Live chat", provider: "omo" },
    { id: "tm-idle", name: "Idle chat", provider: "omo" },
  ],
};

const sessions = [
  { id: "tm-live", name: "Live chat", source: "stored" as const, recencyMs: 2 },
  { id: "tm-idle", name: "Idle chat", source: "stored" as const, recencyMs: 1 },
];

function tree(container: HTMLDivElement, runningCounts?: ReadonlyMap<string, number>): void {
  const root = (container as HTMLDivElement & { __root?: Root }).__root!;
  act(() => {
    root.render(
      <I18nContext.Provider value={i18n}>
        <SessionTree
          workspaces={[workspace]}
          liveSessions={new Set(["tm-live", "tm-idle"])}
          runningCounts={runningCounts}
          activeTerminalId={null}
          placedSessions={new Set()}
          expanded={new Set(["ws-1"])}
          sessionLists={new Map([["ws-1", sessions]])}
          sessionPages={new Map()}
          onToggle={() => undefined}
          onLoadMoreSessions={() => undefined}
          onSelect={() => undefined}
          onImport={async () => undefined}
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

describe("SessionTree running-agent badge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (container as HTMLDivElement & { __root?: Root }).__root = root;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function row(name: string): HTMLElement {
    const match = Array.from(container.querySelectorAll<HTMLElement>(".th-tree-node")).find(
      (item) => item.textContent?.includes(name),
    );
    expect(match).toBeDefined();
    return match!;
  }

  it("renders a chip with the count and an aria-label only while agents run", () => {
    tree(container, new Map([
      ["tm-live", 2],
      ["tm-idle", 0],
    ]));

    const live = row("Live chat");
    const chip = live.querySelector(".th-tree-running");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("2");
    expect(chip?.getAttribute("aria-label")).toBe("sidebar.tm.runningAgents 2");
    expect(chip?.getAttribute("role")).toBe("img");
    expect(chip?.querySelector(".th-tree-running-dot")).not.toBeNull();
    expect(live.querySelector(".th-tree-live")).not.toBeNull();

    const idle = row("Idle chat");
    expect(idle.querySelector(".th-tree-running")).toBeNull();
    expect(idle.querySelector(".th-tree-live")).not.toBeNull();
  });

  it("renders no chip at all without running counts", () => {
    tree(container);

    expect(container.querySelector(".th-tree-running")).toBeNull();
    expect(container.querySelectorAll(".th-tree-live")).toHaveLength(2);
  });
});
