# omo-webchat interface contract

## Product shape

omo-webchat is a desktop-first agent chat client inside a workspace shell. The
sidebar organizes workspaces and chat sessions. The main pane is a focused
conversation surface. It must feel like a normal modern chat product, never a
terminal emulator and never a collection of disconnected cards.

## Personality

omo-webchat should feel like a focused, high-agency coding workstation: direct,
precise, dense enough for sustained use, and calm enough that conversation stays
primary. As a local, single-user coding-agent workstation, it should feel
immediate and owned rather than account-oriented or administrative. Its
boldness comes from decisive hierarchy, crisp typography, and clearly bounded
execution, not decoration, oversized chrome, or brand theatrics. It must not
feel like a SaaS dashboard, a terminal emulator, or a generic stack of
interchangeable gray cards.

## Design source

Three references govern this redesign:

- **Golo dark** (`/tmp/refshots/golo0.jpg`, `/tmp/refshots/golo1.jpg`): the
target dark chat material. Layered cool-tinted graphite fills, transparent
assistant prose, a quiet user pill, tonal separation through hairline borders
rather than stacked 1px frames, and a single violet accent reserved for live
agent states.
- **Orbita light** (`/tmp/refshots/orbita_mid.jpg`): the target light theme
and the choreography reference. Light surfaces separate by shadow and a
top-edge highlight instead of fill jumps, and floating layers read as glass
above the canvas.
- **StyleGallery** (link only: https://github.com/changeroa/StyleGallery):
not a visual source. Its scroll-ownership discipline informs the Spatial
structure section below: every scrollable region has exactly one owner and
scroll chaining is deliberate, never incidental. Its motion decision method
is how we decide what may move: a motion earns its place only when it answers
a concrete purpose, uses the shortest duration that still reads, and ships an
authored reduced-motion equivalent. These ideas are restated here in our own
words; no prose or assets are copied.

Earlier calibration against a captured native desktop chat app is
superseded: the palette in this document now comes from the token contract v2
(`.omo/plans/visual-redesign-tokens.md`) and the visual references above.

## Colour reference

Surface, text, and border colours come from the token contract v2
(`.omo/plans/visual-redesign-tokens.md`, binding). Dark is `:root`, light is
`[data-theme="light"]`. All values below are the contract; only text-tier,
status, and border hex values may be adjusted, and only to satisfy the
contrast rules in the theme contract. `--th-bg` and `--th-accent` are pinned.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--th-bg` | `#17181b` | `#ffffff` | App canvas |
| `--th-surface` | `#1d1e22` | `#f7f7f8` | Sidebar, top bar, tool timeline body, shelf |
| `--th-surface-composer` | `#232429` | `#ffffff` | Composer capsule; light separates by shadow |
| `--th-surface-raised` | `#25262b` | `#ffffff` | Cards, menus solid fallback |
| `--th-surface-user` | `#2a2b31` | `#f1f1f3` | User pill bubble |
| `--th-surface-overlay` | `#25262b` | `#ffffff` | Solid fallback for overlays |
| `--th-glass` | `rgba(38,39,44,0.72)` | `rgba(255,255,255,0.72)` | Floating layers only: popovers, palettes, menus, modal panel |
| `--th-glass-filter` | `blur(20px) saturate(1.5)` | `blur(20px) saturate(1.8)` | With `@supports (backdrop-filter: blur(1px))`; fallback is solid `--th-surface-overlay` |
| `--th-tool-surface` | `#1d1e22` | `#f7f7f8` | Executed tool record material |
| `--th-tool-border` | `rgba(255,255,255,0.06)` | `rgba(24,24,27,0.06)` | Tool record hairline |
| `--th-hover` | `#2c2d33` | `#f1f1f3` | Hover fill |
| `--th-active` | `#34353c` | `#e9e9ec` | Active and selected fill |
| `--th-border-surface`, `--th-border-raised` | `rgba(255,255,255,0.06)` | `rgba(24,24,27,0.07)` | Default hairline |
| `--th-border-user`, `--th-border-overlay`, `--th-border-strong` | `rgba(255,255,255,0.10)` | `rgba(24,24,27,0.12)` | Strong hairline |
| `--th-text` | `#ededf0` | `#18181b` | Primary text |
| `--th-text-dim` | `#c4c4cc` | `#3f3f46` | Secondary text |
| `--th-muted` | `#a1a1aa` | `#5f5f68` | Muted text; 4.5:1 on every fill including hover and active |
| `--th-faint` | `#71717a` | `#8b8b94` | Metadata only; 3.0:1, allowlist enforced by test |
| `--th-disabled-fg`, `--th-disabled-bg` | derived | derived | Disabled text and fill, derived from tested pairs |
| `--th-accent` | `#8b7cf6` | `#6d5bd0` | Agent-alive text, glyph, ring, indicator |
| `--th-accent-hover` | `#9d90f8` | `#5b49c2` | Accent hover |
| `--th-accent-solid` | `#6d5bd0` | `#6d5bd0` | Filled controls: send, primary button, toggles |
| `--th-accent-solid-hover` | `#5b49c2` | `#5b49c2` | Filled control hover |
| `--th-accent-fg` | `#ffffff` | `#ffffff` | Text on `--th-accent-solid`, 4.5:1 |
| `--th-accent-soft` | `color-mix(in srgb, var(--th-accent) 14%, transparent)` | same | Selection wash |
| `--th-accent-glow` | `color-mix(in srgb, var(--th-accent) 35%, transparent)` | same | Halo (running node) |
| `--th-send` | `var(--th-accent-solid)` | same | Send/stop slot fill |
| `--th-send-hover` | `var(--th-accent-solid-hover)` | same | Send hover |
| `--th-send-fg` | `#ffffff` | `#ffffff` | Send glyph |
| `--th-ring` | `color-mix(in srgb, var(--th-accent) 55%, transparent)` | same | Focus ring |
| `--th-error`, `--th-success`, `--th-warning` (+ `-bg`, `-fg`) | theme-scoped, hue identity kept | same names | Status hues, lightness adjusted to the contrast matrix |
| `--th-shadow-surface` | `0 1px 2px rgba(0,0,0,.28), 0 4px 12px rgba(0,0,0,.16)` | `0 1px 2px rgba(24,24,27,.04), 0 4px 12px rgba(24,24,27,.05)` | Persistent chrome |
| `--th-shadow-raised` | `0 2px 6px rgba(0,0,0,.24), 0 10px 28px -8px rgba(0,0,0,.45)` | `0 1px 3px rgba(24,24,27,.06), 0 10px 28px -10px rgba(24,24,27,.14)` | Cards, composer, user bubble |
| `--th-shadow-overlay` | `0 8px 20px rgba(0,0,0,.30), 0 28px 64px -16px rgba(0,0,0,.60)` | `0 8px 20px rgba(24,24,27,.08), 0 28px 64px -16px rgba(24,24,27,.22)` | Floating layers, modals |
| `--th-highlight` | `inset 0 1px 0 rgba(255,255,255,.05)` | `inset 0 1px 0 rgba(255,255,255,.7)` | Top edge light on raised and overlay surfaces |
| `--th-backdrop` | `rgba(10,10,12,.55)` | `rgba(24,24,27,.24)` | Overlay scrim |

Accent usage is narrow and binding: violet appears only for agent-alive
states. Those are a running or streaming session (running glyphs, the DAG
running halo and comet), focus rings and selection, and the send/primary
filled controls. Everything else, including status hues, stays inside the
cool monochrome ladder.

Text tiers are binding: `--th-text`, `--th-text-dim`, and `--th-muted` meet
4.5:1 on every fill in both themes, hover and active included.
`--th-faint` is metadata-only at 3.0:1 on bg, surface, composer, raised, and
tool fills; the contract test enumerates its allowed selectors and fails any
faint text outside the allowlist. Status hues used as text keep their hue
identity but are lightened or darkened as needed to pass the same matrix.
Contrast wins over reference fidelity everywhere these two disagree; the
deviation is deliberate and tested, not a taste call.

## Tokens

The `--th-*` application tokens are the canonical source; the values live in
the colour reference above and in `frontend/src/styles/tokens.css`, which is
the only file that may declare palette values. Chat and shell styles must not
create a second competing global palette.

| Role | Token |
| --- | --- |
| App canvas | `--th-bg` |
| Sidebar / top bar / shelf | `--th-surface` |
| Tool block material | `--th-tool-surface`, `--th-tool-border` |
| Composer capsule | `--th-surface-composer` |
| Raised card / menu solid fallback | `--th-surface-raised` |
| User bubble | `--th-surface-user` |
| Overlay solid fallback | `--th-surface-overlay` |
| Floating glass fill and filter | `--th-glass`, `--th-glass-filter` |
| Hover / active | `--th-hover`, `--th-active` |
| Default hairline | `--th-border-surface`, `--th-border-raised` |
| Strong hairline | `--th-border-user`, `--th-border-overlay`, `--th-border-strong` |
| Text tiers | `--th-text`, `--th-text-dim`, `--th-muted`, `--th-faint` |
| Disabled | `--th-disabled-fg`, `--th-disabled-bg` |
| Accent (agent-alive only) | `--th-accent`, `--th-accent-hover` |
| Accent filled controls | `--th-accent-solid`, `--th-accent-solid-hover`, `--th-accent-fg` |
| Accent wash, halo, ring | `--th-accent-soft`, `--th-accent-glow`, `--th-ring` |
| Composer send action | `--th-send`, `--th-send-hover`, `--th-send-fg` |
| Status | `--th-error`, `--th-success`, `--th-warning` (+ `-bg`, `-fg`) |
| Elevation shadows | `--th-shadow-surface`, `--th-shadow-raised`, `--th-shadow-overlay` |
| Top-edge highlight | `--th-highlight` |
| Overlay scrim | `--th-backdrop` |
| Radius | `--th-radius-xs`, `--th-radius-sm`, `--th-radius`, `--th-radius-lg`, `--th-radius-xl`, `--th-radius-pill` |
| Type stacks | `--th-font-sans`, `--th-font-mono` |
| Motion | `--th-dur-fast`, `--th-dur`, `--th-dur-slow`, `--th-dur-emph`, `--th-ease`, `--th-ease-out`, `--th-ease-in-out`, `--th-ease-spring` |

Radius follows a scale, not a single small value: 6, 8, 12, 16, 24, and pill.
The concentric rule binds nested rounded surfaces: an inner radius equals the
outer radius minus the padding between them, with 6px as the floor. A 16px
user bubble padded 12px therefore carries a 4px-plus-floor treatment on inner
attachments, and a 24px modal panel inset by 12px gets 12px inner radii.

## Type scale

`--th-font-size` is the user-controlled base for the entire scale. Define the
size, line-height, and tracking values below once in `tokens.css` as
`--th-type-<tier>-size`, `--th-type-<tier>-line`, and
`--th-type-<tier>-tracking`; component styles consume those tokens as a complete
style. The three allowed text weights are `--th-weight-read: 400`,
`--th-weight-emphasize: 510`, and `--th-weight-announce: 590`. Fonts without an
exact intermediate weight use the browser's nearest available face; components
must not substitute ad hoc `500`, `600`, or `700` values.

| Tier | Size relative to `--th-font-size` | Weight | Line-height | Letter-spacing | Job |
| --- | --- | --- | --- | --- | --- |
| Display | `calc(var(--th-font-size) * 1.7143)` | 590 | 1.15 | `-0.025em` | Empty-state or page-level statement; never routine chrome |
| Title | `calc(var(--th-font-size) * 1.2857)` | 590 | 1.25 | `-0.018em` | Modal and content-section titles |
| Input | `calc(var(--th-font-size) * 1.1429)` | 400 | 1.4 | `-0.008em` | Composer text and editable primary input |
| Body | `var(--th-font-size)` | 400 | 1.65 | `-0.005em` | Conversation prose and explanatory copy |
| Secondary | `calc(var(--th-font-size) * 0.9286)` | 400 | 1.45 | `0` | Dense navigation and execution output |
| Label | `calc(var(--th-font-size) * 0.8571)` | 510 | 1.35 | `0.01em` | Control, field, and compact block labels |
| Micro | `calc(var(--th-font-size) * 0.7857)` | 510 | 1.3 | `0.02em` | Status and terse metadata only |

The base is user-owned and never restyled globally: app-config applies the
user's font-size setting inline on `<html>` (default 13px, clamped 10-24),
while the `--th-font-size: 14px` declared in `tokens.css` is only the
pre-hydration fallback. The approved 14px-vs-15px prose comparison resolves
through the tier system, not a base bump: raising the fallback or the app
default would resize every chrome surface at once and fight the user's own
scaling. A 15px user setting must move the entire hierarchy, which the
scaling evidence scenario pins.

The sans stack is Pretendard Variable, vendored as the dynamic-subset woff2
build with `font-display: swap`. Pretendard carries Korean and Latin in one
family with exact intermediate weights, so the 510 and 590 tiers resolve to
real faces instead of browser-synthesized approximations and Korean text no
longer falls back to an OS-dependent rendering. All user-readable text uses
`--th-font-sans`; the body tier line-height is 1.65. The mono
stack is restricted to code, paths, tool input and output, and identifiers. It
never sets UI labels, counts, badges, buttons, or chrome. No UI label uses
`text-transform: uppercase`; hierarchy comes from weight, size, and colour,
never from case. Component CSS must use a named tier for every text
`font-size`, never a raw `px`, `rem`, or `em` font size. This rule makes a change
to `--th-font-size` move the full hierarchy rather than only inherited body
text.

Major surfaces use the scale as follows:

- Chat message prose is Body; markdown headings use Title for `h1` and the
  announce weight at Body size for lower headings.
- A tool-execution block uses Label for its header and Secondary in its expanded
  body; command, argument, and output text use the mono stack.
- A sidebar row is Secondary at read weight; the selected row changes only to
  emphasize weight. Section captions and counts are Micro.
- The top bar's primary title is Secondary at emphasize weight; path, provider,
  and model metadata are Label.
- Composer input is Input; attachment and queued-state metadata are Label.
- A modal uses Title for its heading, Body for explanatory copy, Label for
  controls and field labels, and Secondary for supporting metadata.

## Spacing scale

The spacing base unit is 4px. Margins, padding, layout gaps, and indentation use
only the following tokens; a 1px optical stroke and explicit structural sizes
such as pane widths or output height caps are not spacing.

| Token | Value | Units |
| --- | --- | --- |
| `--th-space-0` | 0 | 0 |
| `--th-space-0-5` | 2px | 0.5 |
| `--th-space-1` | 4px | 1 |
| `--th-space-2` | 8px | 2 |
| `--th-space-3` | 12px | 3 |
| `--th-space-4` | 16px | 4 |
| `--th-space-5` | 20px | 5 |
| `--th-space-6` | 24px | 6 |
| `--th-space-8` | 32px | 8 |
| `--th-space-9` | 36px | 9 |
| `--th-space-11` | 44px | 11 |
| `--th-space-12` | 48px | 12 |

Desktop sidebar rows are compact: 36px minimum height, 8px inline padding, 8px
between icon and label, and 2px between adjacent rows. On a coarse pointer they
become 44px minimum-height targets without increasing their text tier.
Tool-execution disclosure headers are 48px minimum height with 8px block and
12px inline padding, a 2px gap between their two text lines, and 8px between
adjacent blocks. Expanded tool regions use 12px padding and a 12px gap between
input and output sections; density does not change between themes.

## State encoding

State is never encoded with a coloured border or stroke. The only coloured
edge in the app is the focus ring (`box-shadow: 0 0 0 3px var(--th-ring)`):
no component changes border-color or SVG stroke to a status or accent hue to
say running, selected, failed, or active. Selection and active states use a
wash (`--th-accent-soft` where the accent rule allows it, otherwise
`--th-active`) plus a glyph. Two selection idioms exist and are not
interchangeable: an item chosen from a list or option set (palette row,
approval option, provider card, file row) takes the `--th-accent-soft` wash
plus a check or active glyph; a segmented control (theme, language,
List/Graph, shelf tabs) marks its current segment with one neutral raised
thumb (`--th-surface-raised` or `--th-active` with `--th-shadow-surface` and
`--th-highlight`) because every segment is always a valid value, not an
agent-alive state. Status uses a glyph plus a localized word, with
color as a redundant third cue. Error alerts and `:focus-visible` rings are
the contract's only coloured outlines, and both are exceptions, not patterns
to copy.

## Elevation ladder

Elevation is a semantic relationship. Components request one of the levels
below and use its fill, border, shadow, and highlight tokens together; they
never invent a lighter fill or attach an unscoped shadow. Hover, selection,
focus, and status are state treatments on a level, not extra elevation
levels.

| Level and tokens | Job | Technique in both themes |
| --- | --- | --- |
| Canvas / `--th-bg` | Base application and transcript; also an inset output well inside a tool block | No border or shadow |
| Surface / `--th-surface`, `--th-shadow-surface` | Persistent elevated chrome: sidebar, top bar, activity shelf | One luminance step above canvas, `--th-shadow-surface` |
| Tool block / `--th-tool-surface`, `--th-tool-border` | Executed tool records in both disclosure states; the expanded body insets Canvas | Scoped fill behind a hairline, no shadow; the output well inside reads as a canvas inset |
| Composer / `--th-surface-composer`, `--th-shadow-raised`, `--th-highlight` | The composer capsule only | Separates from the canvas by shadow and top-edge highlight; the light fill is white so the shadow and highlight carry the separation alone |
| Raised / `--th-surface-raised`, `--th-shadow-raised`, `--th-highlight` | Cards, file panels, and floating controls that sit above the canvas | Solid fill with the raised shadow and top-edge highlight |
| Floating glass / `--th-glass`, `--th-glass-filter`, `--th-border-overlay`, `--th-shadow-overlay`, `--th-highlight` | Popovers, palettes, menus, and the modal panel: surfaces that read as material floating above whatever is behind them | Glass fill plus backdrop filter under `@supports (backdrop-filter: blur(1px))`, with `--th-surface-overlay` as the solid fallback; the overlay shadow and highlight sell the lift. Glass is confined to floating layers; nothing structural is ever glass. Radius is `--th-radius-lg` for menus and palettes and `--th-radius-xl` for the modal panel |
| User / `--th-surface-user`, `--th-border-user`, `--th-shadow-raised` | The user chat bubble only: an authorship surface one visible step above Raised | Strong hairline plus the raised shadow, so the bubble separates at a glance without accent decoration |
| Overlay / `--th-surface-overlay` (or glass), `--th-shadow-overlay`, `--th-highlight`, `--th-backdrop` | Modal dialogs and blocking drawers that must separate from every pane | Solid or glass panel with the overlay shadow, top-edge highlight, and the theme-scoped scrim |

Hover, selection, focus, and status stay state treatments on a level.
`--th-hover` is one luminance step from the surface in each theme's own
direction; `--th-active` steps further, toward the foreground mix in light and
toward white in dark.

Raised and floating surfaces also carry `--th-highlight`, an inset 1px top
edge light: subtle in dark, strong in light. It replaces the old habit of
stacking extra borders to show elevation. Dark is not shadowless: the dark
shadow values above are the contract, resolved per theme.

All chromatic and effect tokens live in both theme scopes (dark on `:root`,
light on `[data-theme="light"]`), both scopes declare exactly the same token
names with their matching `color-scheme`, and switching themes changes values,
never which tokens a component requests. `--th-ring` is a theme-resolved
accent-alpha focus treatment, never a white lift.

## Theme contract

Every palette choice and color-bearing effect is declared in
`frontend/src/styles/tokens.css`. Component styles contain no literal hex,
RGB(A), HSL(A), named palette color, or theme-specific `color-mix()`; they use a
semantic token instead. `transparent` and `currentColor` are allowed because
they introduce no palette choice. Dark and light scopes define exactly the same
color, state, elevation, focus, status, and shadow token names, and each scope
sets its matching `color-scheme`; switching themes changes values, never which
tokens a component requests. Both themes follow the measured reference fills:
dark resolves the layered-graphite direction through the captured dark values,
and the light theme uses the measured white surfaces with foreground-alpha
borders and shadows rather than a warm luminance ladder.

An automated token test parses both theme scopes, asserts that their token
name sets are identical, resolves alpha and `color-mix()` values against the
intended background, and enforces contrast in both themes:

- `--th-text`, `--th-text-dim`, and `--th-muted` hold a minimum WCAG contrast
  ratio of 4.5:1 on every fill they may appear on: `--th-bg`, `--th-surface`,
  `--th-surface-composer`, `--th-surface-raised`, `--th-surface-user`,
  `--th-surface-overlay`, `--th-hover`, `--th-active`, the tool material, and
  every status background. There is no 3:1 large-text exception because the
  same semantic tokens can appear at Label or Micro size.
- `--th-faint` is metadata-only and held to 3.0:1 on the bg, surface,
  composer, raised, and tool fills. The contract test enumerates the allowed
  faint selectors; faint text anywhere outside that allowlist fails the build.
- `--th-accent-fg` holds 4.5:1 on `--th-accent-solid` and
  `--th-accent-solid-hover`.
- `--th-error`, `--th-success`, and `--th-warning` used as text hold 4.5:1 on
  their own status backgrounds and on every elevation fill on which the status
  may appear; `--th-error-fg` holds 4.5:1 on solid `--th-error` fills,
  including Stop.
- `--th-send-fg` holds 4.5:1 on `--th-send` and `--th-send-hover`. An earlier
  icon-only 3:1 exception for the send glyph is retired: the slot fill is now
  `--th-accent-solid`, so the pair is held to the full text requirement.

Opacity on a parent is not an acceptable way to create secondary or disabled
text, because it makes the effective contrast depend on whatever is behind it.
Choose a tested foreground/background token pair instead.

## Geometry

- Sidebar: fixed shell width from `--th-sidebar-w` (264px at the default
  scale; validate that rows, badges, and pagination fit without clipping at
  this width). The shell follows the fixed-sidenav-shell pattern: the sidebar
  column stays stable while the pane work area scrolls independently, and the
  work area is a shrinkable `minmax(0, 1fr)`-style track beside the fixed
  sidebar column so panes never inherit horizontal overflow. The expanded
  sidebar has no separate navigation
  rail: collapse lives inside the sidebar toolbar (`.th-sidebar-nav`) as one
  of its trailing actions, so the expanded shell allocates zero width outside
  the content column. The collapsed state keeps a 44px rail
  (`--th-space-11`) whose only job is the reopen toggle; the toggle never
  overlaps pane titles in either state. Mobile retains its dismissible
  overlay drawer without the rail. The shared `--th-space-11` token is the
  coarse-pointer touch size and must not be re-valued to remove the expanded
  rail; only the expanded shell's allocation changes. The mobile drawer is
  sized and positioned to the visible surface: in an installed PWA, sidebar,
  drawer and backdrop consume the visual viewport's actual height and origin
  whether the keyboard is open or closed, without repeating the translation
  already supplied by `#root`. Background painting never justifies
  extending these interactive surfaces beyond the actual visible bounds.
  The desktop sidebar also follows the visible bottom. The sidebar shell reserves the bottom
  home-indicator inset at every width (`env(safe-area-inset-bottom)` — zero
  wherever the hardware has none, and the only protection on landscape phones
  beyond the 768px drawer breakpoint, where `#root` intentionally keeps a 0
  bottom inset for the full-bleed input bar). While the software keyboard is
  open the bottom inset is dropped (`html[data-th-keyboard-open]`) because
  the keyboard covers the gesture zone. The settings/logout row ends exactly
  at the usable visible bottom: footer bottom padding is zero at every width,
  leaving only the shell's necessary safe inset. The footer spacer stretches
  that row horizontally and never adds vertical reserve. The upward-opening Settings panel budgets its height from
  the visual viewport minus the safe top, the necessary closed-state bottom
  inset, and its footer anchor/offset. The keyboard marker releases only the
  obsolete bottom contribution, never top protection. Overflow belongs to the
  Settings interior so every control remains fully visible and hit-testable
  when scrolled into view, without scrolling or escaping clipping ancestors.
- Installed PWA surface: on the recorded installed device (iPhone 13 mini,
  iOS 26.6.1) the screen and large viewport measure 812 CSS px tall while
  the dynamic viewport and visual viewport measure 762. That is an observed
  geometry split from one resting device, not a native usable-height
  authority and not a claim about how WebKit computes those values
  internally. The intended contract: in standalone mode, `#root` follows
  the actual visible bounds, the VisualViewport height and origin
  (`--th-vh-unit`, `--th-vv-top`/`--th-vv-left`), with the origin applied
  exactly once, whether the keyboard is open or closed. The shell
  background, drawer and backdrop paint within those same visible bounds;
  background coverage is never a reason to enlarge the interactive layout
  beyond what is actually visible. Control-safe space is reserved once,
  inside the surface, never by shortening or lengthening a painted
  background: the composer stays full-bleed while its internal bottom
  reserve is the larger of its existing breathing padding and the necessary
  `env(safe-area-inset-bottom)`, and the sidebar keeps its single existing
  inset reserve with zero footer bottom padding. While the software
  keyboard is open the bottom inset reserves are released because the
  keyboard covers the gesture zone. Keyboard dismissal, rotation and
  foreground restoration re-publish current geometry without corrupting a
  compatible unobscured baseline, and recovery preserves focus and draft
  text. The raw visual variables keep their visual-viewport meaning for
  existing dialog and Settings consumers, and ordinary browsers keep the
  dynamic-viewport policy.
- Chat pane: fills all remaining width and height with no horizontal overflow.
- Header: full pane width, `--th-header-h`, one border at its bottom.
- Conversation scrollport: fills all space between header and composer.
- Goal and activity panels share one column allocator. Fixed bands include
  dynamically mounted queue, recovery/error banners, status and composer.
  Neither rendered panel allocation is an input to the other. The goal uses
  its intrinsic content preference; activity retains its saved height or the
  280px default preference. Reserve 120px for conversation when feasible,
  allocate goal first while retaining a 48px activity row, and collapse a goal
  allocation below 48px without losing the user's expansion intent. Activity
  likewise hides an unreadable panel while retaining its resize grip and saved
  preference, restoring the panel automatically when space returns. The grip
  owns the activity panel gap for the entire open intent, including hidden
  panels. Registration and preference changes recompute the complete shelf
  set; saved/requested sizes remain independent of viewport allocations.
- Activity shelf anatomy: there is no combined summary row and no separate
  fold control; the tabs themselves are the selector and the toggle. When
  any activity exists, three equal primary tabs in user order
  (Todo / Subagents / DAG) sit in a `tablist` with compact per-domain counts;
  empty tabs keep their position and show a proper empty state. Activating
  the already-active tab while the shelf is open closes it; activating
  another tab while open switches to it. Enter and Space toggle the focused
  tab, while Arrow/Home/End move selection and focus across tabs. Initial
  selection is the first available content in user order; after an explicit
  choice, new activity never steals the selection. All three tabpanels stay
  mounted (hidden tabs carry `hidden`), so per-view scroll state and DOM
  identity survive switching, and hidden panels run no motion. Open intent,
  tab selection, DAG view mode and the user's panel height are four separate
  states: opening, closing, resizing and switching tabs never reset each
  other. Real tab semantics: roving tabindex,
  `aria-selected`/`aria-controls`/`tabpanel` wiring.
- Activity DAG view: graph is the default; the List mode remains available
  inside the DAG tab and the choice survives tab switches and open/close
  toggles. Nodes
  reuse the parsed waves/layering and size their boxes/row pitch to the user's
  type setting. Actual SVG glyph widths determine two-line title wrapping;
  separate line clips protect the status lane, and the full prompt stays in
  the `<title>`. Nodes expose their state as visible text plus a
  non-colour glyph. Edges are directional (arrowhead markers). Edges and
  arrowheads from a completed source are green; every other edge stays gray.
  Green means dependency satisfaction, never destination success. Edge flow
  animates only from a completed source to a running destination, only in
  the active Graph view while a run is running; flow stops under reduced
  motion, in hidden or closed panels, in List mode, and once the run reaches
  a terminal state. Motion is
  state-purposeful only: the running node's dashed ring stays transparent
  and rotates while the
  node is running and visible; a completion or failure plays one brief
  settle; a genuinely new node plays one restrained entry. No elapsed-time
  tick, tab switch, or reopen replays the graph: completion, cancellation
  and leaving the graph consume one-shot motion. Reduced motion shows the
  static glyph/word state. The peer tabs remain visible even when inner panel
  headers are hidden for lack of headroom.
- The content shell between header and composer owns auxiliary overflow only
  when fixed bands exceed the column. Banners, shelves, queue and recovery
  actions remain reachable by scrolling; the transcript retains its normal
  independent scrollport when space permits. No auxiliary band is clipped to
  make the composer fit.
- Reading column: `min(760px, 100%)`, horizontally centered. Structural
  containers remain full-width; only message content is constrained.
- Composer: full-width structural footer with its controls in the same centered
  reading column. Bottom breathing room is an internal, painted reserve,
  never a shortened background: 4px base, 16px on fine-pointer desktop.
  Whenever the keyboard is closed, the total bottom reserve is
  `max(base breathing, env(safe-area-inset-bottom))`, never their sum and
  never less than the base. The unchanged base padding stays, and an empty
  in-flow physical-reserve slot (a `flex: none` `::after` item at the end
  of the composer form) adds only the shortfall, `max(0, inset - base)`.
  The slot is not standalone-gated: an ordinary browser with a real bottom
  inset gets the same single reserve, while `#root` keeps its ordinary
  `100dvh` height policy. While the keyboard is open the slot is absent and
  only the base padding remains, because the keyboard covers the gesture
  zone.
- The composer is one unified capsule: a single `--th-surface-composer` pill
  (`--th-radius-pill`, one `--th-border-surface` outline) that owns the plus
  attachment action, the multiline input, and the send/stop slot. The capsule
  is the only focus surface — its border strengthens and a ring appears on
  `:focus-within`; the textarea itself is bare and borderless.
- The input grows from one line to a 160px cap; controls stay bottom-anchored
  while it grows. The actual column further bounds the editor to its height
  minus 200px, with a 44px usable floor. This leaves room for composer chrome
  and the auxiliary scroll band in short/split columns; taller columns recover
  the normal cap without losing the multiline draft.
- File browser: absolute right-side overlay on desktop and full-pane overlay on
  narrow screens. Opening it must not change the chat pane flex axis.
- Split panes: each pane independently obeys this geometry down to 420px. Below
  that width, low-priority header metadata collapses before controls overflow.
- Pane dividers are 4px structural separators (`--th-border-surface` fill)
  between split children: `col-resize` on horizontal splits, `row-resize` on vertical
  splits. A divider is a real focusable control (`separator` semantics with
  `aria-orientation`, `aria-valuemin/max/now`), never a decorative hit strip.
  Hover, active drag, and keyboard focus all strengthen the divider fill to
  `--th-accent` and reveal a centered handle grip so the target reads as one
  control; the focus treatment is the divider's own, distinct from the pane
  active outline and from composer focus. The divider advertises an
  axis-appropriate keyboard hint (its accessible description names the arrows
  that move it: Left/Right on a horizontal split, Up/Down on a vertical one).
  Keyboard geometry: Arrow keys move
  5 percentage points along the split axis (Left/Up decrease, Right/Down
  increase), Home and End jump to the clamped bounds, and Escape returns
  focus to the pane control that opened divider adjustment. Keyboard-only
  users reach the divider through the pane's resize action, never by walking
  the transcript. There is no snapping and no numeric percentage input.
- Resize overlays: while a divider is dragged OR holds keyboard focus, every
  visible leaf pane — occupied and empty alike — shows a non-interactive
  (`pointer-events: none`) overlay with its current size as a rounded integer
  percentage. The denominator is always the whole session work area (the
  split region excluding the sidebar), not the immediate split parent, so
  three/four-pane horizontal, vertical, and mixed-nesting layouts all report
  true clamped geometry on both axes. Overlays persist for the entire drag
  or focus interval and disappear only after both have ended.

## Spatial structure

Scroll ownership follows the StyleGallery discipline restated in our own
words: every scrollable region has exactly one owner, scroll chaining between
regions is deliberate rather than incidental, and no region scrolls
implicitly because an ancestor does.

| Region | Shell pattern | Scroll owner |
| --- | --- | --- |
| App shell | fixed-sidenav shell | the sidebar owns its own vertical scroll; the pane work area beside it is a shrinkable track and never inherits horizontal overflow |
| Chat pane | scroll-body shell | the transcript is the sole vertical scroller; header, status row, and composer are fixed bands; banners, queue, and shelves scroll in the content shell between header and composer only when fixed bands exceed the column |
| Reading column | content limiter | a `min(760px, 100%)` constraint on message content, never a scroller itself |
| Split panes | independent panes | each pane owns its transcript scroll independently; no cross-pane scroll sharing |
| Activity shelf | supporting pane | each tabpanel keeps its own scroll state and stays mounted; hidden panels scroll nothing |
| DAG graph | graph reel | the graph container owns horizontal scroll and auto-scrolls the running node into view on first paint; vertical page scroll never moves the graph |
| Palettes, menus, modals, docks | imposter | overlay surfaces render above the region that summoned them, trap their own internal scroll, and never propagate wheel events into the transcript beneath |

## Pane focus and session routing

- Exactly one pane is the active destination at a time. Pointer down anywhere
  on a pane — occupied or empty — and keyboard focus within it both make it
  active. The active pane carries exactly one subtle, geometry-neutral
  visible outline (`.th-pane--focused`): an outline treatment, never an inset
  box-shadow ring, never a border that shifts layout, and never a change to
  pane geometry. Divider focus and portal/menu focus are separate states and
  must not steal or imitate the pane active outline.
- The active-pane outline is width-bound: at viewport widths up to 768px it
  is suppressed entirely (`.th-pane--focused` paints `outline-style: none`)
  because the single full-screen pane has no sibling pane to disambiguate.
  Active-pane identity itself is preserved — session routing still tracks
  exactly one active destination — desktop split panes keep their outline,
  and keyboard `:focus-visible` affordances are never suppressed by this
  rule.
- Sidebar interaction never moves the active destination by itself: the
  sidebar captures the active pane at click time and assigns the selected
  session there, instead of focusing whichever pane already hosts it.
- A session occupies at most one pane. Assigning a session that is already
  placed moves it: the old host becomes empty. Assigning over an occupied
  pane only unplaces the previous session — it is never deleted or stopped.
  Unsent text, pending image and selected command belong to that session, not
  its pane; moving or reopening it retains the draft and active-run Stop state.
  Drafts remain in the authenticated App's memory and clear with session removal
  or authentication loss, never in a process-global or persistent cache.
- A delayed open (discovered-session load, deferred fetch) is bound to the
  pane captured at click time. It must not target a different or since-closed
  pane, and a newer user selection in the same pane supersedes it; stale
  completions are dropped, never applied.
  Deferred New Chat follows the same captured destination contract. Completion
  does not steal a later active-pane or DOM-focus choice.
- Closing the active pane moves the active destination to a valid remaining
  pane. MRU ordering, sidebar highlight, and normal session-active handling
  are preserved without extra import steps.

## Empty panes and session opening

- An empty pane shows the same session inventory as the sidebar — stored
  sessions plus discovered, not-yet-loaded entries — through one consistent
  open flow. There is no separate import or preparation step in the user's
  path: transparency means the disk/import/load preparation happens
  invisibly behind the one open action, NOT translucent styling. Empty panes
  and their overlays remain opaque Canvas (`--th-bg`).
- The picker reads the sidebar's paged MRU data source with visible
  loading, error, and retry states; a load-more action pages in further
  discovered entries. Selecting a row opens that session in the pane the row
  belongs to, exactly once, leaving every other pane unchanged.
- The narrow/single-pane layout exposes the same empty state and open flow
  at 390px-class widths, and the New Chat creation action is preserved in
  every empty pane.
- Session rows in picker and sidebar follow the badge-list pattern: label
  and trailing metadata (badge, time, count) align on one row with
  `justify-content: space-between`, the label truncates first, and the row
  never wraps into a second line of chrome.

## Model control placement

- The model control shares one compact control row with the status strip,
  directly above the composer capsule: statuses lead on the left and the
  current model selector is pinned to the row's right edge, on desktop and
  narrow layouts alike. The row keeps its position across pane resizes; the
  selector does not move with header metadata and does not reflow as the
  transcript changes.
- The control row, composer capsule, and transcript rows all resolve to one
  reading-column lane: containers outside the scrollport use
  `min(var(--th-chat-max), 100% - 2 * var(--th-chat-gutter))`, transcript rows
  add the scrollport's two reserved scrollbar gutters back to the same
  formula, and every band centers in the same column. The selector's right
  edge and the capsule's edge agree within 2 CSS px at every pane width, the
  row is one line in the normal case, and there is no document horizontal
  overflow. Context/cache metrics remain visible at rest, including zero,
  using Micro typography without truncation or an overflow scrollport. Under
  pressure whole metric/state items wrap within the control area. The selector
  retains a meaningful bounded share, including at 340px panes and with long
  Korean labels. Request-original inspection remains separate and preserves
  original text, draft, queue and focus.
- One bottom trigger shows the current model and reported reasoning level in
  both its visible and accessible state at every pane width. There is no header
  thinking select. Before catalog hydration, the exact reported model key is
  the identity fallback; an unloaded reasoning value selects no level.
- Both presentations use current identity, reasoning controls, model search,
  model list order. Reasoning remains available with an empty, loading or failed
  catalog. Unknown reported levels remain visible and selectable. Only explicit
  changes send a request; confirmation and rollback retain the existing session
  transaction contract.
- On desktop the picker opens as an upward popup anchored above the control
  (Raised elevation, bounded to `min(480px, 70dvh)`), so the list never
  covers the composer or send action. On narrow screens the existing
  viewport-contained sheet behavior is retained.
  Current identity, thinking controls and search stay fixed; only the list
  scrolls, including initial/keyboard option reveal. If the local upward bound
  cannot fit fixed chrome plus one whole option, use a viewport-contained
  desktop selection panel with trapped focus and Escape/close restoration.
  Short full viewports use one-line identity, a fixed native thinking select
  exposing every level, and compact Label-tier controls without reducing the
  user's base font. At 1440x150 and font24 at least one whole option remains.
  Popup navigation never scrolls hidden ancestors or moves the composer.
  Mobile keeps its existing pinned current identity and sheet behavior.
  Both presentations initially focus the non-text popup container. Forward Tab
  reaches reasoning before search; sheet/panel close precedes reasoning.
  Search accepts text, Arrow navigation and Enter selection after it receives
  focus. Anchored desktop forward exit from search reaches attachment; reverse
  exit from the first control restores the trigger. Sheets and fallback panels
  retain trapped focus.
  Escape restores the trigger in both presentations. Opening never focuses
  search or summons the mobile keyboard.
- Search, exact provider/model identity, thinking-level controls, keyboard
  selection, file/attachment/send actions, and responsive composer height
  contracts are unchanged by the move; the control renders the exact active
  model identity in both placements.

## Conversation anatomy

- Conversation rows come only from canonical RPC/history messages. Original
  submissions remain in request-identified feedback outside the scrollport.
- The status strip distinguishes sending, admitted (awaiting result), and
  unknown (outcome unconfirmed). Request words do not add progress rings. Unknown offers
  explicit original-draft recovery with a duplicate-submission warning; it
  never retries or fills the composer automatically. A completed send ACK
  retires that request, not an independently running assistant response.
- One stable indicator slot represents disconnected (warning-yellow spinner),
  otherwise server-running (muted spinner), otherwise idle (empty). Reconnect
  takes priority over stale running state. Localized accessible text and a
  descriptive tooltip replace visible Responding/Reconnecting words. Reduced
  motion retains a static recognizable ring. State changes do not move metrics
  or the model. Compacting, uncertain-send recovery, request inspection and
  steer feedback remain visible; context/cache need no disclosure.
- Failed originals follow their logical workspace/chat while panes move or
  remount. Recovery restores text, image, and command identity without sending.

- User messages align right in a restrained neutral bubble, maximum 80% of the
  reading column.
- Assistant prose aligns left directly on the canvas, with no bubble border or
  fill.
- Finalized and streaming assistant content occupy the same x-axis and width.
- A new user turn is distinguishable at a glance: transcript rows keep 8px
  block padding, and the row that opens a user turn (the first user message
  after other content, carrying the presentational `th-chat-row--turn-start`
  hook) pads its top with `--th-space-5`, so spacing before a user turn
  (28px total) visibly exceeds the 16px within-assistant rhythm without
  reordering the transcript.
- Tool calls use one compact disclosure per tool: both collapsed and expanded
  records share one persistent scoped tool material behind a subtle hairline
  boundary, visibly distinct from transparent prose on Canvas. Status color
  is secondary to the label and never the only signal.
- Thinking uses a collapsed disclosure with a subtle left rule.
- The completion status is metadata, not a separate message.
- Long words, URLs, code, Korean, and mixed-width text wrap without causing
  horizontal page overflow.

## Tool-execution block anatomy

A tool invocation and all of its incremental or final output form one
addressable transcript block keyed by `toolCallId`. Invocation and result must
never render as detached rows or neighboring cards, and restored history and
live execution must converge on the same structure. The block spans the
available reading-column width and uses one disclosure control and one shared
state. Every record carries one persistent enclosure of its own -- the scoped
`--th-tool-surface` fill behind a `--th-tool-border` hairline -- so collapsed
and expanded tools alike read as a material visibly distinct from the
transparent prose around them in both themes, without becoming a wall of
heavy cards; hover and keyboard focus keep a rounded treatment on the header
itself. The expanded body insets Canvas inside that enclosure, so running
output is visibly bounded.

Collapsed blocks show two compact lines inside the 48px disclosure header:

1. The first line contains the disclosure chevron, a status glyph, the operation
   title (a task summary when present, otherwise the tool name), and a trailing
   localized status word.
2. The second line is a single-line mono invocation summary. When output exists,
   append the first non-empty output line after a ` · ` separator; preserve the
   invocation before truncating the output preview. When no arguments are
   available, use the output preview alone rather than fabricating a command.

Completed blocks restored from history start collapsed. A newly started block
starts expanded so current work is observable; once the user toggles it, phase
updates and completion must not override that choice. The entire header is the
button, exposes `aria-expanded`, keeps its geometry while state changes, and
retains the visible status in either disclosure state.

Expanded blocks keep the identical header and add one inset body containing:

- a Command section when arguments contain a non-empty string `command`, shown
  verbatim, otherwise an Input section that renders arguments as two-space
  indented JSON; both use a Micro caption and mono content;
- an Output section when output exists, with a Micro caption and streamed or
  final Secondary mono text that preserves whitespace and wraps long unbroken
  values; and
- an internally scrollable output region capped at `min(360px, 45dvh)`, so a
  long execution cannot take over the conversation scrollport.

Do not render an empty body merely to fill space. Failure output remains
available and is never replaced by a generic error label. Running, successful,
and failed states use a distinct glyph plus a visible localized word -- spinner
ring and Running, check mark and Done, exclamation mark and Failed -- with color
only as a third, redundant cue. Under reduced motion the running ring remains
distinct but static.

Colour roles come from the measured reference mapping, not from the captured
tool chooser (a menu, not an executed output card): both disclosure states
share one scoped tool material, `--th-tool-surface` behind `--th-tool-border`,
and the expanded body insets Canvas, so the boundary and material never
depend on the disclosure state. The dark tool fill reuses the measured
elevated-chrome role; the light tool fill's light gray step is an
app-specific distinction requested for P4, not a measured native output-card
value. Both stay inside the app's fill/border idiom and do not move the
global palette. Status hues used as text are the theme-scoped status tokens
and keep the contrast matrix below on the tool fill.

The operation title and invocation preview use Label, status uses Micro, and
expanded command and output use Secondary with `--th-font-mono`; section
captions use Micro. Every block sits on the scoped tool material with a
`--th-tool-border` outline, `--th-radius-sm`, and no independent shadow or
whole-card status glow, while its expanded body uses Canvas as an inset, so
the output boundary is unmistakable without re-enclosing the rows above it. It
recedes behind transparent Body-tier assistant prose through smaller type,
compact spacing, and dim or muted text tokens --
never whole-block opacity -- but stays scannable through fixed alignment,
monospace command text, the persistent status glyph and word, and one block per
invocation.

## Composer commands and skills

- Typing `/` opens the slash-command list; typing `$` opens the dollar-skill list for `skill:<name>` entries. Both lists are attached immediately above the composer.
- The list is bounded to the reading column, never the viewport or sidebar.
- Arrow Up/Down changes the active option; Enter/Tab selects; Escape closes.
- The active option uses `aria-selected`, visible focus/active styling, and is
  kept in view.
- Pointer selection and keyboard selection produce the same input value.
- Selecting a command does not send by itself; the user can add arguments.
- One subsequent submit produces exactly one outbound request.
- Send and Stop occupy the same stable control slot to prevent layout shift.
- The slot is a fixed circular icon-only control (36px on wide panes, 44px on
  narrow ones): the up-arrow glyph sends, the X glyph stops, and only the glyph
  swaps — the circle's geometry never changes between states. The visible label
  is screen-reader-only; the accessible name always matches the action.
- While a run is in flight, a steer control of the same geometry and send fill
  appears immediately before that slot — never inside it, so Stop keeps its
  position. It carries the run-time steer that is otherwise reachable only
  through Cmd/Ctrl+Enter, which a soft keyboard cannot produce; without it a
  touch device can only stop a run it wants to redirect. An empty draft leaves
  it disabled, and it is absent whenever no run is in flight.
- Send's fill is the accent family through `--th-send` (resolved to
  `--th-accent-solid`), with the glyph in `--th-send-fg` (white on the solid
  fill, 4.5:1); `--th-send-hover` resolves to `--th-accent-solid-hover`.
  Stop keeps `--th-error`, and disabled semantics are unchanged. Composer CSS
  never hardcodes the fill, it exists only as tokens.
