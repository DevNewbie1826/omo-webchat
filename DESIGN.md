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

## Tokens

Use the existing `--th-*` application tokens as the canonical source. Chat
styles must not create a second competing global palette.

| Role | Token |
| --- | --- |
| App canvas | `--th-bg` |
| Sidebar / composer / tool surface | `--th-surface` |
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
| Canvas / `--th-bg` | Base application and transcript; also an inset output well inside a tool block | Opaque lowest-luminance neutral; no border or shadow | Opaque low-chroma light neutral; no border or shadow |
| Surface / `--th-surface`, `--th-shadow-surface` | Persistent chrome and contained work: sidebar, top bar, composer, tool shell | Resolve the fill as a 2% white luminance lift over Canvas, use a 1px 6%-white border, and set the level shadow to `none` | Use an opaque neutral surface one luminance step above Canvas, a 1px border from the theme's shadow tint at 10%, and a downward `0 1px 2px` shadow at 8% tint |
| Raised / `--th-surface-raised`, `--th-shadow-raised` | Menus, palettes, file panels, and floating controls — surfaces that must read as sitting above the canvas | Resolve the fill as a 4% white luminance lift over Canvas, use a 1px 8%-white border, and set the level shadow to `none` | Use the theme's highest opaque neutral surface, a 1px border at 12% shadow tint, and a downward `0 6px 18px -6px` shadow at 12% tint |
| User / `--th-surface-user`, `--th-border-user`, `--th-shadow-raised` | The user chat bubble only: an authorship surface one step above Raised so the bubble separates at a glance without accent decoration | One step above Raised (an 8% white luminance lift over Canvas) with a 1px 12%-white border; the shadow stays the Raised level (`none`) | Pure white with a 1px 14% shadow-tint border; the Raised soft shadow still applies |
| Overlay / `--th-surface-overlay`, `--th-shadow-overlay`, `--th-backdrop` | Modal dialogs and blocking drawers that must separate from every pane | Resolve the fill as a 5% white luminance lift over Canvas, use a 1px 10%-white border and no box shadow, then separate it with a Canvas-derived 60% scrim | Use the highest opaque neutral surface, a 1px border at 14% shadow tint, a downward `0 18px 48px -12px` shadow at 18% tint, and a 28% theme-shadow-tint scrim |

The percentages above are resolved inside theme token declarations; component
CSS sees only semantic tokens. Light-theme shadow percentages use
`--th-shadow-color`, a low-chroma neutral shadow tint defined in both theme
scopes, inside the complete semantic shadow token. In particular, dark
elevation is communicated by luminance stepping and whisper borders because
dark-on-dark shadows do not
communicate depth. Light elevation is communicated primarily by low-chroma,
downward shadows; it must not reuse a white lift intended for a black canvas.

All existing chromatic and effect tokens must move from an unqualified `:root`
into both theme scopes: `--th-bg`, `--th-surface`,
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
tokens a component requests. The design source's layered-graphite direction
applies only to dark-theme values; the light theme expresses the same roles
with light neutral fills and the light column of the elevation ladder.

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
| `--th-text`, `--th-text-dim`, `--th-muted`, `--th-faint` | `--th-bg`, `--th-surface`, `--th-surface-raised`, `--th-surface-user`, `--th-surface-overlay`, `--th-hover`, `--th-active` |
| `--th-accent` when used for link or emphasis text | Canvas, Surface, Raised, and Overlay fills |
| `--th-accent-fg` | `--th-accent`, `--th-accent-hover` |
| `--th-send-fg` | `--th-send`, `--th-send-hover` at 3:1 under the icon-only exception above; 4.5:1 if ever used as visible text |
| `--th-error-fg` | Solid `--th-error` action fills, including Stop |
| `--th-error`, `--th-success`, `--th-warning` when used as text | Their matching status background and every elevation fill on which the status may appear |

Opacity on a parent is not an acceptable way to create secondary or disabled
text, because it makes the effective contrast depend on whatever is behind it.
Choose a tested foreground/background token pair instead.

## Geometry

- Sidebar: fixed shell width from `--th-sidebar-w`; mobile uses a dismissible
  overlay drawer.
- Chat pane: fills all remaining width and height with no horizontal overflow.
- Header: full pane width, `--th-header-h`, one border at its bottom.
- Conversation scrollport: fills all space between header and composer.
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
  while it grows.
- File browser: absolute right-side overlay on desktop and full-pane overlay on
  narrow screens. Opening it must not change the chat pane flex axis.
- Split panes: each pane independently obeys this geometry down to 420px. Below
  that width, low-priority header metadata collapses before controls overflow.

## Conversation anatomy

- User messages align right in a restrained neutral bubble, maximum 80% of the
  reading column.
- Assistant prose aligns left directly on the canvas, with no bubble border or
  fill.
- Finalized and streaming assistant content occupy the same x-axis and width.
- Tool calls use one compact bordered disclosure per tool. Status color is
  secondary to the label and never the only signal.
- Thinking uses a collapsed disclosure with a subtle left rule.
- The completion status is metadata, not a separate message.
- Long words, URLs, code, Korean, and mixed-width text wrap without causing
  horizontal page overflow.

## Tool-execution block anatomy

A tool invocation and all of its incremental or final output form one
addressable transcript block keyed by `toolCallId`. Invocation and result must
never render as detached rows or neighboring cards, and restored history and
live execution must converge on the same structure. The block spans the
available reading-column width and uses one disclosure control, one outline,
and one shared state.

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

The operation title and invocation preview use Label, status uses Micro, and
expanded command and output use Secondary with `--th-font-mono`; section
captions use Micro. The block sits at Surface elevation with a `--th-border`
outline, `--th-radius-sm`, and no independent shadow, while its expanded body
uses Canvas as an inset. It recedes behind transparent Body-tier assistant
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
- the workspace path and optional model selector may hide;
- header controls remain reachable with 44px touch targets;
- the composer's plus action and send/stop circle grow to 44px hit areas, and
  the input keeps a 44px minimum height;
- the composer may wrap attachments into a secondary row, but input and
  send/stop remain together;
- the slash palette fits within the visible viewport and does not sit behind the
  software keyboard;
- no element creates horizontal document overflow.

## Motion and accessibility

- Honor `prefers-reduced-motion`.
- Transitions are 120-180ms and communicate hover, focus, disclosure, or
  entrance only.
- Every icon button has an accessible name.
- Dialogs trap and restore focus.
- Command list semantics follow combobox/listbox behavior.
- Keyboard-only operation covers session creation, availability recovery, command
  selection, prompt submission, abort, and closing overlays.

## Release checks

The surface is shippable only after real Chrome evidence at desktop and mobile
widths confirms:

1. header, scrollport, and composer share the pane bounds;
2. file panel, split panes, and command palette do not alter those bounds;
3. one prompt appears once and is transmitted once;
4. every session carries the omo provider label;
5. no clipping, overlap, detached controls, or horizontal overflow exists;
6. keyboard and pointer paths both work.
