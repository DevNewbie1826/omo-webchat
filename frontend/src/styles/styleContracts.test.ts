import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const readStyle = (name: string): string => readFileSync(`src/styles/${name}.css`, "utf8");
const tokens = readStyle("tokens");
const global = readStyle("global");
const chatPane = readStyle("chat-pane");
const chatTranscript = readStyle("chat-transcript");
const toolCard = readStyle("tool-card");
const sessionTree = readStyle("session-tree");
const termhead = readStyle("terminal-header");
const math = readStyle("math");
const modal = readStyle("modal-dialog");
const newChat = readStyle("new-chat-dialog");
const split = readStyle("split-view");
const fileBrowser = readStyle("file-browser");
const fileEditor = readStyle("file-editor");
const appEmpty = readStyle("app-empty");
const sidebar = readStyle("sidebar");
const sidebarToggle = readStyle("sidebar-toggle");
const allStyles = ["app-empty", "chat-transcript", "login", "sidebar"]
  .map(readStyle)
  .join("\n");
// Vite's glob supplies only the complete stylesheet inventory. Contract
// assertions read each path through node:fs so every run observes current disk
// bytes rather than a transformed or cached CSS module payload.
const stylesheetPaths = Object.keys(import.meta.glob("./*.css"));

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

const tokenValue = (name: string): string =>
  tokens.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^;]+);`))?.[1]?.trim() ?? "";

const declarationValue = (body: string, property: string): string => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;}]*)`, "i"))?.[1]?.trim() ?? "";
};

const wholeVarToken = (value: string): string => value.match(/^var\(\s*(--[\w-]+)\s*\)$/i)?.[1] ?? "";

const containsVarToken = (value: string, token: string): boolean =>
  Array.from(value.matchAll(/var\(\s*(--[\w-]+)\s*\)/gi), (match) => match[1]).includes(token);

const decodeCssIdentifier = (identifier: string): string =>
  identifier.replace(/\\([\da-f]{1,6}[\t\n\f\r ]?|.)/gis, (_escape, sequence: string) => {
    const hex = sequence.match(/^[\da-f]{1,6}/i)?.[0];
    if (hex === undefined) return sequence;
    const codePoint = Number.parseInt(hex, 16);
    return codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
  });

// Reserve the entire --th-* namespace to tokens.css by default. These exact
// names are component geometry, scoped and overridden only within chat-pane.css:
// - --th-chat-max caps the chat content lane independently of theme.
// - --th-chat-gutter adapts the chat lane's inline gutter at container breakpoints.
// - --th-chat-scrollbar sizes chat-specific scrollbar accommodation.
const COMPONENT_OWNED_CUSTOM_PROPERTIES = new Map([
  ["--th-chat-max", "chat-pane.css"],
  ["--th-chat-gutter", "chat-pane.css"],
  ["--th-chat-scrollbar", "chat-pane.css"],
]);

const isProtectedDesignTokenName = (name: string, file: string): boolean =>
  name.toLowerCase().startsWith("--th-") && COMPONENT_OWNED_CUSTOM_PROPERTIES.get(name) !== file.split("/").pop();