- Attachments open through the icon-only plus action at the capsule's leading
  edge. A pending image renders as a thumbnail chip in its own row above the
  input row, inside the capsule; drag-and-drop and queued drafts keep working
  unchanged.

## 세션 실행 표시

- 메인 세션의 실행 상태와 서브에이전트 실행 수는 별개로 표시합니다. 자식 작업이 없어도 메인 세션이 응답하거나 압축 중이면 실행 표시가 켜집니다.
- 세션이 연결되어 있다는 표시와 화면에 배치되어 있다는 표시는 실제 작업 중 표시를 대신하지 않습니다.
- 실행 종료는 서버가 확인한 상태로 반영하며, 늦게 도착한 이전 조회 결과가 더 최신의 실행 상태를 덮어쓰지 않습니다.
- 기존 상태 색상과 실행 표시 스타일을 재사용하고, 실행 중임을 색상만이 아니라 접근 가능한 이름으로도 전달합니다. 서브에이전트 수에 메인 세션을 더하지 않습니다.

## 통합 업데이트 대화상자

- `/update`는 기존 명령 팔레트의 선택 후 전송 규칙을 따르고, 제공자 명령의 우선권을 유지합니다.
- 업데이트 확인, 설치 중, 오류, 설치 완료 상태는 기존 `ModalDialog`와 확인창 스타일을 재사용합니다.
- 확인 전에는 설치하지 않고, 설치 중에는 중복 실행을 막습니다. 창을 닫는 동작은 설치 취소와 구분하며 같은 채팅에서 결과를 다시 열 수 있습니다.
- 설치 완료 안내는 실행 중인 엔진이 아직 교체되지 않았음을 명시하고, 작업 저장 후 데몬과 웹챗을 재시작하도록 안내합니다.
- 상태는 `role="status"`, 오류는 `role="alert"`로 전달하고 기존 모달의 포커스 복원과 Escape 닫기를 유지합니다.
- 설치 오류 로그는 Secondary 크기의 고정폭 글꼴과 오류 토큰을 사용합니다. 출력은 `min(240px, 30dvh)` 안에서 스크롤하고, 짧은 화면에서는 대화상자 내용도 스크롤하여 재시도 버튼을 유지합니다.

