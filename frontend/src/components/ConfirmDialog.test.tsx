import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../i18n";
import type { I18nValue, Translate } from "../i18n";
import { useConfirm } from "./ConfirmDialog";
import type { ConfirmApi } from "./ConfirmDialog";

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key) => key,
};

const translate: Translate = (key) => key;

describe("ConfirmDialog labeling", () => {
  let container: HTMLDivElement;
  let root: Root;
  let apis: readonly ConfirmApi[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  });

  function TwoConfirms() {
    const first = useConfirm(translate);
    const second = useConfirm(translate);
    apis = [first, second];
    return (
      <I18nContext.Provider value={i18n}>
        {first.dialog}
        {second.dialog}
      </I18nContext.Provider>
    );
  }

  it("gives stacked confirm dialogs unique, self-referencing title IDs", async () => {
    act(() => root.render(<TwoConfirms />));
    await act(async () => {
      void apis[0]?.confirm({ title: "Delete file?", message: "Cannot be undone." });
      void apis[1]?.confirm({ title: "Discard changes?", message: "Unsaved." });
    });

    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
    expect(dialogs).toHaveLength(2);
    const labels = dialogs.map((dialog) => dialog.getAttribute("aria-labelledby"));
    expect(labels[0]).toBeTruthy();
    expect(labels[1]).toBeTruthy();
    // Two simultaneous confirms must not share a hardcoded title id.
    expect(labels[0]).not.toBe(labels[1]);

    const titles = labels.map((label) => document.getElementById(label ?? ""));
    expect(titles[0]?.textContent).toBe("Delete file?");
    expect(titles[1]?.textContent).toBe("Discard changes?");
    // Each generated id is unique in the document.
    expect(document.querySelectorAll(`[id="${labels[0]}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`[id="${labels[1]}"]`)).toHaveLength(1);
  });
});
