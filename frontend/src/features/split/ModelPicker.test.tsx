import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function pressKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("ModelPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let selected: string[];

  beforeEach(() => {
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