## 엔진 다시 시작

- 인증된 `POST /api/system/engine/restart`가 실행 중인 omo 엔진 프로세스만 제자리에서 교체합니다. omo-webchat 자체는 재시작하지 않고 사용자의 로그인 상태도 유지됩니다.
- 서버가 시작하지 않은 엔진(다른 프로세스가 시작한 엔진에 연결된 경우)은 소유하지 않은 프로세스를 안전하게 종료할 방법이 없어 요청을 거부합니다.
- 설치 업데이트와 같은 단일 실행 잠금을 공유해 둘이 동시에 실행되지 않고, 진행 중일 때 들어온 두 번째 요청은 거부합니다.
- 열린 채팅은 새 엔진 연결에서 자동으로 다시 열리지만, 교체 순간 스트리밍 중이던 답변은 중단됩니다. 확인 화면은 실행 중인 채팅이 있을 때 경고를 표시합니다.
- 설정 메뉴의 시스템 상태 아래 **omo 엔진 다시 시작** 항목이 확인 대화상자를 열어 이 엔드포인트를 호출합니다. 설치 업데이트 후 새 버전 적용에도 같은 동작을 사용합니다.
- 업데이트 없이 단독으로도 실행할 수 있어, 오래 실행된 엔진을 새로 시작하는 용도로도 사용합니다.

