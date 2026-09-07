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

The chat surface adapts the layout grammar and neutral token roles from
`zvzuola/acp-components`:

- layered graphite backgrounds rather than tinted gradients;
- transparent assistant prose and a quiet user bubble;
- compact, bordered tool and thought disclosures;
- a centered reading column inside full-width structural regions;
- a composer that owns command discovery, attachments, and send/stop state;
- small radii, restrained shadows, and no glassmorphism.

The workspace shell remains omo-webchat's own interface. No reference branding,
logos, text, or proprietary assets are copied.

## Colour reference

Surface, text, and border colours are calibrated against an authenticated
capture of the installed Codex desktop app (com.openai.codex 26.810.52044;
real Settings dark→light toggles; CDP pixel samples and runtime computed
styles; see `.omo/evidence/ui-polish-20260907/theme/implementation.md`). The
measured roles and this app's tokens map as follows:

| Measured reference role | Light | Dark | omo-webchat tokens |
| --- | --- | --- | --- |
| Canvas | `#ffffff` | `#181818` | `--th-bg` |
| Sidebar / elevated chrome | `#ffffff` | `#282828` | `--th-surface` |
| Composer fill | `#ffffff` | `#2a2a2a` | `--th-surface-composer` |
| Menu / chooser surface | `#ffffff` | `#2d2d2d` | `--th-surface-raised` (and `--th-surface-overlay`) |
| Highlighted menu row | `#f2f3f3` | `#3d3d3d` | `--th-hover` |
| Foreground | `#1a1c1f` | `#dfdfdf` | `--th-text` |
| Default border | fg at 7.8% | white at 8.4% | `--th-border-surface` |
| Strong border | fg at 11.7% | white at 15.6% | `--th-border-strong`, `--th-border-user`, `--th-border-overlay` |

Three documented deviations exist, each forced by an existing contract or a
web-rendering constraint, never by taste:

- The native composer fill is a translucent material over an unknown underlay.
  The web composer uses an opaque approximation (`#2a2a2a` dark, `#ffffff`
  light) labelled as such; the measured alpha treatment is reproduced only when
  an underlay is actually known.
- The native secondary/tertiary text tiers (65%/50% foreground) fall below the
  app's 4.5:1 matrix on the brighter elevated fills, so `--th-text-dim`,
  `--th-muted`, and `--th-faint` are brightened above the native alpha mixes.
  Likewise the dark status hues are brightened because the measured elevated
  surfaces are far brighter than the previous dark ladder. Contrast wins over
  native transparency; the deviation is deliberate and tested.
- Roles the capture could not exercise (executed tool cards, user bubble,
  modals) inherit the measured role hierarchy conservatively: uncaptured
  surfaces reuse the nearest measured fill, and derived values (the user
  surface one step above the menu fill, the active state one step above the
  measured highlight) stay inside the app's white/foreground-alpha idiom.

## Tokens

Use the existing `--th-*` application tokens as the canonical source. Chat
styles must not create a second competing global palette.

| Role | Token |
| --- | --- |
| App canvas | `--th-bg` |
| Sidebar / top bar / tool shell | `--th-surface` |
| Composer capsule | `--th-surface-composer` |
| Raised modal / selected surface | `--th-surface-raised` |
| Hover / active | `--th-hover`, `--th-active` |
| Primary / secondary / muted text | `--th-text`, `--th-text-dim`, `--th-muted` |
| Borders | `--th-border`, `--th-border-strong` |
| Primary action | `--th-accent`, `--th-accent-fg` |
| Composer send action | `--th-send`, `--th-send-hover`, `--th-send-fg` |
| Status | `--th-success`, `--th-warning`, `--th-error` |
| Radius | `--th-radius-sm`, `--th-radius`, `--th-radius-lg`, `--th-radius-pill` |

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
| Body | `var(--th-font-size)` | 400 | 1.6 | `-0.005em` | Conversation prose and explanatory copy |
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

Tracking tightens as text gets larger; uppercase does not create an additional
tier. All user-readable text uses the existing `--th-font-sans` stack, except
commands, code, paths, identifiers, and tool output, which use
`--th-font-mono`. Component CSS must use a named tier for every text
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

## Elevation ladder

