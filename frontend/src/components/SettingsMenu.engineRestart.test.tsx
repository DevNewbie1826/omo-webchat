import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import { useAppConfig } from "../app-config";
import { SettingsMenu } from "./SettingsMenu";

describe("SettingsMenu engine restart item", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Harness(props: { readonly onOpenStats: () => void; readonly onOpenEngineRestart: () => void }) {
    const value = useAppConfig();
    return (
      <I18nContext.Provider value={value}>
        <SettingsMenu onOpenStats={props.onOpenStats} onOpenEngineRestart={props.onOpenEngineRestart} />
      </I18nContext.Provider>
    );
  }

  async function renderMenu(onOpenStats: () => void, onOpenEngineRestart: () => void): Promise<void> {
    await act(async () => {
      root.render(<Harness onOpenStats={onOpenStats} onOpenEngineRestart={onOpenEngineRestart} />);
    });
  }

  function openPanel(): void {
    const toggle = container.querySelector<HTMLButtonElement>(".th-settings-menu > button");
    expect(toggle).not.toBeNull();
    act(() => {
      toggle!.click();
    });
  }

  function panelItems(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>(".th-settings-item"));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.setItem("th-lang", "en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  });

  it("renders the restart item directly below the system status item", async () => {
    await renderMenu(() => undefined, () => undefined);
    openPanel();
    const items = panelItems();
    expect(items.map((item) => item.textContent)).toEqual(["System status", "Restart omo engine"]);
  });

  it("invokes only the restart callback and closes the panel", async () => {
    const onOpenStats = vi.fn();
    const onOpenEngineRestart = vi.fn();
    await renderMenu(onOpenStats, onOpenEngineRestart);
    openPanel();
    const restartItem = panelItems().find((item) => item.textContent === "Restart omo engine");
    expect(restartItem).not.toBeUndefined();
    act(() => {
      restartItem!.click();
    });
    expect(onOpenEngineRestart).toHaveBeenCalledTimes(1);
    expect(onOpenStats).not.toHaveBeenCalled();
    expect(container.querySelector(".th-settings-panel")).toBeNull();
  });

  it("renders the restart label in Korean", async () => {
    window.localStorage.setItem("th-lang", "ko");
    await renderMenu(() => undefined, () => undefined);
    openPanel();
    expect(panelItems().map((item) => item.textContent)).toEqual(["시스템 상태", "omo 엔진 다시 시작"]);
  });
});