## New chat and Omo availability

- When Omo is available, clicking New Chat creates the session immediately
  without a provider-selection or confirmation step.
- While Omo availability is loading, unavailable, or could not be checked, a
  focused status modal offers Retry and Cancel without provider cards.
- Repeated activation while creation is in flight produces one session.
- Once created, the provider is part of the session identity and appears as
  compact read-only metadata in the chat header.
- Opening or switching sessions never changes another session's provider.
- The application never selects or sends a model during creation. The active
  CLI's reported default model is displayed when available and remains active
  until the user explicitly chooses another model.

## Responsive behavior

At 390x844 and comparable narrow sizes:

- the conversation and composer remain at least 320px wide;
- the workspace path may hide; the current model name and thinking level stay
  visible in the compact model control, which shares the status row above the
  capsule with the selector pinned to its right edge (see Model control
  placement);
- the narrow model picker opens a viewport-contained sheet that keeps every
  edge, including its pinned 44px close header, inside the usable
  visual-viewport bounds: it compensates keyboard pan and keeps clear of
  display cutouts via the per-side safe-area insets, without focusing search
  or summoning its keyboard. When the bound is over-constrained the fixed
  chrome scrolls beneath the pinned identity header and the list keeps a
  bounded minimum scrollport, so no content paints outside the sheet. Current
  model/provider identity stays pinned above the scrolling options. When the
  sheet itself is very narrow (including an 85px panned sheet), its local width
  query puts the unchanged 44px close on its own row and gives identity the
  full inset content width with single-line ellipsis, never character fragments.
  Safe insets, type sizes and viewport handling are unchanged. Selection
  uses exact provider/model identity, independent of navigation focus, and
  the current row is visible on opening;
