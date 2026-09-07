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

  test("extends the standalone sidebar over the installed app's full screen while the keyboard is closed", () => {
    // The standalone shell follows the measured large-height basis. Its
    // in-flow safe-top subtraction and fixed drawer padding stay distinct.
    const standaloneBody = sidebarCss.match(
      /^html\[data-th-standalone\]:not\(\[data-th-keyboard-open\]\) \.th-sidebar \{([^}]*)\}/m,
    )?.[1] ?? "";
    expect(standaloneBody.match(/height:\s*[^;]+;/g)).toEqual(["height: calc(100lvh - env(safe-area-inset-top));"]);
    const mobileBlock = sidebarCss.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const standaloneDrawer = mobileBlock.match(
      /html\[data-th-standalone\]:not\(\[data-th-keyboard-open\]\) \.th-sidebar \{([^}]*)\}/,
    )?.[1] ?? "";
    expect(standaloneDrawer.match(/height:\s*[^;]+;/g)).toEqual(["height: 100lvh;"]);
  });

  test("keeps top and inline spacing but removes extra bottom reserve at every width", () => {
    expect(footerBody).toMatch(/padding:\s*var\(--th-space-2\)\s+var\(--th-space-3\)\s+0\s*;/);
    expect(footerCss).toMatch(/\.th-sidebar-footer-spacer \{\s*flex:\s*1;\s*\}/);
  });

  test("does not reintroduce bottom padding in the mobile drawer", () => {
    const mobileBlock = sidebarCss.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(mobileBlock).not.toMatch(/\.th-sidebar-footer\s*\{/);
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
      "max-height: calc(var(--th-vh-unit, 1vh) * 100 - env(safe-area-inset-top) - env(safe-area-inset-bottom) - var(--th-space-12) - var(--th-space-1))",
    );
    expect(panelBody).toContain("overflow-y: auto");
  });

  test("releases only the obsolete bottom budget while the keyboard is open", () => {
    const keyboardPanel = settingsCss.match(/html\[data-th-keyboard-open\] \.th-settings-panel \{([^}]*)\}/)?.[1] ?? "";
    expect(keyboardPanel).toContain(
      "max-height: calc(var(--th-vh-unit, 1vh) * 100 - env(safe-area-inset-top) - var(--th-space-12) - var(--th-space-1))",
    );
    expect(keyboardPanel).not.toContain("safe-area-inset-bottom");
  });
});