Elevation is a semantic relationship, not a reusable white overlay or black
shadow. Components request one of the levels below and use its fill, border,
and shadow tokens together; they never invent a lighter fill or attach an
unscoped shadow. Hover, selection, focus, and status are state treatments on a
level, not extra elevation levels. The earlier token table records current
names, not elevation placement: selected rows use `--th-active` on their
current level, modals migrate to Overlay, and neither uses Raised merely because
`--th-surface-raised` was previously shared by both.

| Level and tokens | Job | Dark-theme technique | Light-theme technique |
| --- | --- | --- | --- |
| Canvas / `--th-bg` | Base application and transcript; also an inset output well inside a tool block | Measured canvas `#181818`; no border or shadow | Measured canvas `#ffffff`; no border or shadow |
| Surface / `--th-surface`, `--th-shadow-surface` | Persistent elevated chrome: sidebar, top bar, tool shell | Measured sidebar fill `#282828` with the measured default white-alpha border; carries the measured composer shadow geometry | White with the measured default foreground-alpha border and the measured composer shadow geometry |
| Composer / `--th-surface-composer` | The composer capsule only: an opaque approximation of the native composer material (`#2a2a2a` dark, white light) | The Surface border and shadow treatment on its own fill | The Surface border and shadow treatment on its own fill |
| Raised / `--th-surface-raised`, `--th-shadow-raised` | Menus, palettes, file panels, and floating controls — surfaces that must read as sitting above the canvas | Measured menu/chooser fill `#2d2d2d` with the default border; no box shadow (the measured chooser carries none) | White with the default border; no box shadow, matching the measured chooser |
| User / `--th-surface-user`, `--th-border-user`, `--th-shadow-raised` | The user chat bubble only: an authorship surface one visible step above Raised so the bubble separates at a glance without accent decoration | One step above the menu fill inside the measured white-alpha idiom with the strong border | White, separated exactly like the measured composer on white: the strong border plus the Raised shadow |
| Overlay / `--th-surface-overlay`, `--th-shadow-overlay`, `--th-backdrop` | Modal dialogs and blocking drawers that must separate from every pane | Reuses the measured menu fill (the highest captured surface) with the strong border, separated by the Canvas-derived scrim | White with the strong border, a downward black low-alpha shadow, and the scrim |

Hover, selection, focus, and status are state treatments on a level, not extra
elevation levels. `--th-hover` is the measured highlighted-row treatment
(`#f2f3f3` light, `#3d3d3d` dark); `--th-active` steps one alpha tier beyond it
in each theme's own direction (light darkens toward the foreground mix, dark
lifts toward white).

Elevation in both themes now follows the measured app: every opaque fill sits
in one narrow luminance band, separation comes from hairline foreground-alpha
borders plus the measured composer shadow (`0 3px 7.5px` black at 4% and
`0 0 20px` at 5%, present in both captured themes), and menus carry borders
without shadows. Dark is not shadowless: the captured runtime uses these exact
shadows. Percentages are resolved inside theme token declarations; component
CSS sees only semantic tokens resolved from `--th-shadow-color` (`#000000`, as
measured).

All existing chromatic and effect tokens must move from an unqualified `:root`
into both theme scopes: `--th-bg`, `--th-surface`, `--th-surface-composer`,
`--th-surface-raised`, `--th-hover`, `--th-active`, `--th-border`,
`--th-border-strong`, `--th-text`, `--th-text-dim`, `--th-muted`,
`--th-faint`, `--th-accent`, `--th-accent-fg`, `--th-accent-hover`,
`--th-send`, `--th-send-hover`, `--th-send-fg`, `--th-error`,
`--th-error-bg`, `--th-success`, `--th-warning`, `--th-warning-bg`,
`--th-ring`, `--th-glow`, `--th-shadow-sm`, `--th-shadow`,
`--th-shadow-lg`, and `--th-backdrop`. Add `--th-surface-overlay`,
`--th-shadow-color`, `--th-error-fg`, and a background token for every status,
including `--th-success-bg`, to both scopes. Geometry, type, radius, and motion
tokens remain shared.