- header controls remain reachable with 44px touch targets;
- the composer's plus action and send/stop circle grow to 44px hit areas, and
  the input keeps a 44px minimum height;
- the composer may wrap attachments into a secondary row, but input and
  send/stop remain together;
- the slash palette fits within the visible viewport and does not sit behind the
  software keyboard;
- an empty pane shows the same session open flow as a desktop empty pane, and
  pane dividers keep their 44px-effective touch target on coarse pointers even
  though the visible separator stays 4px;
- no element creates horizontal document overflow.

## Motion

Motion tokens, shared and theme-independent:

| Token | Value | Use |
| --- | --- | --- |
| `--th-dur-fast` | 120ms | hover and press colour |
| `--th-dur` | 200ms | state change, popover open and close |
| `--th-dur-slow` | 320ms | enter, disclosure |
| `--th-dur-emph` | 480ms | one-time choreography only, such as the empty-state entrance |

Easings: `--th-ease` `cubic-bezier(.2,0,0,1)` is the standard; `--th-ease-out`
`cubic-bezier(.16,1,.3,1)` carries entrances; `--th-ease-in-out`
`cubic-bezier(.65,0,.35,1)` carries movement between states; `--th-ease-spring`
`linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001)`
is a small pop reserved for selection thumbs and check draw-in. A spring never
carries opacity alone and never runs longer than `--th-dur`.

