import { readFileSync } from "node:fs";

import { assert, describe, expect, test } from "vitest";

import pageHtml from "../../index.html?raw";

const globalCss = readFileSync("src/styles/global.css", "utf8");

describe("mobile safe area", () => {
  test("keeps layout inside the visible viewport", () => {
    expect(globalCss).toMatch(
      /^#root \{[^}]*height: 100dvh;[^}]*padding: env\(safe-area-inset-top\)/m,
    );
    expect(globalCss).not.toContain("100lvh");
    expect(globalCss).not.toContain("100svh");
    expect(globalCss).toMatch(
      /html\[data-th-keyboard-open\] #root \{[^}]*height: calc\(var\(--th-vh-unit, 1vh\) \* 100\);[^}]*transform: translate\(var\(--th-vv-left, 0px\), var\(--th-vv-top, 0px\)\)/,
    );
  });

  test("fills the screen edge while respecting side and top safe-area insets", () => {
    expect(globalCss).toMatch(/body \{[^}]*background: var\(--th-bg\)/);
    expect(globalCss).toMatch(
      /#root \{[^}]*padding:\s+env\(safe-area-inset-top\)\s+env\(safe-area-inset-right\)\s+0\s+env\(safe-area-inset-left\)/,
    );
  });

  test("keeps the safe inset when focus outlives the software keyboard", () => {
    // Content-addressed: the inline script that wires the visual viewport,
    // not positionally "the first script" (index.html has several).
    const script = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .find((body) => body?.includes("--th-vh-unit"));
    expect(script).toBeDefined();

    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    assert(frame.contentWindow);
    assert(frame.contentDocument);
    assert(script);
    const viewportWindow = frame.contentWindow as typeof window;
    const viewportDocument = frame.contentDocument;
    const resizeListeners: Array<() => void> = [];
    const viewport = {
      height: 844,
      width: 390,
      offsetLeft: 0,
      offsetTop: 0,
      addEventListener: (type: string, listener: () => void) => {
        if (type === "resize") resizeListeners.push(listener);
      },
    };
    const input = viewportDocument.createElement("textarea");

    try {
      Object.defineProperty(viewportWindow, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      viewportWindow.eval(script);
      viewportDocument.body.appendChild(input);
      input.focus();

      expect(
        viewportDocument.documentElement.hasAttribute("data-th-keyboard-open"),
      ).toBe(false);

      viewport.height = 504;
      for (const listener of resizeListeners) listener();
      expect(
        viewportDocument.documentElement.hasAttribute("data-th-keyboard-open"),
      ).toBe(true);

      viewport.height = 844;
      for (const listener of resizeListeners) listener();
      expect(viewportDocument.activeElement).toBe(input);
      expect(
        viewportDocument.documentElement.hasAttribute("data-th-keyboard-open"),
      ).toBe(false);
    } finally {
      frame.remove();
    }
  });
});