`--th-ring` is a theme-specific focus treatment, not a white lift.
`--th-glow` has no elevation job and should be removed from decorative use; if
it remains during migration, each theme must define it independently. Replace
component use of size-named shadows with `--th-shadow-surface`,
`--th-shadow-raised`, and `--th-shadow-overlay`; during migration,
`--th-shadow-sm`, `--th-shadow`, and `--th-shadow-lg` may exist only as
same-scope aliases to those semantic roles. `--th-backdrop` is also
independently resolved per theme and must never assume that the Canvas is black.

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

An automated token test must parse both theme scopes, assert that their token
name sets are identical, resolve alpha and `color-mix()` values against the
intended background, and enforce a minimum WCAG contrast ratio of 4.5:1 for
all text pairs below in both themes. There is no 3:1 large-text exception
because the same semantic tokens can appear at Label or Micro size.

One narrow icon-only exception applies to `--th-send-fg` on `--th-send` and
`--th-send-hover`: while the send/stop control's only visible content is its
SVG glyph and its text label remains screen-reader-only, the pair is held to
the WCAG 2.1 1.4.11 non-text contrast minimum of 3:1, not 4.5:1. This
exception exists only under that condition. If `--th-send-fg` is ever used for
visible text, on any background, the full 4.5:1 text requirement binds again
and the token pair must be re-valued or the usage changed.

| Foreground text token | Intended background tokens that must be tested |
| --- | --- |
| `--th-text`, `--th-text-dim`, `--th-muted`, `--th-faint` | `--th-bg`, `--th-surface`, `--th-surface-composer`, `--th-surface-raised`, `--th-surface-user`, `--th-surface-overlay`, `--th-hover`, `--th-active` |
| `--th-accent` when used for link or emphasis text | Canvas, Surface, Raised, and Overlay fills |
| `--th-accent-fg` | `--th-accent`, `--th-accent-hover` |
| `--th-send-fg` | `--th-send`, `--th-send-hover` at 3:1 under the icon-only exception above; 4.5:1 if ever used as visible text |
| `--th-error-fg` | Solid `--th-error` action fills, including Stop |
| `--th-error`, `--th-success`, `--th-warning` when used as text | Their matching status background and every elevation fill on which the status may appear |

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
  rail; only the expanded shell's allocation changes.
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
- The content shell between header and composer owns auxiliary overflow only
  when fixed bands exceed the column. Banners, shelves, queue and recovery
  actions remain reachable by scrolling; the transcript retains its normal
  independent scrollport when space permits. No auxiliary band is clipped to
  make the composer fit.
- Reading column: `min(760px, 100%)`, horizontally centered. Structural
  containers remain full-width; only message content is constrained.
- Composer: full-width structural footer with its controls in the same centered
  reading column. Minimum 16px bottom breathing room after safe-area inset.
- The composer is one unified capsule: a single `--th-surface` pill
  (`--th-radius-pill`, one `--th-border` outline) that owns the plus
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
- Pane dividers are 4px structural separators (`--th-border` fill) between
  split children: `col-resize` on horizontal splits, `row-resize` on vertical
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

## Pane focus and session routing

- Exactly one pane is the active destination at a time. Pointer down anywhere
  on a pane — occupied or empty — and keyboard focus within it both make it
  active. The active pane carries exactly one subtle, geometry-neutral
  visible outline (`.th-pane--focused`): an outline treatment, never an inset
  box-shadow ring, never a border that shifts layout, and never a change to
  pane geometry. Divider focus and portal/menu focus are separate states and
  must not steal or imitate the pane active outline.
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

- The model control lives in the composer band, directly above the composer
  capsule and right-aligned within the reading column, on desktop and narrow
  layouts alike. It keeps its position across pane resizes; it does not move
  with header metadata and does not reflow as the transcript changes.