Only these properties animate: transform, opacity, filter, clip-path,
stroke-dashoffset, and background-position. Hover may additionally
transition color, background-color, border-color, and box-shadow. Disclosure
may transition grid-template-rows as a documented exception. `visibility` may
appear in a transition list only as the discrete hide/show flip paired with an
opacity or transform fade (it never interpolates). Nothing animates width,
height, top, left, margin, or padding.

Every animation declares one purpose before it ships:

- Acknowledgement: press, hover, selection. `--th-dur-fast`, `--th-ease`.
- Continuity: session switch, pane focus change, selection indicator travel.
  `--th-dur`, `--th-ease-in-out`.
- Progress: running and streaming indicators, the DAG comet and halo.
  `--th-dur` or `--th-dur-slow`. Progress motion is honest: it reflects real,
  observable state and never loops to suggest work that is not happening. An
  indeterminate indicator is a clearly indeterminate glyph, and under reduced
  motion it is a static glyph plus a visible word.
- Guidance: the entrance of an element the user must notice, such as a new DAG
  node or the one-time empty-state choreography. `--th-dur-slow` or
  `--th-dur-emph`, `--th-ease-out`.

Frequency-scaled intensity: the more often a motion can fire, the smaller and
faster it must be. Hover fires constantly and spends 120ms with no
translation. Selection moves often and slides over 200ms. A one-time entrance
may spend 480ms. No motion fires per elapsed-time tick, in hidden panels, or
on tab switches; DAG completion, cancellation, and leaving the graph consume
their one-shot motion rather than replaying it.

