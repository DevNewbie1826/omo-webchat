import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import { useAppConfig } from "../app-config";
import { SettingsMenu } from "./SettingsMenu";

// Pin the fixed storage contract shared with index.html.
const THEME_STORAGE_KEY = "th-theme";

describe("SettingsMenu theme row", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Harness() {
    const value = useAppConfig();
    return (
      <I18nContext.Provider value={value}>
        <SettingsMenu onOpenStats={() => undefined} />
      </I18nContext.Provider>
    );
  }

  async function renderMenu(): Promise<void> {
    await act(async () => {
      root.render(<Harness />);
    });
  }

  function openPanel(): void {
    const toggle = container.querySelector<HTMLButtonElement>(".th-settings-menu > button");
    expect(toggle).not.toBeNull();
    act(() => {
      toggle!.click();
    });
  }

  function themeRadios(groupLabel: string): HTMLButtonElement[] {
    const group = container.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`);
    expect(group, `theme radiogroup "${groupLabel}"`).not.toBeNull();
    return Array.from(group!.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
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

  it("offers three explicit choices with system selected by default", async () => {
    await renderMenu();
    openPanel();
    const panel = container.querySelector<HTMLElement>(".th-settings-panel");
    expect(panel?.getAttribute("role")).toBe("region");
    expect(panel?.getAttribute("aria-label")).toBe("Settings");
    expect(panel?.querySelector('[role="menuitem"]')).toBeNull();
    const radios = themeRadios("Theme");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });

  it("persists the chosen theme and applies it to the document", async () => {
    await renderMenu();
    openPanel();
    const radios = themeRadios("Theme");
    expect(radios).toHaveLength(3);
    const light = radios[0]!;
    const dark = radios[1]!;

    act(() => {
      light.click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
    expect(light.getAttribute("aria-checked")).toBe("true");

    act(() => {
      dark.click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(dark.getAttribute("aria-checked")).toBe("true");
  });

  it("renders the three choices in Korean", async () => {
    window.localStorage.setItem("th-lang", "ko");
    await renderMenu();
    openPanel();
    const radios = themeRadios("테마");
    expect(radios.map((radio) => radio.textContent)).toEqual(["라이트", "다크", "시스템"]);

    act(() => {
      radios[1]!.click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
