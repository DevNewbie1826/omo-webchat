import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("index.html", "utf8");
const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)?.[1] ?? "";

/**
 * Regression: PR #13 removed maximum-scale/user-scalable as an a11y gesture,
 * but the app shell is overflow:hidden with a fixed #root - once a mobile
 * browser allows pinch or double-tap zoom, the zoomed shell cannot be panned
 * or scrolled back out, which reads as the page overflowing. The owner's
 * contract is that the app always fills exactly 100% of the mobile viewport,
 * so the zoom lock is restored and the shell additionally opts out of
 * gesture zoom via touch-action (browsers that ignore the meta).
 */
describe("mobile viewport lock", () => {
  it("locks the viewport meta against gesture zoom", () => {
    expect(meta).toContain("width=device-width");
    expect(meta).toContain("initial-scale=1.0");
    expect(meta).toContain("maximum-scale=1.0");
    expect(meta).toContain("user-scalable=no");
    expect(meta).toContain("viewport-fit=cover");
  });

  it("opts the shell out of touch gesture zoom", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const rule = css.match(/html,\s*body\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("touch-action: pan-x pan-y");
  });
});