Interruption policy: in-flight motion is never left dead.

- Retarget: a re-aimed transition restarts from its current value toward the
  new target; reversing a disclosure mid-flight lands closed, not at a stale
  midpoint.
- Reverse: toggling back undoes the outgoing motion with the same duration.
- Settle: one-shot choreography (a completion check, a node settle) plays once
  and holds its end state; replaying it requires a genuinely new state.
- Coalesce: rapid repeated triggers, such as three session clicks within
  100ms, collapse into one final state; the last write wins and no stale
  intermediate frame renders.

Reduced motion: under `prefers-reduced-motion: reduce`, the global policy in
global.css collapses every animation and transition duration to about zero
with iteration-count 1. Each motion above ships an authored static equivalent
that conveys the same state: running becomes a static glyph plus a localized
word, entrances render in their final state, and the selection indicator still
moves, instantly, keeping its wash. State is never conveyed by motion alone.

Shared view transitions go through `runViewTransition(update, options?)` in
`frontend/src/lib/viewTransition.ts`. Pass the DOM state update that should
crossfade. The helper calls `document.startViewTransition(update)` when that
API exists and `prefers-reduced-motion: reduce` does not match. When the API
is missing or reduced motion matches, it runs `update` directly.
`::view-transition-old(root)` and `::view-transition-new(root)` in global.css
use `--th-dur` and `--th-ease-out`.

