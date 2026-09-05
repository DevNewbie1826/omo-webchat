import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, type ModelOption } from "./ModelPicker";

const models: readonly ModelOption[] = [
  { provider: "anthropic", modelId: "claude-opus", name: "Opus" },
  { provider: "openai", modelId: "gpt-5", name: "GPT-5" },
  { provider: "openai", modelId: "gpt-4o" },
];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value }));
}

function pressKey(target: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("ModelPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let selected: string[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    selected = [];
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps exact current selection separate from navigation and search", () => {
    const catalog = [...models, { provider: "other", modelId: "gpt-5", name: "GPT-5" }];
    act(() => root.render(<ModelPicker models={catalog} currentModelKey="openai/gpt-5"
      placeholder="Model" searchPlaceholder="Search" onSelect={(value) => selected.push(value)} />));
    act(() => container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!.click());
    const search = container.querySelector<HTMLInputElement>("input")!;
    const options = container.querySelectorAll('[role="option"]');
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    expect(search.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    act(() => options[0]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(search.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    act(() => pressKey(search, "ArrowDown"));
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[2]!.getAttribute("aria-selected")).toBe("false");
    act(() => setInputValue(search, "other"));
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
    expect(selected).toEqual([]);
    act(() => pressKey(search, "Enter"));
    expect(selected).toEqual(["other/gpt-5"]);
  });

  it("opens compact controls without focusing search and pins current provider", () => {
    act(() => root.render(<ModelPicker models={models} currentModelKey="openai/gpt-5"
      placeholder="Model" searchPlaceholder="Search" compact thinkingLevel="high"
      onSelect={(value) => selected.push(value)} />));
    const trigger = container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!;
    act(() => trigger.click());
    const search = document.querySelector<HTMLInputElement>(".th-model-picker-search")!;
    expect(document.activeElement).not.toBe(search);
    expect(document.querySelector(".th-model-picker-current")?.textContent).toContain("openai");
    expect(trigger.textContent).toContain("high");
    act(() => pressKey(document.activeElement as HTMLElement, "Escape"));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])("cycles compact keyboard focus through every control (reverse=%s)", (reverse) => {
    const changed: string[] = [];
    act(() => root.render(<ModelPicker models={models} currentModelKey="openai/gpt-5"
      placeholder="Model" searchPlaceholder="Search" compact
      thinkingLevels={["off", "high"]} thinkingLevel="high" thinkingLabel="Thinking"
      onThinkingChange={(level) => changed.push(level)} onSelect={(value) => selected.push(value)} />));
    const trigger = container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!;
    act(() => trigger.click());
    const sheet = document.querySelector<HTMLElement>(".th-model-picker-popover--sheet")!;
    const close = sheet.querySelector<HTMLButtonElement>(".th-btn-icon")!;
    const levels = Array.from(sheet.querySelectorAll<HTMLButtonElement>(".th-thinking-level"));
    const search = sheet.querySelector<HTMLInputElement>("input")!;
    const options = Array.from(sheet.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const controls = [close, ...levels, search, ...options];
    const order = reverse ? [...controls].reverse() : controls;
    expect(document.activeElement).toBe(sheet);
    for (const target of [...order, order[0]!]) {
      act(() => pressKey(document.activeElement as HTMLElement, "Tab", reverse));
      expect(document.activeElement).toBe(target);
      expect(sheet.isConnected).toBe(true);
      expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    }
    expect(selected).toEqual([]);
    expect(changed).toEqual([]);
    act(() => pressKey(document.activeElement as HTMLElement, "Escape"));
    expect(sheet.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps compact thinking activation independent from active model navigation and restores explicit close", () => {
    const changed: string[] = [];
    act(() => root.render(<ModelPicker models={models} currentModelKey="openai/gpt-5"
      placeholder="Model" searchPlaceholder="Search" compact
      thinkingLevels={["off", "high"]} thinkingLevel="high" thinkingLabel="Thinking"
      onThinkingChange={(level) => changed.push(level)} onSelect={(value) => selected.push(value)} />));
    const trigger = container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!;
    act(() => trigger.click());
    const sheet = document.querySelector<HTMLElement>(".th-model-picker-popover--sheet")!;
    act(() => pressKey(sheet, "ArrowDown"));
    act(() => pressKey(sheet, "Tab"));
    act(() => pressKey(document.activeElement as HTMLElement, "Tab"));
    const off = sheet.querySelector<HTMLButtonElement>(".th-thinking-level")!;
    expect(document.activeElement).toBe(off);
    act(() => {
      expect(pressKey(off, "Enter").defaultPrevented).toBe(false);
      off.click(); // jsdom does not synthesize native button activation from Enter.
    });
    expect(changed).toEqual(["off"]);
    expect(selected).toEqual([]);
    expect(sheet.querySelector('[aria-selected="true"]')?.textContent).toContain("GPT-5");
    act(() => sheet.querySelector<HTMLButtonElement>(".th-btn-icon")!.click());
    expect(sheet.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps compact search and close reachable when filtering has no matches", () => {
    act(() => root.render(<ModelPicker models={models} currentModelKey="openai/gpt-5"
      placeholder="Model" searchPlaceholder="Search" compact onSelect={(value) => selected.push(value)} />));
    act(() => container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!.click());
    const sheet = document.querySelector<HTMLElement>(".th-model-picker-popover--sheet")!;
    const search = sheet.querySelector<HTMLInputElement>("input")!;
    const close = sheet.querySelector<HTMLButtonElement>(".th-btn-icon")!;
    act(() => setInputValue(search, "missing"));
    expect(sheet.querySelector('[role="option"]')).toBeNull();
    act(() => pressKey(search, "Tab"));
    expect(document.activeElement).toBe(close);
    act(() => pressKey(close, "Tab", true));
    expect(document.activeElement).toBe(search);
    expect(selected).toEqual([]);
  });

  it.each(["search", "thinking"])("preserves compact %s interaction across equivalent catalog replacement", (focusedControl) => {
    const render = (catalog: readonly ModelOption[]): void => {
      root.render(<ModelPicker compact models={catalog} currentModelKey="openai/gpt-5"
        placeholder="Model" searchPlaceholder="Search" thinkingLevels={["off", "high"]}
        thinkingLevel="high" onThinkingChange={() => undefined} onSelect={(value) => selected.push(value)} />);
    };
    act(() => render(models));
    act(() => container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!.click());
    const search = document.querySelector<HTMLInputElement>(".th-model-picker-search")!;
    act(() => setInputValue(search, "gpt"));
    act(() => pressKey(search, "ArrowDown"));
    const active = document.getElementById(search.getAttribute("aria-activedescendant")!)!;
    if (focusedControl === "thinking") act(() => pressKey(search, "Tab", true));
    const focused = document.activeElement;
    act(() => render(models.map((model) => ({ ...model }))));
    expect(search.value).toBe("gpt");
    expect(document.activeElement).toBe(focused);
    expect(document.getElementById(search.getAttribute("aria-activedescendant")!)).toBe(active);
    expect(active.textContent).toContain("gpt-4o");
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("GPT-5");
    expect(selected).toEqual([]);
  });

  it("reconciles navigation by provider/model key without resetting search or focus on catalog/current updates", () => {
    const other = { provider: "other", modelId: "gpt-5", name: "GPT-5" };
    const render = (catalog: readonly ModelOption[], currentModelKey = "openai/gpt-5"): void => {
      root.render(<ModelPicker compact models={catalog} currentModelKey={currentModelKey}
        placeholder="Model" searchPlaceholder="Search" onSelect={(value) => selected.push(value)} />);
    };
    const activeOption = (search: HTMLInputElement): HTMLElement | null =>
      document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
    act(() => render([...models, other]));
    const trigger = container.querySelector<HTMLButtonElement>(".th-model-picker-btn")!;
    act(() => trigger.click());
    const search = document.querySelector<HTMLInputElement>(".th-model-picker-search")!;
    act(() => setInputValue(search, "gpt"));
    // Preserve the filter's first active match even before arrow navigation.
    act(() => render([other, ...models]));
    expect(activeOption(search)?.textContent).toContain("openai");
    act(() => pressKey(search, "ArrowUp"));
    expect(activeOption(search)?.textContent).toContain("other");
    act(() => render([other, ...models]));
    expect(search.value).toBe("gpt");
    expect(document.activeElement).toBe(search);
    expect(activeOption(search)?.textContent).toContain("other");
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("openai");

    // An authoritative current-model update changes selection, not navigation.
    act(() => render([other, ...models], "anthropic/claude-opus"));
    expect(search.value).toBe("gpt");
    expect(document.activeElement).toBe(search);
    expect(activeOption(search)?.textContent).toContain("other");
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("Opus");

    // Removing the active key falls back to the first remaining match.
    act(() => render(models, "anthropic/claude-opus"));
    expect(activeOption(search)?.textContent).toContain("GPT-5");
    act(() => render([models[0]!], "anthropic/claude-opus"));
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    expect(search.value).toBe("gpt");
    expect(document.activeElement).toBe(search);
    act(() => pressKey(search, "Enter"));
    expect(selected).toEqual([]);

    // An empty catalog and later hydration must not resurrect a removed key.
    act(() => render([], "anthropic/claude-opus"));
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    act(() => render([models[2]!, other], "other/gpt-5"));
    expect(activeOption(search)?.textContent).toContain("gpt-4o");
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain("other");
    act(() => pressKey(search, "Escape"));
    act(() => trigger.click());
    const reopened = document.querySelector<HTMLInputElement>(".th-model-picker-search")!;
    expect(reopened.value).toBe("");
    expect(activeOption(reopened)?.textContent).toContain("other");
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    act(() => pressKey(document.activeElement as HTMLElement, "Enter"));
    expect(selected).toEqual(["other/gpt-5"]);
  });

  it("lists all models when opened and selects via keyboard", () => {
    act(() => {
      root.render(
        <ModelPicker
          models={models}
          currentModelKey=""
          placeholder="Model"
          searchPlaceholder="Search models"
          onSelect={(value) => selected.push(value)}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(".th-model-picker-btn");
    if (!button) throw new Error("missing picker button");
    expect(button.textContent).toContain("Model");

    act(() => button.click());
    const options = container.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(3);

    const search = container.querySelector<HTMLInputElement>(".th-model-picker-search");
    if (!search) throw new Error("missing search input");
    act(() => setInputValue(search, "gpt"));
    expect(container.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(2);

    act(() => pressKey(search, "ArrowDown"));
    act(() => pressKey(search, "Enter"));
    expect(selected).toEqual(["openai/gpt-4o"]);
  });

  it("closes on Tab without selecting or blocking native focus traversal", () => {
    act(() => {
      root.render(
        <ModelPicker
          models={models}
          currentModelKey=""
          placeholder="Model"
          searchPlaceholder="Search models"
          onSelect={(value) => selected.push(value)}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(".th-model-picker-btn");
    if (!button) throw new Error("missing picker button");
    act(() => button.click());

    const search = container.querySelector<HTMLInputElement>(".th-model-picker-search");
    if (!search) throw new Error("missing search input");
    let tabEvent: KeyboardEvent | undefined;
    act(() => {
      tabEvent = pressKey(search, "Tab");
    });

    expect(tabEvent?.defaultPrevented).toBe(false);
    expect(selected).toEqual([]);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("closes on Escape", () => {
    act(() => {
      root.render(
        <ModelPicker
          models={models}
          currentModelKey="anthropic/claude-opus"
          placeholder="Model"
          searchPlaceholder="Search models"
          onSelect={() => undefined}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(".th-model-picker-btn");
    if (!button) throw new Error("missing picker button");
    expect(button.textContent).toContain("Opus");

    act(() => button.click());
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    const search = container.querySelector<HTMLInputElement>(".th-model-picker-search");
    if (!search) throw new Error("missing search input");
    act(() => pressKey(search, "Escape"));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
  it("renders thinking levels inside the popover and reports changes", () => {
    const changed: string[] = [];
    act(() => {
      root.render(
        <ModelPicker
          models={models}
          currentModelKey=""
          placeholder="Model"
          searchPlaceholder="Search models"
          onSelect={(value) => selected.push(value)}
          thinkingLevels={["off", "low", "medium", "high", "max"]}
          thinkingLevel="medium"
          thinkingLabel="Thinking"
          onThinkingChange={(level) => changed.push(level)}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>(".th-model-picker-btn");
    if (!button) throw new Error("missing picker button");
    act(() => button.click());

    const levels = Array.from(container.querySelectorAll<HTMLButtonElement>(".th-thinking-level"));
    expect(levels.map((b) => b.textContent)).toEqual(["off", "low", "medium", "high", "max"]);
    expect(levels.find((b) => b.textContent === "medium")?.getAttribute("aria-pressed")).toBe("true");

    const high = levels.find((b) => b.textContent === "high");
    if (!high) throw new Error("missing high level");
    act(() => high.click());
    expect(changed).toEqual(["high"]);
  });

  it("renders an options icon affordance and keeps the button labeled", () => {
    act(() => {
      root.render(
        <ModelPicker
          models={models}
          currentModelKey="openai/gpt-5"
          placeholder="Model"
          searchPlaceholder="Search models"
          onSelect={() => undefined}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(".th-model-picker-btn");
    if (!button) throw new Error("missing picker button");
    // The settings icon is the narrow-pane affordance (CSS shows it, hides the label);
    // the accessible name must survive the label being hidden.
    expect(container.querySelector(".th-model-picker-icon")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("GPT-5");
  });
});
