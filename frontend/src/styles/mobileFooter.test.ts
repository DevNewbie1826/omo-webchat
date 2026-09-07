import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const sidebarCss = readFileSync("src/styles/sidebar.css", "utf8");
const footerCss = readFileSync("src/styles/sidebar-footer.css", "utf8");
const settingsCss = readFileSync("src/styles/settings-menu.css", "utf8");

// The base shell rule is the only `.th-sidebar {` at column zero; the drawer
// rule inside the media query is indented, so this anchor cannot match it.
const baseSidebarBody = sidebarCss.match(/^\.th-sidebar \{([^}]*)\}/m)?.[1] ?? "";
const footerBody = sidebarCss.match(/^\.th-sidebar-footer \{([^}]*)\}/m)?.[1] ?? "";

describe("mobile sidebar footer bounds", () => {
  test("carves the bottom safe inset out of the sidebar shell at every width", () => {
    // Landscape phones exceed the 768px drawer breakpoint, so the in-flow
    // desktop column is the shell rendering there and #root intentionally
    // keeps a 0 bottom inset (the input bar owns it). Without a base inset
    // its settings/logout controls sit inside the home-indicator gesture
    // zone. env() resolves to 0 wherever no inset exists, so desktop
    // rendering is unchanged.
    expect(baseSidebarBody).toContain("padding-bottom: env(safe-area-inset-bottom)");
  });

  test("drops the bottom safe inset while the software keyboard is open", () => {
    // The keyboard covers the home-indicator zone, so retaining the inset
    // floats the footer above an unnecessary reserve (mirrors the #root
    // keyboard contract in global.css).
    expect(sidebarCss).toMatch(
      /html\[data-th-keyboard-open\] \.th-sidebar \{[^}]*padding-bottom:\s*0;/,
    );
  });

  test("keeps the drawer's top safe inset inside the mobile media block", () => {
    // The fixed drawer is not protected by #root's own safe-area padding, so
    // it must keep carving the top inset for itself.
    const mobileBlock = sidebarCss.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const drawer = mobileBlock.match(/\.th-sidebar \{([^}]*)\}/)?.[1] ?? "";
    expect(drawer).toContain("padding-top: env(safe-area-inset-top)");
  });

  test("keeps the footer's intentional spacing on the spacing scale", () => {
    // The only intentional reserve below the controls is the footer's own
    // block padding (8px on desktop); the spacer stretches the settings/logout
    // row horizontally and never adds vertical reserve.
    expect(footerBody).toMatch(/padding:\s*var\(--th-space-2\)\s+var\(--th-space-3\)/);
    expect(footerCss).toMatch(/\.th-sidebar-footer-spacer \{\s*flex:\s*1;\s*\}/);
  });

  test("targets a 4px intentional bottom gap in the mobile drawer", () => {
    // The mobile drawer tightens the footer's block padding to --th-space-1;
    // everything below it is the shell's single safe inset (released while
    // the keyboard is open), never a second spacing reserve. Outside mobile
    // widths the shell preserves normal spacing and carries the platform's
    // bottom safe inset itself.
    const mobileBlock = sidebarCss.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const footerRule = mobileBlock.match(/\.th-sidebar-footer \{([^}]*)\}/)?.[1] ?? "";
    expect(footerRule).toContain("padding-bottom: var(--th-space-1)");
  });

  test("bounds the settings panel to the space above its footer anchor", () => {
    // The panel opens upward from the footer button; without a viewport-bound
    // max-height it keeps its natural 265px height and its top leaves the
    // visible region in short viewports (landscape phone with the software
    // keyboard open). The reserve covers footer height plus the panel offset
    // in both drawer and desktop-shell renderings; overflow-y keeps every
    // control reachable by scrolling instead of clipping.
    const panelBody = settingsCss.match(/^\.th-settings-panel \{([^}]*)\}/m)?.[1] ?? "";
    expect(panelBody).toContain(
      "max-height: calc(var(--th-vh-unit, 1vh) * 100 - var(--th-space-12) - var(--th-space-1))",
    );
    expect(panelBody).toContain("overflow-y: auto");
  });
});
