import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { WorkspaceWizard } from "./WorkspaceWizard";
import { createWorkspace } from "./workspace";
import { fsBrowse } from "../terminal/terminal";
import type { FsBrowse } from "../terminal/terminal";
import type { Workspace } from "./workspace";

vi.mock("./workspace", () => ({ createWorkspace: vi.fn() }));
vi.mock("../terminal/terminal", () => ({ fsBrowse: vi.fn(), fsCreateFolder: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function footerPrimary(): HTMLButtonElement {
  const button = document.body.querySelector<HTMLButtonElement>(".th-wizard-foot .th-btn--primary");
  if (!button) throw new Error("expected wizard footer primary button");
  return button;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const BROWSE_RESULT: FsBrowse = { path: "/work", parent: null, dirs: [] };

describe("WorkspaceWizard footer primary action", () => {
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
    vi.restoreAllMocks();
  });

  it("is genuinely disabled while no folder is selected and advances once unblocked", async () => {
    const browse = deferred<FsBrowse>();
    vi.mocked(fsBrowse).mockReturnValue(browse.promise);
    act(() => {
      root.render(<WorkspaceWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    });

    // Blocked: the browse is still pending, so nothing is selected. The
    // primary must carry the disabled attribute, not merely look neutral.
    expect(footerPrimary().disabled).toBe(true);
    click(footerPrimary());
    expect(document.body.querySelector("#th-ws-name")).toBeNull();
    expect(footerPrimary().disabled).toBe(true);

    await act(async () => {
      browse.resolve(BROWSE_RESULT);
      await flushMicrotasks();
    });

    // The picker auto-selects the browsed path, so no click was needed.
    expect(footerPrimary().disabled).toBe(false);
    expect(footerPrimary().classList.contains("th-btn--primary")).toBe(true);
    click(footerPrimary());
    expect(document.body.querySelector("#th-ws-name")).not.toBeNull();
  });

  it("stays blocked on step 2 while the name is empty", async () => {
    vi.mocked(fsBrowse).mockResolvedValue(BROWSE_RESULT);
    act(() => {
      root.render(<WorkspaceWizard open onClose={vi.fn()} onCreated={vi.fn()} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(footerPrimary().disabled).toBe(false);
    click(footerPrimary());

    const nameInput = document.body.querySelector<HTMLInputElement>("#th-ws-name");
    expect(nameInput).not.toBeNull();
    if (!nameInput) return;

    // The step-2 Next handler has no internal guard, so the disabled
    // attribute is the only thing preventing advancement.
    typeInto(nameInput, "   ");
    expect(footerPrimary().disabled).toBe(true);
    click(footerPrimary());
    expect(document.body.querySelector(".th-summary")).toBeNull();

    typeInto(nameInput, "design");
    expect(footerPrimary().disabled).toBe(false);
    click(footerPrimary());
    expect(document.body.querySelector(".th-summary")).not.toBeNull();
  });

  it("disables Create while the request is in flight", async () => {
    vi.mocked(fsBrowse).mockResolvedValue(BROWSE_RESULT);
    const pending = deferred<Workspace>();
    const create = vi.mocked(createWorkspace);
    create.mockReturnValue(pending.promise);
    const onCreated = vi.fn();
    act(() => {
      root.render(<WorkspaceWizard open onClose={vi.fn()} onCreated={onCreated} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    click(footerPrimary());
    const nameInput = document.body.querySelector<HTMLInputElement>("#th-ws-name");
    if (!nameInput) throw new Error("expected step 2 name input");
    typeInto(nameInput, "design");
    click(footerPrimary());

    click(footerPrimary());
    expect(create).toHaveBeenCalledTimes(1);
    expect(footerPrimary().disabled).toBe(true);
    expect(footerPrimary().textContent).toBe("wizard.creating");

    click(footerPrimary());
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ id: "ws-1", name: "design", path: "/work", chats: [] });
      await flushMicrotasks();
    });
    expect(onCreated).toHaveBeenCalledWith({ id: "ws-1", name: "design", path: "/work", chats: [] });
  });
});

describe("WorkspaceWizard footer primary styling contract", () => {
  const readStyle = (name: string): string => readFileSync(`src/styles/${name}.css`, "utf8");

  const ruleBody = (css: string, selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  };

  const declarationValue = (body: string, property: string): string =>
    body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;}]*)`, "i"))?.[1]?.trim() ?? "";

  const sheets: ReadonlyArray<readonly [string, string]> = [
    ["wizard.css", readStyle("wizard")],
    ["workspace-wizard-steps.css", readStyle("workspace-wizard-steps")],
  ];

  it("uses the primary idiom when enabled", () => {
    const formControls = readStyle("form-controls");
    expect(declarationValue(ruleBody(formControls, ".th-btn--primary"), "background")).toBe(
      "var(--th-accent-solid)",
    );
    expect(declarationValue(ruleBody(formControls, ".th-btn--primary"), "color")).toBe(
      "var(--th-accent-fg)",
    );
    expect(declarationValue(ruleBody(formControls, ".th-btn"), "border-radius")).toBe(
      "var(--th-radius-pill)",
    );
  });

  it("uses token disabled styling and gates hover behind :not(:disabled)", () => {
    const formControls = readStyle("form-controls");
    const disabled = ruleBody(formControls, ".th-btn:disabled");
    expect(declarationValue(disabled, "background")).toBe("var(--th-disabled-bg)");
    expect(declarationValue(disabled, "color")).toBe("var(--th-disabled-fg)");
    expect(formControls).toMatch(/\.th-btn--primary:hover:not\(:disabled\)\s*\{/);
  });

  it("keeps the scoped sheets from re-painting the footer primary button", () => {
    for (const [name, css] of sheets) {
      for (const raw of css.split("}")) {
        const selector = raw.split("{")[0] ?? "";
        const body = raw.split("{")[1] ?? "";
        if (!/\.th-wizard-foot/.test(selector) || !/\.th-btn/.test(selector)) continue;
        for (const prop of ["background", "color", "border-radius"]) {
          expect(declarationValue(body, prop), `${name}: ${selector.trim()} re-declares ${prop}`).toBe("");
        }
      }
    }
  });
});
