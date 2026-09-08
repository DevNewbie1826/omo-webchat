import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const sidebar = readFileSync("src/styles/sidebar.css", "utf8");
const composer = readFileSync("src/styles/chat-composer.css", "utf8");
const excludedBottom = "max(0px, 100lvh - var(--th-vv-top, 0px) - var(--th-vh-unit, 1vh) * 100)";

test("standalone sidebar reserves only the safe area not already outside the visual bottom", () => {
  const shell = sidebar.match(/^html\[data-th-standalone\] \.th-sidebar \{([^}]*)\}/m)?.[1] ?? "";
  const slot = sidebar.match(/^html\[data-th-standalone\]:not\(\[data-th-keyboard-open\]\) \.th-sidebar-inner::after \{([^}]*)\}/m)?.[1] ?? "";
  expect(shell).toContain("padding-bottom: 0");
  expect(slot).toContain('content: ""');
  expect(slot).toContain("flex: none");
  expect(slot).toContain(`height: max(0px, calc(env(safe-area-inset-bottom) - ${excludedBottom}))`);
});

test("standalone composer subtracts covered safe area while retaining breathing room", () => {
  const slot = composer.match(/^html\[data-th-standalone\]:not\(\[data-th-keyboard-open\]\) \.th-chat-input::after \{([^}]*)\}/m)?.[1] ?? "";
  expect(slot).toContain(`height: max(0px, calc(env(safe-area-inset-bottom) - ${excludedBottom} - var(--th-space-1)))`);
  const fine = composer.match(/@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)\n\}/g)?.join("\n") ?? "";
  expect(fine).toContain(`height: max(0px, calc(env(safe-area-inset-bottom) - ${excludedBottom} - var(--th-space-4)))`);
});