The update runs exactly once. If `startViewTransition` throws, or if `ready`,
`finished`, or `updateCallbackDone` rejects before the callback runs, the
update still runs. A rejection after the callback has run does not apply it
again. Visual failure never blocks the state update and never repeats it.

Latest-wins is an opt-in mode, `{ latestWins: true }`, on one shared lane. A
newer latest-wins call drops an older latest-wins update that has not yet run,
so rapid repeats (three session clicks within 100ms) apply only the last
update and no stale intermediate write lands. An update that has already run
is not rolled back. Calls that omit the flag always apply exactly once; they
do not drop lane updates and are not dropped by them. Reduced motion and a
missing API apply immediately, in call order; each call is already current
when it runs, and the last write is the final state.

Under reduced motion the helper does not call the API. The global policy
(`animation: none` and `transition: none` on the universal selector) stays as
it is. View-transition pseudos sit outside that selector, so the same media
query sets their animation duration to zero and keeps the fade's end state.

T2 owns session-switch choreography: which elements move, and how the
transcript, composer, and session tree take part. This helper is the shared
foundation only.

## Accessibility

- Every icon button has an accessible name.
- Dialogs trap and restore focus.
- Command list semantics follow combobox/listbox behavior.
- Pane dividers expose `separator` semantics with value attributes; focus
  visible on a divider is its own accent treatment, and Escape from a focused
  divider restores focus to the originating pane control.
- Keyboard-only operation covers session creation, availability recovery, command
  selection, prompt submission, abort, pane focus movement, divider resize, and
  closing overlays.

## Accepted debt

This document is the contract for the T1 foundation: palette, tokens,
typography, radius, elevation, glass, motion, state encoding, spatial
structure, and the global and secondary surfaces listed in the governing
plan. Surfaces not yet redesigned, tracked as follow-up PRs:

- T2 chat surface: pane header, transcript rows (user bubble, tool timeline,
  thinking, subagent records), composer and palettes, queue, status row,
  question and approval surfaces, session-switch continuity.
- T3 shell: sidebar nav and brand, session tree (selection indicator,
  running dot, counts), add-workspace action, empty-state orb and
  choreography, home-live, mobile drawer.
- T4 activity and DAG: shelf segmented tabs, todo and agents lists, goal
  bar, DAG graph visuals (cards, left status glyph, bezier edges, comet,
  halo, progress bar, fade masks), DAG list timeline, chips.

Until those nodes land, their legacy styling may deviate from this contract
in accent usage, borders, and motion durations. Those deviations are debt
with a closing PR, not precedent.

## Release checks

The surface is shippable only after real Chrome evidence at desktop and mobile
widths confirms:

1. header, scrollport, and composer share the pane bounds;
2. file panel, split panes, and command palette do not alter those bounds;
3. one prompt appears once and is transmitted once;
4. every session carries the omo provider label;
5. no clipping, overlap, detached controls, or horizontal overflow exists;
6. keyboard and pointer paths both work;
7. the expanded sidebar allocates zero rail width, collapse is reachable from
   its toolbar, and the collapsed rail reopens without covering pane titles;
8. exactly one pane shows the active outline, sidebar selection lands in the
   pane captured at click, and moving a session empties its old host without
   deleting or stopping anything;
9. an empty pane opens stored and discovered sessions through the one open
   flow with loading/error/retry, and a delayed open never overwrites a newer
   selection or a closed pane;
10. the model control shares the status row above the composer with the
    selector pinned right, the desktop popup opens upward, and the narrow
    sheet stays inside usable visual-viewport bounds on all four sides;
11. during divider drag or focus every visible pane shows its whole-work-area
    percentage overlay, Escape restores the originating control, and bounds
    never overflow;
12. at mobile widths no active-pane outline paints while desktop split panes
    keep theirs, and the sidebar settings/logout row sits inside usable
    bounds with only the necessary safe inset and zero extra footer bottom
    padding, with the software keyboard open or closed and in either
    orientation. Settings must also pass independently supplied top insets
    0/59px crossed with bottom insets 0/34px, both keyboard states, both themes,
    and short/long lists: full control rectangles inside safe and ancestor
    clipping bounds, native hits, and interior-scroll reachability.