- The model wrapper, composer capsule, status strip, and transcript rows all
  resolve to one reading-column lane: containers outside the scrollport use
  `min(var(--th-chat-max), 100% - 2 * var(--th-chat-gutter))`, transcript rows
  add the scrollport's two reserved scrollbar gutters back to the same
  formula, and every band centers in the same column. The outer edges of
  model control, capsule, status, and live prose therefore agree within 1 CSS
  px at every pane width -- the control ends at the capsule's edge, not at the
  raw column edge -- with no document horizontal overflow.
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
  (Raised elevation, bounded to `min(280px, 50dvh)`), so the list never
  covers the composer or send action. On narrow screens the existing
  viewport-contained sheet behavior is retained.
  Measured space inside the actual clipping chat column can only tighten the
  desktop height cap; no minimum may exceed that space. Desktop chrome and
  options share one scrollport. Even short v3/v4/mixed panes retain a complete
  readable pointer-selectable row, with one-line model/provider rows below 60px
  of available space. Popup navigation never scrolls hidden ancestors or moves
  the composer. Mobile keeps its pinned current identity and list scrollport.
  Both presentations initially focus the non-text popup container. Forward Tab
  reaches reasoning before search; the mobile close action precedes reasoning.
  Search accepts text, Arrow navigation and Enter selection after it receives
  focus. Desktop forward exit from search reaches attachment; reverse exit from
  the first control restores the trigger. Mobile retains its sheet focus trap.
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
  unknown (outcome unconfirmed). Only sending/admitted animate. Unknown offers
  explicit original-draft recovery with a duplicate-submission warning; it
  never retries or fills the composer automatically. A completed send ACK
  retires that request, not an independently running assistant response.
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
- Tool calls use one compact disclosure per tool: collapsed records read as
  quiet transcript rows with no enclosure, and expanded records take the
  bounded Surface well. Status color is secondary to the label and never the
  only signal.
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
state. A collapsed record carries no enclosure of its own -- transparent
background, no border, no shadow -- so consecutive executions read as
inspectable transcript rows rather than a wall of cards; hover and keyboard
focus keep a rounded treatment on the header itself. The Surface enclosure
appears only when the expanded body is present, so running output is visibly
bounded.

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
tool chooser (a menu, not an executed output card): collapsed records stay
transparent on Canvas, the expanded shell takes the elevated-chrome Surface
role, and the expanded body insets Canvas, so output surfaces reuse measured
roles instead of inventing an unmeasured card treatment. Status hues used as
text are the theme-scoped status tokens and carry the contrast matrix below.

The operation title and invocation preview use Label, status uses Micro, and
expanded command and output use Secondary with `--th-font-mono`; section
captions use Micro. Collapsed records sit directly on Canvas at no elevation.
An expanded block sits at Surface elevation with a `--th-border` outline,
`--th-radius-sm`, and no independent shadow, while its expanded body
uses Canvas as an inset, so the output boundary is unmistakable without
re-enclosing the collapsed rows above it. It recedes behind transparent Body-tier assistant
prose through smaller type, compact spacing, and dim or muted text tokens --
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
- Send is the reference blue through `--th-send` / `--th-send-hover` /
  `--th-send-fg`; Stop keeps `--th-error`. Composer CSS never hardcodes the
  blue — it exists only as tokens.
- Attachments open through the icon-only plus action at the capsule's leading
  edge. A pending image renders as a thumbnail chip in its own row above the
  input row, inside the capsule; drag-and-drop and queued drafts keep working
  unchanged.

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
  visible in the compact model control, which keeps its composer-band
  placement above the capsule (see Model control placement);
- the narrow model picker opens a viewport-contained sheet without focusing
  search or summoning its keyboard. Current model/provider identity stays pinned
  above the scrolling options. Selection uses exact provider/model identity,
  independent of navigation focus, and the current row is visible on opening;
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

## Motion and accessibility

- Honor `prefers-reduced-motion`.
- Transitions are 120-180ms and communicate hover, focus, disclosure, or
  entrance only.
- Every icon button has an accessible name.
- Dialogs trap and restore focus.
- Command list semantics follow combobox/listbox behavior.
- Pane dividers expose `separator` semantics with value attributes; focus
  visible on a divider is its own accent treatment, and Escape from a focused
  divider restores focus to the originating pane control.
- Keyboard-only operation covers session creation, availability recovery, command
  selection, prompt submission, abort, pane focus movement, divider resize, and
  closing overlays.

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
10. the model control sits above the composer, right aligned, with the desktop
    popup opening upward and the narrow sheet contained;
11. during divider drag or focus every visible pane shows its whole-work-area
    percentage overlay, Escape restores the originating control, and bounds
    never overflow.