const localDesignTokenRedefinitions = (file: string, css: string): string[] => {
  const violations: string[] = [];
  const stylesheet = postcss.parse(css, { from: file });
  stylesheet.walkDecls((declaration) => {
    const name = decodeCssIdentifier(declaration.prop);
    if (!isProtectedDesignTokenName(name, file)) return;
    violations.push(
      `${file}:${declaration.source?.start?.line ?? "?"}: ${name} may be declared only in tokens.css`,
    );
  });
  stylesheet.walkAtRules((atRule) => {
    // PostCSS splits a hex-escaped at-keyword at the escape terminator, so
    // reconstruct and decode the complete prelude before identifying
    // @property and its registered custom-property name.
    const rawPrelude = `${atRule.name}${atRule.raws.afterName ?? " "}${atRule.params}`;
    const prelude = decodeCssIdentifier(rawPrelude.replace(/\/\*[\s\S]*?\*\//g, "").trim());
    const name = /^property\s+(--\S+)$/i.exec(prelude)?.[1];
    if (name === undefined || !isProtectedDesignTokenName(name, file)) return;
    violations.push(
      `${file}:${atRule.source?.start?.line ?? "?"}: @property ${name} may be registered only in tokens.css`,
    );
  });
  return violations;
};

const isSpacingProperty = (property: string): boolean =>
  /^(?:(?:margin|padding)(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?|(?:row-|column-)?gap|text-indent)$/.test(
    decodeCssIdentifier(property).toLowerCase(),
  );

const SPACING_KEYWORDS = new Set(["auto", "inherit", "initial", "revert", "revert-layer", "unset"]);

const SPACING_COMPONENT_ALLOWANCES = [
  {
    reason: "A negated spacing token preserves its scale-defined magnitude.",
    pattern: /^calc\(\s*-1\s*\*\s*var\(\s*--th-space-[\w-]+\s*\)\s*\)(?=\s|$)/,
  },
  {
    reason: "Safe-area insets are physical dimensions supplied by the browser environment.",
    pattern: /^env\(\s*safe-area-inset-(?:top|right|bottom|left)\s*\)(?=\s|$)/,
  },
] as const;

const hasOnlyAllowedSpacingComponents = (value: string): boolean => {
  let remaining = value.trim();
  if (remaining.length === 0) return false;
  while (remaining.length > 0) {
    const token = /^(?:var\(\s*--th-space-[\w-]+\s*\)|0)(?=\s|$)/.exec(remaining)?.[0];
    const keyword = /^[a-z-]+(?=\s|$)/i.exec(remaining)?.[0];
    const allowance = SPACING_COMPONENT_ALLOWANCES
      .map(({ pattern }) => pattern.exec(remaining)?.[0])
      .find((component) => component !== undefined);
    const component =
      token ??
      allowance ??
      (keyword !== undefined && SPACING_KEYWORDS.has(keyword.toLowerCase()) ? keyword : undefined);
    if (component === undefined) return false;
    remaining = remaining.slice(component.length).trimStart();
  }
  return true;
};

describe("spacing and elevation contracts", () => {
  it("declares the complete DESIGN.md spacing scale", () => {
    expect(Object.fromEntries(Array.from(tokens.matchAll(/(--th-space-[\w-]+):\s*([^;]+);/g), (match) => [match[1], match[2]?.trim()]))).toEqual({
      "--th-space-0": "0",
      "--th-space-0-5": "2px",
      "--th-space-1": "4px",
      "--th-space-2": "8px",
      "--th-space-3": "12px",
      "--th-space-4": "16px",
      "--th-space-5": "20px",
      "--th-space-6": "24px",
      "--th-space-8": "32px",
      "--th-space-9": "36px",
      "--th-space-11": "44px",
      "--th-space-12": "48px",
    });
  });

  it("allows only spacing tokens, zero, and CSS-wide spacing keywords in spacing declarations", () => {
    const violations: string[] = [];
    for (const path of stylesheetPaths.filter((path) => path !== "./tokens.css")) {
      const file = path.slice(2);
      const css = readFileSync(`src/styles/${file}`, "utf8");
      postcss.parse(css, { from: file }).walkDecls((declaration) => {
        if (!isSpacingProperty(declaration.prop) || hasOnlyAllowedSpacingComponents(declaration.value)) return;
        violations.push(
          `${file}:${declaration.source?.start?.line ?? "?"}: ${declaration.prop}: ${declaration.value.trim()}`,
        );
      });
    }
    expect(violations).toEqual([]);
  });

  it("keeps spacing, type, colour, and elevation token declarations single-source", () => {
    const violations = stylesheetPaths
      .filter((path) => path !== "./tokens.css")
      .flatMap((path) => {
        const file = path.slice(2);
        return localDesignTokenRedefinitions(file, readFileSync(`src/styles/${file}`, "utf8"));
      });
    expect(violations).toEqual([]);
  });

  it("reserves every --th-* name except exact component-owned properties", () => {
    for (const name of ["--th-info", "--th-totally-new-family", "--th-surface-oracle", "--th-chat-oracle"]) {
      expect(localDesignTokenRedefinitions("oracle.css", `.x { ${name}: red; }`)).toEqual([
        `oracle.css:1: ${name} may be declared only in tokens.css`,
      ]);
    }
    for (const name of COMPONENT_OWNED_CUSTOM_PROPERTIES.keys()) {
      expect(localDesignTokenRedefinitions("chat-pane.css", `.x { ${name}: 4px; }`)).toEqual([]);
    }
    expect(
      localDesignTokenRedefinitions(
        "chat-pane.css",
        `@property --th-brandnew { syntax: "*"; inherits: false; }`,
      ),
    ).toEqual(["chat-pane.css:1: @property --th-brandnew may be registered only in tokens.css"]);
  });

  it("normalises escaped names before enforcing design-token ownership", () => {
    expect(localDesignTokenRedefinitions("oracle.css", String.raw`.x { --th-\73 pace-oracle: 99px; }`)).toEqual([
      "oracle.css:1: --th-space-oracle may be declared only in tokens.css",
    ]);
    expect(
      localDesignTokenRedefinitions(
        "oracle.css",
        String.raw`@pr\6f perty --th-\73 pace-oracle { syntax: "<length>"; inherits: false; initial-value: 1pt; }`,
      ),
    ).toEqual(["oracle.css:1: @property --th-space-oracle may be registered only in tokens.css"]);
  });

  it("computes a 2px adjacency gap from a workspace row to its first nested session row", () => {
    const workspaceGroup = ruleBody(sessionTree, ".th-tree > .th-tree-workspace");
    const gapToken = wholeVarToken(declarationValue(workspaceGroup, "gap"));
    const computedGap = tokenValue(gapToken);
    const violations: string[] = [];
    if (
      declarationValue(workspaceGroup, "display").toLowerCase() !== "flex" ||
      declarationValue(workspaceGroup, "flex-direction").toLowerCase() !== "column"
    ) {
      violations.push("session-tree.css .th-tree > .th-tree-workspace is not a flex column");
    }
    if (computedGap !== "2px") {
      violations.push(
        `session-tree.css .th-tree > .th-tree-workspace gap resolves to ${computedGap || "no value"} ` +
          `from ${gapToken || "no spacing token"}; expected 2px`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("requests complete semantic elevation triples and consumes Overlay fill", () => {
    const levels = [
      ["terminal-header.css", termhead, ".th-termhead", "surface"],
      ["file-browser.css", fileBrowser, ".th-files", "raised"],
      ["chat-transcript.css", chatTranscript, ".th-chat-scroll-bottom", "raised"],
      ["modal-dialog.css", modal, ".th-modal", "overlay"],
    ] as const;
    const violations: string[] = [];
    for (const [file, css, selector, level] of levels) {
      const body = ruleBody(css, selector);
      const fillToken = `--th-surface${level === "surface" ? "" : `-${level}`}`;
      const borderToken = `--th-border-${level}`;
      const shadowToken = `--th-shadow-${level}`;
      if (wholeVarToken(declarationValue(body, "background")) !== fillToken) {
        violations.push(`${file} ${selector} is missing background: var(${fillToken})`);
      }
      if (!containsVarToken(body, borderToken)) {
        violations.push(`${file} ${selector} is missing var(${borderToken})`);
      }
      if (wholeVarToken(declarationValue(body, "box-shadow")) !== shadowToken) {
        violations.push(`${file} ${selector} is missing box-shadow: var(${shadowToken})`);
      }
    }
    const mobileSidebar = sidebar.match(/@media \(max-width: 768px\) \{([\s\S]*)\}\s*$/)?.[1] ?? "";
    const drawer = ruleBody(mobileSidebar, ".th-sidebar");
    if (wholeVarToken(declarationValue(drawer, "background")) !== "--th-surface-overlay") {
      violations.push("sidebar.css mobile .th-sidebar is missing background: var(--th-surface-overlay)");
    }
    if (!containsVarToken(drawer, "--th-border-overlay")) {
      violations.push("sidebar.css mobile .th-sidebar is missing var(--th-border-overlay)");
    }
    if (wholeVarToken(declarationValue(drawer, "box-shadow")) !== "--th-shadow-overlay") {
      violations.push("sidebar.css mobile .th-sidebar is missing box-shadow: var(--th-shadow-overlay)");
    }
    expect(violations).toEqual([]);
  });

  it("consumes the dedicated user surface pair for the user bubble", () => {
    // The user bubble separates authorship by its OWN surface step - one
    // above Raised - defined as --th-surface-user / --th-border-user per
    // theme. The shadow stays the Raised level (the light theme's soft lift
    // still applies; the dark theme remains shadowless).
    const body = ruleBody(chatTranscript, ".th-chat-msg--user");
    const userViolations: string[] = [];
    if (wholeVarToken(declarationValue(body, "background")) !== "--th-surface-user") {
      userViolations.push("chat-transcript.css .th-chat-msg--user is missing background: var(--th-surface-user)");
    }
    if (!containsVarToken(body, "--th-border-user")) {
      userViolations.push("chat-transcript.css .th-chat-msg--user is missing var(--th-border-user)");
    }
    if (wholeVarToken(declarationValue(body, "box-shadow")) !== "--th-shadow-raised") {
      userViolations.push("chat-transcript.css .th-chat-msg--user is missing box-shadow: var(--th-shadow-raised)");
    }
    if (declarationValue(body, "border-inline-start").toLowerCase().startsWith("3px")) {
      userViolations.push("chat-transcript.css .th-chat-msg--user must not grow an accent leading edge");
    }
    expect(userViolations).toEqual([]);
  });
});

describe("visual accessibility contracts", () => {
  it("keeps every design duration token between 120ms and 180ms", () => {
    const durations = Array.from(tokens.matchAll(/--th-dur(?:-[\w-]+)?:\s*(\d+)ms/g), (match) => Number(match[1]));
    expect(durations.length).toBeGreaterThan(0);
    expect(durations.every((duration) => duration >= 120 && duration <= 180)).toBe(true);
  });

  it("globally disables motion when reduced motion is requested", () => {
    const reducedMotion = global.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]+)\}\s*$/)?.[1];
    expect(reducedMotion).toContain("animation: none !important");
    expect(reducedMotion).toContain("transition: none !important");
    expect(allStyles).not.toContain("th-pulse");
  });

  it("keeps provider identity visible and complete at narrow widths", () => {
    expect(chatPane).not.toMatch(/\.th-provider-badge\s*\{[^}]*display:\s*none/);
    expect(newChat).toMatch(/\.th-provider-card-name\s*\{[^}]*white-space:\s*normal/);
    expect(newChat).not.toMatch(/\.th-provider-card-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it("gives modal close and action buttons 44px touch targets", () => {
    expect(modal).toMatch(/\.th-modal-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    expect(modal).toMatch(/\.th-modal \.th-btn\s*\{[^}]*min-height:\s*44px/);
  });

  it("does not retain removed placeholder styles", () => {
    expect(split).not.toContain(".th-chat-placeholder");
  });

  it("gives mobile editor Save/Close actions 44px hitboxes", () => {
    const mobileRules = fileEditor.match(/@container chat-pane \(max-width: 494px\) \{([\s\S]+)\}\s*$/)?.[1];
    expect(mobileRules).toMatch(/\.th-editor-save\s*\{[^}]*height:\s*44px/);
    expect(mobileRules).toMatch(/\.th-editor-head\s+\.th-btn-icon\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
  });

  it("keeps file downloads keyboard-visible and mobile file tree actions at 44px", () => {
    expect(fileBrowser).toMatch(/\.th-files-dl:focus-visible\s*\{[^}]*opacity:\s*1/);
    const mobileRules = fileBrowser.match(/@container chat-pane \(max-width: 494px\) \{([\s\S]+)\}\s*$/)?.[1];
    expect(mobileRules).toMatch(/\.th-files-row\s*\{[^}]*min-height:\s*44px/);
    expect(mobileRules).toMatch(/\.th-files-chevron,[^}]*\.th-files-dl\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    expect(mobileRules).toMatch(/\.th-files-dl\s*\{[^}]*opacity:\s*1/);
  });

  it("shows the current model (truncated) with a 44px hitbox on narrow panes", () => {
    // Wide (outside any container query): the settings icon is hidden, so the
    // model name + chevron show as today. Anchor before the first @container so
    // a display:none that leaks into the narrow block cannot satisfy this.
    const wide = chatPane.slice(0, chatPane.indexOf("@container"));
    expect(wide).toMatch(/\.th-model-picker-icon\s*\{[^}]*display:\s*none/);
    // Narrow: the icon stays, the model name shows truncated (capped width), and
    // the button keeps a 44x44 touch target (the 44px header does not stretch it).
    const narrow = chatPane.match(/@container chat-pane \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toMatch(/\.th-chat-pane \.th-model-picker-icon\s*\{[^}]*display:\s*inline-flex/);
    expect(narrow).toMatch(/\.th-chat-pane \.th-model-picker-label\s*\{[^}]*display:\s*block[^}]*max-width:\s*80px/);
    expect(narrow).toMatch(/\.th-chat-pane \.th-model-picker-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/);
  });

  it("keeps the mobile empty-state menu below the safe area at 44px", () => {
    // Two contracts for the empty-session hamburger, the only way to open the
    // sidebar drawer on mobile. (1) .th-empty must establish a positioning
    // context so the button's absolute offsets resolve inside the pane, below
    // #root's safe-area padding, instead of against #root's padding box where
    // the button hides under the status bar. (2) The 44px target must ride the
    // descendant selector: the bare .th-empty-menu rule only ties .th-btn-icon's
    // specificity (0,1,0) and loses to its 28px whenever icon-button.css is
    // imported later, so the size must not live on the bare rule.
    expect(appEmpty).toMatch(/\.th-empty\s*\{[^}]*position:\s*relative/);
    expect(appEmpty).toMatch(/\.th-empty \.th-empty-menu\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    expect(appEmpty).not.toMatch(/(?:^|\})\s*\.th-empty-menu\s*\{[^}]*width:\s*44px/);
  });
});

describe("chat reading rhythm and tool width contracts", () => {
  it("gives structural messages the full lane width instead of intrinsic sizing", () => {
    const base = chatTranscript.match(/\.th-chat-msg\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toMatch(/width:\s*100%/);
    expect(base).toMatch(/max-width:\s*80%/);
    const structural =
      chatTranscript.match(/\.th-chat-msg--assistant,[\s\S]*?\.th-chat-msg--streaming\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(structural).toMatch(/max-width:\s*100%/);
    expect(structural).toMatch(/padding:\s*0;/);
  });

  it("stacks assistant turn blocks with compact auxiliary rhythm and a 68ch prose measure", () => {
    const stack =
      chatTranscript.match(
        /\.th-chat-msg--assistant,\s*\.th-chat-msg--toolResult,\s*\.th-chat-msg--bashExecution,\s*\.th-chat-msg--custom\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(stack).toMatch(/display:\s*flex/);
    expect(stack).toMatch(/flex-direction:\s*column/);
    expect(stack).toMatch(/gap:\s*var\(--th-space-2\)/);
    const prose = chatTranscript.match(/\.th-chat-msg > span\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(prose).toMatch(/max-width:\s*min\(68ch,\s*100%\)/);
  });

  it("gives live streaming prose the same measure and boundary rhythm as history", () => {
    const live = chatTranscript.match(/(?:^|\})\s*\.th-chat-live\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(live).toMatch(/padding:\s*var\(--th-space-2\) 0/);
    const streaming =
      chatTranscript.match(/(?:^|\})\s*\.th-chat-msg--streaming\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(streaming).toMatch(/max-width:\s*min\(68ch,\s*100%\)/);
  });

  it("separates conversation turns by 20px total via measured row padding", () => {
    const row = chatTranscript.match(/\.th-chat-row\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(row).toMatch(/padding:\s*var\(--th-space-2\) 0/);
  });

  it("keeps the 760px lane, user right alignment, and Body-tier message text", () => {
    expect(chatPane).toMatch(/--th-chat-max:\s*760px/);
    expect(chatTranscript).toMatch(/\.th-chat-row--user\s*\{[^}]*justify-content:\s*flex-end/);
    const base = chatTranscript.match(/\.th-chat-msg\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toMatch(/font-size:\s*var\(--th-type-body-size\)/);
    expect(base).toMatch(/line-height:\s*var\(--th-type-body-line\)/);
  });

  it("does not draw an inset focus ring along chat pane edges", () => {
    expect(split).not.toMatch(/\.th-pane--focused\s*\{[^}]*box-shadow:/);
  });

  it("sizes tool chrome at the Label tier and tool output at the Secondary tier", () => {
    const head = toolCard.match(/\.th-tool-head\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(head).toMatch(/font-size:\s*var\(--th-type-label-size\)/);
    const preview = toolCard.match(/\.th-tool-preview\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(preview).toMatch(/font-size:\s*var\(--th-type-label-size\)/);
    const body = toolCard.match(/\.th-tool-body\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body).toMatch(/font-size:\s*var\(--th-type-secondary-size\)/);
    expect(body).toMatch(/line-height:\s*var\(--th-type-secondary-line\)/);
  });

  it("caps the tool output region at min(360px, 45dvh) with internal scrolling", () => {
    // DESIGN.md: an internally scrollable output region, so a long execution
    // cannot take over the conversation scrollport.
    const output = toolCard.match(/\.th-tool-output\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(output).toMatch(/max-height:\s*min\(360px,\s*45dvh\)/);
    expect(output).toMatch(/overflow:\s*auto/);
  });

  it("gives the tool header the contract's geometry and tier mix", () => {
    const head = toolCard.match(/\.th-tool-head\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(head).toMatch(/min-height:\s*var\(--th-space-12/);
    expect(head).toMatch(/padding:\s*var\(--th-space-2[^}]*var\(--th-space-3/);
    expect(head).toMatch(/gap:\s*var\(--th-space-0-5/);
    const status = toolCard.match(/\.th-tool-status\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(status).toMatch(/font-size:\s*var\(--th-type-micro-size\)/);
    const caption = toolCard.match(/\.th-tool-caption\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(caption).toMatch(/font-size:\s*var\(--th-type-micro-size\)/);
    const io = toolCard.match(/\.th-tool-io\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(io).toMatch(/font-family:\s*var\(--th-font-mono\)/);
  });

  it("keeps the tool block at Surface elevation with an inset Canvas body and no shadow", () => {
    const block = toolCard.match(/\.th-tool\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/background:\s*var\(--th-surface\)/);
    expect(block).toMatch(/border:\s*1px solid var\(--th-border\)/);
    expect(block).toMatch(/border-radius:\s*var\(--th-radius-sm\)/);
    expect(block).not.toMatch(/box-shadow/);
    const body = toolCard.match(/\.th-tool-body\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body).toMatch(/background:\s*var\(--th-bg\)/);
    expect(body).toMatch(/padding:\s*var\(--th-space-3/);
    expect(body).toMatch(/gap:\s*var\(--th-space-3/);
  });

  it("gives every tool status a distinct non-colour glyph treatment", () => {
    const running = toolCard.match(/\.th-tool-glyph--running\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(running).toMatch(/border-radius:\s*50%/);
    expect(running).toMatch(/animation:\s*th-tool-spin/);
    expect(toolCard).toContain(".th-tool-glyph--ok");
    expect(toolCard).toContain(".th-tool-glyph--error");
  });
});

describe("sidebar density and top-bar hierarchy contracts", () => {
  it("packs sidebar rows at 36px with 8px inline padding, 8px icon gap, and 2px between rows", () => {
    const node = sessionTree.match(/\.th-tree-node\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(node).toMatch(/min-height:\s*var\(--th-space-9/);
    expect(node).toMatch(/padding:\s*0 var\(--th-space-2/);
    expect(node).toMatch(/gap:\s*var\(--th-space-2/);
    const children = sessionTree.match(/\.th-tree-children\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(children).toMatch(/gap:\s*var\(--th-space-0-5/);
  });

  it("grows sidebar rows to 44px on a coarse pointer without changing the text tier", () => {
    const coarse =
      sessionTree.match(/@media \(pointer: coarse\)\s*\{\s*\.th-tree-node\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(coarse).toMatch(/min-height:\s*var\(--th-space-11/);
    expect(coarse).not.toContain("font-size");
  });

  it("sets the session name at Secondary and demotes the metadata badge to Micro", () => {
    const label = sessionTree.match(/(?:^|\n)\s*\.th-tree-label\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(label).toMatch(/font-size:\s*var\(--th-type-secondary-size\)/);
    const badge = sessionTree.match(/\.th-tree-source\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(badge).toMatch(/font-size:\s*var\(--th-type-micro-size\)/);
    // The selected row changes only to emphasize weight - never size or colour.
    const active = sessionTree.match(/\.th-tree-node--active \.th-tree-label\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(active).toMatch(/font-weight:\s*var\(--th-weight-emphasize\)/);
    expect(active).not.toMatch(/font-size|color/);
  });

  it("anchors the top bar with a Secondary/emphasize title and Label metadata", () => {
    const name = termhead.match(/\.th-termhead-name\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(name).toMatch(/font-size:\s*var\(--th-type-secondary-size\)/);
    expect(name).toMatch(/font-weight:\s*var\(--th-weight-emphasize\)/);
    const path = termhead.match(/\.th-termhead-path\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(path).toMatch(/font-size:\s*var\(--th-type-label-size\)/);
    // Provider metadata joins the path/model tier as quiet Label text, never
    // an uppercase pill that outranks the session name.
    const provider = termhead.match(/\.th-termhead \.th-provider-badge\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(provider).toMatch(/text-transform:\s*none/);
    expect(provider).not.toMatch(/text-transform:\s*uppercase/);
  });

  it("scopes KaTeX output to the surrounding tier and theme tokens", () => {
    // Formulas must follow the design system in both themes: size and colour
    // are inherited, the only override re-tokens KaTeX's hardcoded error
    // colour, and the file introduces no literal colour of its own.
    expect(math).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const katex = math.match(/\.th-chat-markdown \.katex\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(katex).toMatch(/color:\s*inherit/);
    expect(katex).toMatch(/font-size:\s*var\(--th-type-body-size\)/);
    const error = math.match(/\.th-chat-markdown \.katex-error\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(error).toMatch(/color:\s*var\(--th-error\)/);
  });
});
