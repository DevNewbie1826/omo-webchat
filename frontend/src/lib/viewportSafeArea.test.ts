import { readFileSync } from "node:fs";

import { assert, describe, expect, onTestFinished, test } from "vitest";

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
    const page = viewportPage();
    const input = page.document.createElement("textarea");
    page.document.body.appendChild(input);
    input.value = "retained draft";
    input.focus();
    page.check(false);
    page.update({ height: 504 });
    page.check(true);
    page.update({ height: 844 });
    page.check(false);
    expect(page.document.activeElement).toBe(input);
    expect(input.value).toBe("retained draft");
  });

  test("retains keyboard evidence through 390 -> 392 -> 390 visual width jitter", () => {
    const page = viewportPage();
    page.check(false);
    for (const [width, height, open] of [
      [390, 504, true], [392, 504, true], [390, 504, true], [390, 844, false],
    ] as const) {
      page.update({ width, height });
      page.check(open);
    }
  });

  test("pageshow while shrunk preserves the unobscured baseline", () => {
    const page = viewportPage();
    page.update({ height: 504, offsetTop: 72, offsetLeft: 2 });
    page.check(true);
    page.windowEvent("pageshow");
    page.check(true);
    page.update({ height: 844, offsetTop: 0, offsetLeft: 0 }, "scroll");
    page.check(false);
  });

  test.each([true, false])("normalizes scale without losing keyboard=%s", (open) => {
    const page = viewportPage();
    const height = open ? 504 : 844;
    page.update({ height });
    page.check(open);
    page.update({ width: 195, height: height / 2, scale: 2, offsetLeft: 12, offsetTop: 30 });
    page.check(open);
    page.windowEvent("pageshow");
    page.check(open);
    page.update({ height: 422 }, "scroll");
    page.check(false);
    page.update({ width: 390, height: 844, scale: 1, offsetLeft: 0, offsetTop: 0 });
    page.check(false);
  });

  test.each(["before", "after"] as const)("rotation event %s new geometry rejects stale and mixed samples", (order) => {
    const page = viewportPage();
    page.update({ height: 504 });
    page.check(true);
    if (order === "before") page.rotate("landscape-primary");
    page.check(true);
    // Layout and visual viewport updates need not arrive together.
    page.layout(844, 390);
    page.windowEvent("resize");
    page.check(true);
    page.update({ width: 844 }); // new width with stale portrait height
    page.check(true);
    page.update({ height: 200, offsetTop: 40 });
    if (order === "after") page.rotate("landscape-primary");
    page.check(true);
    page.update({ width: 390, height: 504 }); // stale visual sample
    page.check(true);
    page.update({ width: 844, height: 200 });
    page.check(true);
    page.windowEvent("orientationchange"); // duplicate event must not erase evidence
    page.check(true);
    page.update({ height: 390, offsetTop: 0 });
    page.check(false);
    // Late portrait frames must not poison the landscape baseline.
    page.update({ width: 390, height: 844 });
    page.check(false);
    page.update({ width: 844, height: 390 });
    page.check(false);
    page.rotate("portrait-primary");
    page.update({ width: 390, height: 844 }); // visual geometry arrives first
    page.check(false);
    page.layout(390, 844);
    page.windowEvent("resize");
    page.check(false);
    page.update({ height: 504 });
    page.check(true);
  });

  test("layout resize is not gated by the physical screen orientation", () => {
    const page = viewportPage();
    page.update({ height: 504 });
    page.check(true);
    page.layout(844, 390);
    page.update({ width: 844, height: 390 });
    page.check(false);
  });

  test("closed rotation resets the compatible baseline rather than reusing portrait height", () => {
    const page = viewportPage();
    page.rotate("landscape-primary");
    page.layout(844, 390);
    page.update({ width: 844, height: 390 });
    page.check(false);
    page.update({ height: 200 });
    page.check(true);
    page.update({ height: 390 });
    page.check(false);
  });

  test("window.resize publishes and recovers without VisualViewport", () => {
    const page = viewportPage({ visualViewport: false });
    page.check(false);
    page.layout(390, 504);
    page.windowEvent("resize");
    page.check(true);
    page.windowEvent("pageshow");
    page.check(true);
    page.layout(390, 844);
    page.windowEvent("resize");
    page.check(false);
    page.rotate("landscape-primary");
    page.layout(844, 390);
    page.windowEvent("resize");
    page.check(false);
  });

  test.each([
    [true, false, true], [false, true, true], [true, true, true],
    [false, false, false], ["true", false, false],
  ] as const)("standalone native=%s display-mode=%s yields %s", (native, displayMode, expected) => {
    const page = viewportPage({ native, displayMode });
    expect(page.document.documentElement.hasAttribute("data-th-standalone")).toBe(expected);
  });
});

// Evaluate the actual shipped script, not a duplicate of its state machine.
function viewportPage(options: {
  readonly visualViewport?: boolean;
  readonly native?: boolean | string;
  readonly displayMode?: boolean;
} = {}) {
  const script = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((body) => body?.includes("--th-vh-unit"));
  assert(script);
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  onTestFinished(() => frame.remove());
  assert(frame.contentWindow);
  assert(frame.contentDocument);
  const viewportWindow = frame.contentWindow as typeof window;
  const viewportDocument = frame.contentDocument;
  const viewport = Object.assign(new viewportWindow.EventTarget(), {
    width: 390, height: 844, scale: 1, offsetTop: 0, offsetLeft: 0,
  });
  const orientation = { type: "portrait-primary" };
  const layout = (width: number, height: number) => {
    Object.defineProperty(viewportWindow, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(viewportWindow, "innerHeight", { configurable: true, value: height });
  };
  const windowEvent = (type: string) => viewportWindow.dispatchEvent(new viewportWindow.Event(type));
  layout(390, 844);
  Object.defineProperty(viewportWindow, "visualViewport", {
    configurable: true, value: options.visualViewport === false ? undefined : viewport,
  });
  Object.defineProperty(viewportWindow.screen, "orientation", { configurable: true, value: orientation });
  Object.defineProperty(viewportWindow.navigator, "standalone", { configurable: true, value: options.native });
  Object.defineProperty(viewportWindow, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: query === "(display-mode: standalone)" && options.displayMode === true }),
  });
  viewportWindow.eval(script);
  return {
    document: viewportDocument, layout, windowEvent,
    rotate: (type: string) => {
      orientation.type = type;
      windowEvent("orientationchange");
    },
    update: (geometry: Partial<Pick<typeof viewport, "width" | "height" | "scale" | "offsetTop" | "offsetLeft">>, event = "resize") => {
      Object.assign(viewport, geometry);
      viewport.dispatchEvent(new viewportWindow.Event(event));
    },
    check: (open: boolean) => {
      const root = viewportDocument.documentElement;
      expect(root.hasAttribute("data-th-keyboard-open")).toBe(open);
      const vv = options.visualViewport !== false;
      expect(root.style.getPropertyValue("--th-vh-unit")).toBe(`${(vv ? viewport.height : viewportWindow.innerHeight) * 0.01}px`);
      expect(root.style.getPropertyValue("--th-vv-width")).toBe(`${vv ? viewport.width : viewportWindow.innerWidth}px`);
      expect(root.style.getPropertyValue("--th-vv-top")).toBe(`${vv ? viewport.offsetTop : 0}px`);
      expect(root.style.getPropertyValue("--th-vv-left")).toBe(`${vv ? viewport.offsetLeft : 0}px`);
    },
  };
}
