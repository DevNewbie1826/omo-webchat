/** T3 (shell) scenario probes for the visual-redesign real-browser harness.
 *
 * Implements the governing plan's T3-owned scenarios against the ACTUAL built
 * SPA through the shared fixture harness (visual-redesign.mjs), which
 * auto-loads this module as a per-task plugin:
 *
 *   S5  (shell scope, overrides the builtin driver for the T3 window): the
 *       plan's "no state encoded by a coloured border/stroke + zero uppercase"
 *       sweep measured ONLY on shell surfaces - sidebar/drawer, session tree,
 *       overview/live cards, empty state/picker pane, toasts, split dividers
 *       and pane chrome. .th-chat-pane internals (T2) and .th-activity-shelf
 *       plus its descendants (T4) are excluded. The page may still open those
 *       surfaces so the exclusion is real; a painted coloured border, a
 *       stroked rect, or uppercase text inside the shell scope still fails.
 *   S10 sidebar: .th-btn-add not dashed; selection moves to the clicked
 *       session either through ONE moving indicator element (transform
 *       change) or through the active class moving with a non-coloured-
 *       border fill; running session dot colour == --th-accent; counts and
 *       brand not mono; no uppercase labels in the sidebar.
 *   S11 empty state: below 1024px the empty layout shows an orb + greeting
 *       + New chat CTA; the entrance choreography exists, is finite and
 *       plays once; nothing starts under prefers-reduced-motion; the CTA
 *       opens the new chat dialog (provider routed unavailable, the only
 *       state where the dialog exists - DESIGN.md "New chat and Omo
 *       availability"). At >=1024px the empty leaf is the session picker:
 *       S11 asserts that pane (orb with circular radius resolved against
 *       its box, greeting in the Display tier, one-time entrance,
 *       reduced-motion static) and fails when it is absent. pass:null is
 *       not a result.
 *   S24 covers G40 without replacing the binary/font S21 check: at 390x844 on a
 *       coarse pointer, measure visible shell hit areas in the drawer and
 *       empty state; every target must be at least 44px on both axes and
 *       adjacent hit areas must not overlap.
 *
 * Every product assertion has a counterpart that FAILS on the pre-redesign
 * baseline (dashed add button, success-hued running chip border/dot, mono
 * counts/brand, uppercase sidebar labels, no orb/greeting/entrance).
 *
 * Binding sources: .omo/plans/visual-redesign.md (S5/S10/S11, G4/G5/G9/G10,
 * G16, G17), .omo/plans/visual-redesign-tokens.md, DESIGN.md v2 (state
 * encoding, accent discipline, motion rules).
 *
 * Layout note: SplitView only renders above 1024px, so at 768/390 the
 * layout 'two' seed collapses to a single occupied pane. The empty layout
 * (and its home-live overview cards) is reached there by closing the pane
 * through its real header action, exactly like a user shrinking the window.
 *
 * Run: QA_PLAYWRIGHT=... bun test/qa/visual-redesign.mjs --evidence DIR
 * Unit tests: bun test test/qa/visual-redesign-scenarios-t3.test.mjs
 */
import { motionViolations, parseColor } from './visual-redesign-probes.mjs';
import { installSignals } from './design-workbench-fixture.mjs';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; driver-side only - never serialized into the page)
// ---------------------------------------------------------------------------

/** First family name of a CSS font stack ("Pretendard Variable", a, b -> the
 * quoted/unquoted first entry). Null for missing/unparsable stacks. */
export function firstFamily(fontFamily) {
  if (typeof fontFamily !== 'string') return null;
  const trimmed = fontFamily.trim();
  if (!trimmed) return null;
  const match = /^("[^"]+"|'[^']+'|[^\s,]+)/.exec(trimmed);
  return match ? match[1].replace(/^["']|["']$/g, '') : null;
}

/** Lean sessions.activity overview frame that lights the shell's live
 * surfaces through the app's all_live push subscription: the tree running
 * chip (running.agents -> runningCount), the pinned sidebar-live cards and
 * the home-live overview cards in an empty pane (active flag lists the row).
 * Field set matches the generated SessionsActivityFrame wire schema. */
export function shellLiveFrame({
  sessionId, title, agents = 2, active = true, now = Date.now(), lastLine = 'go test ./...',
} = {}) {
  if (!sessionId) throw new Error('shellLiveFrame requires sessionId');
  return {
    type: 'sessions.activity', sessionId, durableSessionId: sessionId, overflow: false,
    title, active, running: { agents }, last_activity_ms: now, last_line: lastLine,
  };
}

/** S10 static verdict from probeSidebarStatic facts. Returns failure strings;
 * empty means every sidebar assertion held. */
export function sidebarStaticVerdict(facts) {
  const failures = [];
  const data = facts ?? {};
  const add = data.addButton;
  if (!add?.found) failures.push('.th-btn-add not found in the sidebar');
  else {
    const styles = add.borderStyles ?? [];
    if (styles.length === 0 || styles.some(style => style !== 'solid' && style !== 'none')) {
      failures.push(`.th-btn-add border-style ${styles.join('/') || '(unreadable)'} is not solid|none (dashed add action: G4/G9)`);
    }
  }
  const counts = data.counts ?? [];
  if (counts.length === 0) failures.push('no numeric sidebar counts found (fixture must render tree/section counts)');
  for (const count of counts) {
    if (data.monoFirst && firstFamily(count.fontFamily) === data.monoFirst) {
      failures.push(`sidebar count ${count.label} "${count.text}" uses the mono stack (${count.fontFamily})`);
    }
  }
  const brand = data.brand;
  if (brand?.found && data.monoFirst && firstFamily(brand.fontFamily) === data.monoFirst) {
    failures.push(`sidebar brand ${brand.label} uses the mono stack (${brand.fontFamily})`);
  }
  const dots = data.dots ?? [];
  if (dots.length === 0) failures.push('no running session dot rendered (fixture must mark a session running)');
  for (const dot of dots) {
    if (!dot.matchesAccent) failures.push(`running session dot ${dot.label} is ${dot.background}, expected --th-accent ${dot.accent}`);
  }
  for (const upper of data.uppercase ?? []) {
    failures.push(`sidebar label ${upper.label} "${upper.text}" uses text-transform: uppercase`);
  }
  return failures;
}

/** S10 selection verdict from before/after probeSelectionFacts. Passes when
 * the selection moved to the clicked row through ONE of the plan's two
 * idioms: a single indicator element whose transform changed, or the active
 * class moving with a non-coloured-border fill. Returns { mode, failures }. */
export function selectionVerdict(before, after, clickedLabel = null) {
  const failures = [];
  const prior = before ?? {};
  const next = after ?? {};
  const beforeActive = prior.activeRows ?? [];
  const afterActive = next.activeRows ?? [];
  const afterIndicators = next.indicators ?? [];
  const beforeIndicators = prior.indicators ?? [];
  if (afterActive.length !== 1) {
    failures.push(`expected exactly one selected session row after the click, found ${afterActive.length}${afterActive.length ? ` (${afterActive.map(row => row.label).join(', ')})` : ''}`);
    return { mode: 'none', failures };
  }
  const classMoved = beforeActive.length === 1 && afterActive[0].label !== beforeActive[0].label;
  if (clickedLabel !== null && afterActive[0].label !== clickedLabel) failures.push(`selected row ${afterActive[0].label} is not the clicked row ${clickedLabel}`);
  const treatment = next.activeTreatment;
  if (treatment) {
    for (const border of treatment.borderColors ?? []) {
      failures.push(`selected row ${treatment.label} encodes state with a coloured border on ${border.on} (${border.color} ~= --th-${border.token})`);
    }
  }
  if (beforeIndicators.length || afterIndicators.length) {
    if (beforeIndicators.length !== 1 || afterIndicators.length !== 1) {
      failures.push(`expected exactly one persistent selection indicator, found ${beforeIndicators.length} before and ${afterIndicators.length} after`);
    } else {
      const priorIndicator = beforeIndicators[0], nextIndicator = afterIndicators[0];
      if (!priorIndicator.id || priorIndicator.id !== nextIndicator.id) failures.push('selection indicator was replaced instead of moved');
      if (!priorIndicator.visible || !nextIndicator.visible || !priorIndicator.painted || !nextIndicator.painted) {
        failures.push('selection indicator is hidden or has no painted fill');
      }
      if (!priorIndicator.aligned || !nextIndicator.aligned) failures.push('selection indicator is not aligned with the selected row');
      if (priorIndicator.transform === nextIndicator.transform) failures.push('selection indicator did not move to the clicked row');
    }
    return { mode: 'indicator', failures };
  }
  const wash = (parseColor(treatment?.background)?.a ?? 0) > 0.02;
  if (!classMoved) failures.push(`selection did not move to the clicked row (before: ${beforeActive.map(row => row.label).join(', ') || 'none'}; after: ${afterActive[0].label})`);
  if (!wash) failures.push('selected row has no visible non-coloured-border wash');
  return { mode: 'class', failures };
}

/** S11 static verdict from probeEmptyState facts. Returns failure strings.
 * A picker surface (desktop empty leaf) fails closed when the pane, its orb,
 * or a Display-tier greeting is missing. */
export function emptyStateVerdict(facts) {
  const failures = [];
  const data = facts ?? {};
  const count = data.rootCount ?? data.emptyCount ?? 0;
  if (count < 1) {
    if (data.surface === 'picker') return ['no picker pane (.th-picker-pane) rendered'];
    return ['no empty layout (.th-empty) rendered'];
  }
  const orb = data.orb ?? {};
  if (!orb.found) {
    failures.push(data.surface === 'picker'
      ? 'picker pane shows no orb/presence element (G32)'
      : 'empty layout shows no orb/presence element (G10)');
  }
  else {
    if (!orb.circular) failures.push(`orb ${orb.label} is not circular (radius ${orb.radiusPx}px on ${orb.width}x${orb.height})`);
    if (orb.borderStyle && orb.borderStyle !== 'solid' && orb.borderStyle !== 'none') {
      failures.push(`orb ${orb.label} keeps a ${orb.borderStyle} border (G10 dashed glyph box)`);
    }
  }
  const greeting = data.greeting ?? {};
  if (!greeting.found) {
    failures.push(data.surface === 'picker'
      ? 'picker pane shows no greeting heading (G32)'
      : 'empty layout shows no greeting heading (G10)');
  } else {
    if (greeting.textTransform === 'uppercase') failures.push(`greeting ${greeting.label} uses text-transform: uppercase`);
    if (data.monoFirst && firstFamily(greeting.fontFamily) === data.monoFirst) {
      failures.push(`greeting ${greeting.label} uses the mono stack (${greeting.fontFamily})`);
    }
    if (data.requireDisplayTier && greeting.displayTier !== true) {
      failures.push(`greeting ${greeting.label} is not in the Display tier (size ${greeting.fontSize} vs ${greeting.displaySize}, weight ${greeting.fontWeight} vs ${greeting.displayWeight})`);
    }
  }
  if (!data.cta?.found) {
    failures.push(data.surface === 'picker'
      ? 'picker pane shows no New chat CTA'
      : 'empty layout shows no New chat CTA');
  }
  return failures;
}

/** Properties an entrance may animate (DESIGN.md motion rules). Events
 * animating only hover-colour properties are recorded but are not entrance
 * candidates; infinite progress glyphs are excluded from the finite check. */
const ENTRANCE_PROPERTIES = new Set(['transform', 'opacity', 'filter', 'clip-path', 'stroke-dashoffset', 'background-position']);

/** S11 entrance verdict from the recorder's window.__thT3Entrance record.
 * iterations is encoded -1 for infinite (JSON cannot carry Infinity).
 * With reduced: true, ANY started animation/transition is a failure. */
export function entranceVerdict(record, { reduced = false } = {}) {
  const failures = [];
  const events = record?.events ?? [];
  if (reduced) {
    if (events.length > 0) {
      failures.push(`${events.length} animations still start inside the empty/picker surface under reduced motion (first: ${events[0].kind} "${events[0].name}" on ${events[0].label})`);
    }
    return failures;
  }
  const isEntrance = event => (event.properties ?? []).length === 0
    || (event.properties ?? []).some(property => ENTRANCE_PROPERTIES.has(property));
  const entrance = events.filter(event => event.iterations !== -1 && isEntrance(event));
  if (entrance.length === 0) failures.push('empty-layout entrance has no finite entrance animation (G10 choreography)');
  for (const event of entrance) {
    if (event.replays > 1) {
      failures.push(`entrance ${event.kind} "${event.name}" on ${event.label} restarted ${event.replays} times (one-time choreography)`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// In-page probes (serialized with the shared pageKit; NO module references,
// NO template literals - both would break in-page evaluation)
// ---------------------------------------------------------------------------

/** S10: sidebar facts - add-button border, brand/count font stacks, running
 * dot colours, uppercase labels. Judged driver-side by sidebarStaticVerdict. */
export function probeSidebarStatic() {
  const firstFamily = stack => {
    const s = String(stack == null ? '' : stack).trim();
    if (!s) return null;
    const m = /^("[^"]+"|'[^']+'|[^\s,]+)/.exec(s);
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  };
  const root = getComputedStyle(document.documentElement);
  const facts = {
    sansFirst: firstFamily(root.getPropertyValue('--th-font-sans')),
    monoFirst: firstFamily(root.getPropertyValue('--th-font-mono')),
    addButton: { found: false }, brand: null, counts: [], dots: [], uppercase: [], runningChips: 0,
  };
  const sidebar = document.querySelector('.th-sidebar');
  if (!sidebar) return { failures: ['no .th-sidebar rendered'], measurements: facts };
  const add = sidebar.querySelector('.th-btn-add');
  if (add) {
    const style = getComputedStyle(add);
    facts.addButton = {
      found: true,
      borderStyles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
    };
  }
  const brand = sidebar.querySelector('.th-sidebar-logo');
  if (brand) facts.brand = { found: true, label: describeElement(brand), fontFamily: getComputedStyle(brand).fontFamily };
  for (const element of sidebar.querySelectorAll('.th-tree-count, .th-sidebar-live-count, .th-home-live-count, [class*="count"]')) {
    if (!isVisibleElement(element)) continue;
    const text = (element.textContent || '').trim();
    if (!text || !/^\d+$/.test(text)) continue;
    facts.counts.push({ label: describeElement(element), text, fontFamily: getComputedStyle(element).fontFamily });
  }
  facts.runningChips = sidebar.querySelectorAll('.th-tree-running').length;
  const accent = tokenColor('--th-accent');
  for (const dot of sidebar.querySelectorAll('.th-tree-running-dot')) {
    if (!isVisibleElement(dot)) continue;
    const colour = parseColor(getComputedStyle(dot).backgroundColor);
    facts.dots.push({
      label: describeElement(dot), background: hexOf(colour), accent: hexOf(accent),
      matchesAccent: colour != null && colorEquals(colour, accent),
    });
  }
  for (const element of sidebar.querySelectorAll('*')) {
    if (getComputedStyle(element).textTransform !== 'uppercase') continue;
    const text = Array.from(element.childNodes)
      .filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join(' ').trim();
    if (text && isVisibleElement(element)) facts.uppercase.push({ label: describeElement(element), text: text.slice(0, 40) });
  }
  return { failures: [], measurements: facts };
}

/** S10: selection snapshot - rows with their active state, indicator
 * candidates with transforms, and the active row's border treatment. */
export function probeSelectionFacts() {
  const facts = { treeFound: false, rows: [], activeRows: [], indicators: [], activeTreatment: null };
  const tree = document.querySelector('.th-tree');
  if (!tree) return facts;
  facts.treeFound = true;
  let activeNode = null;
  for (const node of tree.querySelectorAll('.th-tree-node')) {
    const activation = node.querySelector('.th-tree-activation');
    if (!activation) continue;
    const label = (node.querySelector('.th-tree-label') ? node.querySelector('.th-tree-label').textContent : activation.textContent)
      .trim().slice(0, 48);
    const classActive = Array.from(node.classList).some(name => /(^|-)(active|selected)(-|$)/.test(name));
    const active = classActive || activation.getAttribute('aria-current') === 'true';
    facts.rows.push({ label, active });
    if (active) {
      facts.activeRows.push({ label });
      if (activeNode === null) activeNode = { node, activation, label };
    }
  }
  window.__thT3IndicatorIds ??= new WeakMap();
  window.__thT3IndicatorNextId ??= 0;
  for (const element of document.querySelectorAll('.th-tree-indicator')) {
    if (!window.__thT3IndicatorIds.has(element)) window.__thT3IndicatorIds.set(element, ++window.__thT3IndicatorNextId);
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const rowBox = activeNode?.node.getBoundingClientRect();
    const aligned = !!rowBox && box.width > 0 && box.height > 0
      && box.left + box.width / 2 >= rowBox.left && box.left + box.width / 2 <= rowBox.right
      && box.top + box.height / 2 >= rowBox.top && box.top + box.height / 2 <= rowBox.bottom;
    let visible = isVisibleElement(element) && Number(style.opacity) > 0;
    for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
      if (Number(getComputedStyle(parent).opacity) === 0) visible = false;
    }
    facts.indicators.push({
      id: window.__thT3IndicatorIds.get(element),
      label: describeElement(element), parentLabel: describeElement(element.parentElement),
      transform: style.transform, visible,
      painted: (parseColor(style.backgroundColor)?.a ?? 0) > 0.02,
      aligned,
    });
  }
  if (activeNode) {
    const tokens = {
      success: tokenColor('--th-success'), warning: tokenColor('--th-warning'),
      error: tokenColor('--th-error'), accent: tokenColor('--th-accent'),
    };
    const borderColors = [];
    const subjects = [[activeNode.node, 'row'], [activeNode.activation, 'activation']];
    for (const child of Array.from(activeNode.node.children)) subjects.push([child, 'child ' + describeElement(child)]);
    for (const [element, on] of subjects) {
      const style = getComputedStyle(element);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const colour = parseColor(style['border' + side + 'Color']);
        if (colour == null) continue;
        for (const name of Object.keys(tokens)) {
          if (tokens[name] && colorEquals(colour, tokens[name])) borderColors.push({ on, color: hexOf(colour), token: name });
        }
      }
    }
    facts.activeTreatment = {
      label: activeNode.label,
      background: getComputedStyle(activeNode.node).backgroundColor,
      borderColors,
    };
  }
  return facts;
}

/** Sidebar-only slice of the shared S15 animation inventory. The static
 * transition declaration also matters: a width transition can finish before
 * a driver roundtrip samples its Animation object. */
export function probeSidebarMotion() {
  const sidebar = document.querySelector('.th-sidebar');
  if (!sidebar) return { found: false, inventory: [] };
  const style = getComputedStyle(sidebar);
  const focused = document.querySelectorAll('.th-pane--focused');
  const active = document.activeElement;
  const box = active?.getBoundingClientRect();
  let visible = !!active && active.isConnected && !!box && box.width > 0 && box.height > 0;
  for (let node = active; visible && node instanceof Element; node = node.parentElement) {
    const computed = getComputedStyle(node);
    if (computed.display === 'none' || computed.visibility === 'hidden' || node.hasAttribute('inert')) visible = false;
  }
  return {
    found: true,
    collapsed: sidebar.classList.contains('th-sidebar--collapsed'),
    width: sidebar.getBoundingClientRect().width,
    expandedWidth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--th-sidebar-w')),
    transitionProperties: style.transitionProperty.split(',').map(value => value.trim()),
    transitionDurations: style.transitionDuration.split(',').map(value => value.trim()),
    inventory: collectAnimations(sidebar),
    focusedPaneCount: focused.length,
    focusedPaneIdentity: focused[0]?.getAttribute('data-th-t3-focus-pane') ?? null,
    activeElement: describeElement(active),
    focus: {
      connected: !!active?.isConnected,
      visible,
      focusable: active instanceof HTMLElement && active.tabIndex >= 0
        && !active.matches(':disabled') && active !== document.body,
      counterpart: active?.matches('.th-sidebar-rail .th-sidebar-toggle') ? 'rail'
        : active?.matches('.th-sidebar-nav .th-sidebar-toggle') ? 'toolbar' : null,
    },
    reversingEvent: window.__thT3SidebarReversal?.event ?? null,
  };
}

/** Arm before the native reopening Enter. The transitionstart handler holds
 * the actual opacity transition at its midpoint until the reversing Enter
 * reaches the document capture listener; host round trips cannot settle it. */
export function armSidebarReversal() {
  const sidebar = document.querySelector('.th-sidebar');
  if (!sidebar) throw new Error('sidebar missing before keyboard reversal');
  let animation = null;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const record = { event: null, ready };
  window.__thT3SidebarReversal = record;
  const onKeydown = event => {
    if (event.key !== 'Enter' || !event.target.matches('.th-sidebar-nav .th-sidebar-toggle')) return;
    const timing = animation?.effect?.getComputedTiming();
    record.event = {
      key: event.key, trusted: event.isTrusted,
      started: !!animation, playState: animation?.playState ?? null,
      currentTime: animation?.currentTime ?? null,
      duration: timing?.duration ?? null, progress: timing?.progress ?? null,
      collapsedBefore: sidebar.classList.contains('th-sidebar--collapsed'),
    };
    document.removeEventListener('keydown', onKeydown, true);
    if (animation?.playState === 'paused') animation.play();
  };
  const onStart = event => {
    if (event.target !== sidebar.querySelector('.th-sidebar-inner') || event.propertyName !== 'opacity') return;
    const captured = event.target.getAnimations().find(item =>
      item instanceof CSSTransition && item.transitionProperty === 'opacity');
    const duration = captured?.effect?.getComputedTiming().duration;
    if (!captured || !Number.isFinite(duration) || duration <= 0) {
      rejectReady(new Error('sidebar opacity transition missing at start'));
    } else {
      animation = captured;
      animation.pause();
      animation.currentTime = duration / 2;
      document.addEventListener('keydown', onKeydown, true);
      resolveReady(true);
    }
    sidebar.removeEventListener('transitionstart', onStart, true);
  };
  sidebar.addEventListener('transitionstart', onStart, true);
  return true;
}

export function sidebarReversalVerdict(event) {
  return event?.key === 'Enter' && event.trusted === true && event.started === true
    && event.collapsedBefore === false && event.playState === 'paused'
    && Number.isFinite(event.duration) && event.duration > 0
    && Number.isFinite(event.currentTime) && event.currentTime > 0 && event.currentTime < event.duration
    && Number.isFinite(event.progress) && event.progress > 0 && event.progress < 1
    ? [] : ['sidebar reversing Enter did not interrupt an intermediate paused opacity transition'];
}

export function sidebarFocusVerdict(snapshot, paneIdentity, collapsed) {
  const failures = [];
  if (snapshot.focusedPaneCount !== 1 || snapshot.focusedPaneIdentity !== paneIdentity) {
    failures.push(`sidebar changed active pane identity from ${paneIdentity} to ${snapshot.focusedPaneIdentity}`);
  }
  if (!snapshot.focus?.connected || !snapshot.focus.visible || !snapshot.focus.focusable
    || snapshot.focus.counterpart !== (collapsed ? 'rail' : 'toolbar')) {
    failures.push(`sidebar focus is not on the visible ${collapsed ? 'rail' : 'toolbar'} toggle (${snapshot.activeElement})`);
  }
  return failures;
}

/** S11: presence facts for one root (.th-empty below 1024px, .th-picker-pane
 * at split widths). Orb radius percentages resolve against the border box.
 * A picker root always requires the greeting to be in the Display tier.
 * Judged driver-side by emptyStateVerdict. */
export function probeEmptyState(arg) {
  const options = arg && typeof arg === 'object' ? arg : {};
  const rootSelector = typeof options.root === 'string' && options.root ? options.root : '.th-empty';
  const surface = rootSelector === '.th-picker-pane' ? 'picker' : 'empty';
  const firstFamily = stack => {
    const s = String(stack == null ? '' : stack).trim();
    if (!s) return null;
    const m = /^("[^"]+"|'[^']+'|[^\s,]+)/.exec(s);
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  };
  const radiusOf = (value, rect) => {
    // Computed border-radius may stay a percentage ("50%"); resolve it
    // against the element's border box so a round orb is never misread.
    const token = String(value == null ? '' : value).trim().split(/\s+/)[0] ?? '';
    let match = /^([\d.]+)px$/.exec(token);
    if (match) return parseFloat(match[1]);
    match = /^([\d.]+)%$/.exec(token);
    if (match && rect) return (parseFloat(match[1]) / 100) * Math.min(rect.width, rect.height);
    return null;
  };
  const near = (actual, wanted) => {
    const left = parseFloat(actual);
    const right = parseFloat(wanted);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return String(actual) === String(wanted);
    return Math.abs(left - right) <= 0.5;
  };
  const displayOf = style => {
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    probe.style.fontSize = 'var(--th-type-display-size)';
    probe.style.fontWeight = 'var(--th-weight-announce)';
    probe.style.lineHeight = 'var(--th-type-display-line)';
    probe.style.letterSpacing = 'var(--th-type-display-tracking)';
    (document.body || document.documentElement).appendChild(probe);
    const expected = getComputedStyle(probe);
    const snapshot = {
      fontSize: expected.fontSize, fontWeight: String(expected.fontWeight),
      lineHeight: expected.lineHeight, letterSpacing: expected.letterSpacing,
    };
    const tier = near(style.fontSize, snapshot.fontSize)
      && String(style.fontWeight) === snapshot.fontWeight
      && near(style.lineHeight, snapshot.lineHeight)
      && near(style.letterSpacing, snapshot.letterSpacing);
    probe.remove();
    return { tier, snapshot };
  };
  const facts = {
    surface,
    requireDisplayTier: options.requireDisplayTier === true || surface === 'picker',
    rootCount: document.querySelectorAll(rootSelector).length,
    emptyCount: document.querySelectorAll('.th-empty').length,
    monoFirst: firstFamily(getComputedStyle(document.documentElement).getPropertyValue('--th-font-mono')),
    orb: { found: false }, greeting: { found: false }, cta: { found: false },
  };
  const root = document.querySelector(rootSelector);
  if (!root) return facts;
  for (const element of root.querySelectorAll('h1, h2, h3, [class*="greeting"]')) {
    if (!isVisibleElement(element)) continue;
    const text = (element.textContent || '').trim();
    if (text.length < 2) continue;
    const style = getComputedStyle(element);
    const display = displayOf(style);
    facts.greeting = {
      found: true, label: describeElement(element), text: text.slice(0, 60),
      textTransform: style.textTransform, fontFamily: style.fontFamily,
      fontSize: style.fontSize, fontWeight: String(style.fontWeight),
      lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
      displaySize: display.snapshot.fontSize, displayWeight: display.snapshot.fontWeight,
      displayTier: display.tier,
    };
    break;
  }
  let orb = null;
  let matchedBy = null;
  for (const element of root.querySelectorAll('[class*="orb"]')) {
    if (isVisibleElement(element)) { orb = element; matchedBy = 'class'; break; }
  }
  if (orb === null) {
    for (const element of root.querySelectorAll('*')) {
      if (!isVisibleElement(element)) continue;
      if (element.textContent && element.textContent.trim()) continue;
      if (element.getAttribute('aria-hidden') !== 'true') continue;
      const rect = element.getBoundingClientRect();
      const min = Math.min(rect.width, rect.height);
      if (min < 24) continue;
      const radius = radiusOf(getComputedStyle(element).borderTopLeftRadius, rect);
      if (radius !== null && radius >= min * 0.42) { orb = element; matchedBy = 'decorative-circle'; break; }
    }
  }
  if (orb !== null) {
    const rect = orb.getBoundingClientRect();
    const style = getComputedStyle(orb);
    const min = Math.min(rect.width, rect.height);
    const radius = radiusOf(style.borderTopLeftRadius, rect);
    facts.orb = {
      found: true, matchedBy, label: describeElement(orb),
      width: Math.round(rect.width), height: Math.round(rect.height),
      radiusPx: radius === null ? null : Math.round(radius * 100) / 100,
      circular: radius !== null && radius >= min * 0.42,
      borderStyle: style.borderTopStyle,
    };
  }
  for (const button of root.querySelectorAll('button')) {
    if (!isVisibleElement(button)) continue;
    const name = ((button.textContent || '') + ' ' + (button.getAttribute('aria-label') || '')
      + ' ' + (button.getAttribute('title') || '')).trim();
    if (/new chat|새\s*채팅/i.test(name)) {
      facts.cta = { found: true, label: describeElement(button), name: name.replace(/\s+/g, ' ').slice(0, 48) };
      break;
    }
  }
  return facts;
}

/** S5 shell scope. Painted state/accent borders, stroked SVG rects, and
 * uppercase text fail only on shell surfaces: sidebar/drawer, session tree,
 * overview/live cards, empty state, picker pane, toasts, split dividers and
 * pane chrome. Descendants of .th-chat-pane are T2 internals (the pane box
 * itself and nested resize/close chrome stay in scope). .th-activity-shelf
 * and every descendant are T4 and are ignored even when they sit outside
 * the chat pane. */
export function probeShellStateColors() {
  const tokens = {
    success: tokenColor('--th-success'), warning: tokenColor('--th-warning'),
    error: tokenColor('--th-error'), accent: tokenColor('--th-accent'),
  };
  const shellSelector = '.th-sidebar, .th-tree, .th-overview-card, .th-sidebar-live, .th-home-live, .th-empty, .th-picker-pane, .th-toast, .th-divider, .th-divider-hint, .th-pane-wrap, .th-pane-close, .th-pane-resize, .th-pane-resize-actions, .th-pane-resize-menu, .th-pane-size, .th-session-workarea, .th-chat-pane';
  const chromeSelector = '.th-pane-close, .th-pane-resize, .th-pane-resize-actions, .th-pane-resize-menu, .th-pane-size, .th-divider, .th-divider-hint';
  const inScope = element => {
    if (!(element instanceof Element)) return false;
    if (element.closest('.th-activity-shelf')) return false;
    const chat = element.closest('.th-chat-pane');
    if (chat && chat !== element && !element.closest(chromeSelector)) return false;
    return element.closest(shellSelector) !== null;
  };
  const violations = [];
  const uppercaseFacts = [];
  for (const element of document.querySelectorAll('*')) {
    if (!inScope(element)) continue;
    if (element.matches(':focus-visible')) continue;
    if (element.closest('.th-alert')) continue;
    if (element.classList.contains('th-input') && element.matches(':focus')) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    // Only painted borders encode state: a zero-width or style:none border
    // reports currentColor and must not be counted. SVG shapes count only
    // when they draw an enclosure outline (a stroked rect).
    const colours = [];
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const width = parseFloat(style['border' + side + 'Width']) || 0;
      const lineStyle = style['border' + side + 'Style'];
      if (width > 0 && lineStyle !== 'none' && lineStyle !== 'hidden') colours.push(style['border' + side + 'Color']);
    }
    if (element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName === 'rect'
      && style.stroke && style.stroke !== 'none' && (parseFloat(style.strokeWidth) || 0) > 0) colours.push(style.stroke);
    const where = describeElement(element);
    for (const raw of colours) {
      const colour = parseColor(raw);
      if (!colour) continue;
      for (const name of Object.keys(tokens)) {
        if (tokens[name] && colorEquals(colour, tokens[name]) && violations.length < 400) {
          violations.push({ where, token: name, colour: hexOf(colour), alpha: Number(colour.a.toFixed(3)) });
        }
      }
    }
    if (style.textTransform === 'uppercase') {
      const text = Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join(' ').trim();
      if (text && isVisibleElement(element)) uppercaseFacts.push({ textTransform: style.textTransform, text, where });
    }
  }
  const uppercaseCensus = uppercaseOf(uppercaseFacts);
  const measurements = {
    scope: 'shell',
    tokens: {
      success: hexOf(tokens.success), warning: hexOf(tokens.warning),
      error: hexOf(tokens.error), accent: hexOf(tokens.accent),
    },
    stateColorViolationCount: violations.length,
    stateColorViolationSamples: violations.slice(0, 25),
    uppercaseCount: uppercaseCensus.uppercaseCount,
    uppercaseSamples: uppercaseCensus.uppercase.slice(0, 12).map(index => uppercaseFacts[index]),
  };
  const failures = [];
  if (violations.length > 0) {
    failures.push(violations.length + ' elements carry a state/accent coloured border or stroke (first: ' + violations[0].where + ' ' + violations[0].token + ')');
  }
  if (uppercaseCensus.uppercaseCount > 0) {
    failures.push(uppercaseCensus.uppercaseCount + ' visible elements use text-transform: uppercase (first: ' + uppercaseFacts[uppercaseCensus.uppercase[0]].where + ')');
  }
  return { scenario: 'S5', pass: failures.length === 0, measurements, failures };
}

// ---------------------------------------------------------------------------
// Entrance recorder (installed via context.addInitScript; runs at document
// start on every navigation, so mount-time entrance motion cannot be missed
// by driver roundtrips). iterations is encoded -1 for infinite.
// ---------------------------------------------------------------------------

export const ENTRANCE_RECORDER_SOURCE = `
(() => {
  if (window.__thT3Entrance) return;
  const record = { events: [], done: false };
  window.__thT3Entrance = record;
  const describe = el => {
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/)[0] || '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const starts = new Map();
  const note = (kind, event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.th-empty, .th-picker-pane')) return;
    const name = kind === 'animation' ? event.animationName : event.propertyName;
    const key = kind + ':' + name + ':' + describe(target);
    const replays = (starts.get(key) || 0) + 1;
    starts.set(key, replays);
    let iterations = null;
    let duration = null;
    const properties = [];
    try {
      for (const animation of target.getAnimations()) {
        const matches = kind === 'animation'
          ? (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation && animation.animationName === name)
          : (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition && animation.transitionProperty === name);
        if (!matches) continue;
        const timing = animation.effect.getComputedTiming();
        if (timing.iterations !== undefined) iterations = timing.iterations === Infinity ? -1 : timing.iterations;
        if (timing.duration !== undefined) duration = timing.duration;
        if (kind === 'animation') {
          const meta = new Set(['offset', 'computedOffset', 'easing', 'composite', 'cssText']);
          for (const frame of animation.effect.getKeyframes()) {
            for (const keyframeKey of Object.keys(frame)) {
              if (!meta.has(keyframeKey) && properties.indexOf(keyframeKey) < 0) properties.push(keyframeKey);
            }
          }
        } else if (properties.indexOf(name) < 0) properties.push(name);
        Promise.resolve(animation.finished).catch(() => {});
      }
    } catch (error) { /* reported without timing facts */ }
    record.events.push({ kind, name, label: describe(target), replays, iterations, duration, properties });
  };
  document.addEventListener('animationstart', event => note('animation', event), true);
  document.addEventListener('transitionrun', event => note('transition', event), true);
  setTimeout(() => { record.done = true; }, 4000);
})();
`;

// ---------------------------------------------------------------------------
// Driver helpers (Playwright, driver-side)
// ---------------------------------------------------------------------------

const errLine = error => (error instanceof Error ? error.message.split('\n')[0] : String(error));
/** First lines including Playwright's call log (selector / actionability
 * detail) so a failed required interaction names its target precisely. */
const errDetail = error => (error instanceof Error
  ? error.message.split('\n').slice(0, 6).join(' | ').replace(/\u001b\[\d*m/g, '')
  : String(error));
const isNarrowViewport = ctx => ctx.viewport.width <= 768;
const isSplitViewport = ctx => ctx.viewport.width >= 1024;

/** Teardown that never masks the scenario's own verdict: a context that
 * died mid-probe (page crash) must not swallow the original failure the
 * way a second throw from close() would. */
async function closeEnv(env) {
  try {
    return await env.close();
  } catch (error) {
    return { contextClosed: false, closeError: errLine(error) };
  }
}

/** Deliver the lean overview frame and wait for the tree's running dot. */
async function deliverShellLive(env, chatId, notes) {
  const peers = env.fixture.overview(shellLiveFrame({ sessionId: chatId, title: 'Stored A' }));
  notes.push(`lean overview frame reached ${peers.length} all_live subscriber(s)`);
  await env.page.waitForSelector('.th-tree-running-dot', { state: 'attached', timeout: 6000 });
}

/** Running DAG graph through the shelf's REAL v2 surface: the DAG tab is
 * catalog-driven (GET .../dag-runs + per-run docs) and the shared fixture
 * serves neither endpoint yet, so this seed helper fulfills them on the
 * page's context from inside this module (the fixture files are read-only
 * for T3; the gap is reported as an OUT-OF-SCOPE NEED). The doc satisfies
 * parseCompleteDag: counts tally the node states exactly, edges mirror the
 * dependency list, waves are layout hints. */
const QA_DAG_RUN_ID = 'qa-t3-shell-run';

function qaDagRunDoc() {
  const now = new Date().toISOString();
  return {
    complete: true,
    content_token: 'qa-t3-shell-token-1',
    run: {
      run_id: QA_DAG_RUN_ID, run_key: 'qa-t3-shell', name: 'T3 shell run', status: 'running',
      created_at: now, updated_at: now,
      counts: { total: 2, pending: 0, blocked: 0, scheduled: 0, running: 2, completed: 0, failed: 0, cancelled: 0, skipped: 0 },
      nodes: [
        { id: 'a', prompt: 'Audit the sidebar shell', state: 'running', depends_on: [], attempt: 1 },
        { id: 'b', prompt: 'Verify the overview cards', state: 'running', depends_on: ['a'], attempt: 1 },
      ],
      edges: [{ from: 'a', to: 'b' }],
      waves: [{ index: 0, node_ids: ['a'] }, { index: 1, node_ids: ['b'] }],
    },
  };
}

async function serveDagRuns(env) {
  // No $ anchor: the catalog request carries a ?limit=10 query that would
  // break an end-anchored pattern and silently fall through to the fixture's
  // 404 (observed in the round-3 debug run).
  await env.context.route(/\/api\/workspaces\/[^/]+\/chats\/[^/]+\/dag-runs(?:\/[^/?]+)?/, route => {
    const url = new URL(route.request().url());
    const doc = qaDagRunDoc();
    if (url.pathname.includes('/dag-runs/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        runs: [{
          run_id: doc.run.run_id, run_key: doc.run.run_key, name: doc.run.name,
          status: doc.run.status, total: doc.run.counts.total, content_token: doc.content_token,
        }],
        next_cursor: null,
      }),
    });
  });
}

/** Wait for a running graph node; if the catalog walk raced the route
 * installation, retry once through the shelf's own Refresh action. */
async function waitDagGraph(page) {
  try {
    await page.waitForSelector('.th-activity-gnode--running', { timeout: 5000 });
    return;
  } catch { /* one real retry through the shelf's own affordance */ }
  const refresh = page.locator('.th-activity-dag-complete button', { hasText: /refresh|retry|새로고침|재시도/i }).first();
  if (await refresh.isVisible().catch(() => false)) await refresh.click({ timeout: 2000 }).catch(() => {});
  await page.waitForSelector('.th-activity-gnode--running', { timeout: 5000 });
}

/** Running DAG on the shelf's real surface. A required interaction (T1
 * review lesson): if the graph never renders through its real entry point,
 * the caller FAILS the scenario - the note only records the seeding. */
async function deliverRunningDag(env, chatId, notes) {
  await serveDagRuns(env);
  notes.push('dag-runs catalog + run doc seeded on the page context');
  try {
    await env.page.waitForSelector('[data-activity-tab="dag"]', { timeout: 4000 });
    await env.page.click('[data-activity-tab="dag"]');
    await waitDagGraph(env.page);
    return null;
  } catch (error) {
    return `required interaction "running DAG graph" failed: ${errDetail(error)}`;
  }
}

async function deliverApproval(env, chatId, notes) {
  await env.fixture.deliver(chatId, {
    type: 'approval', id: 'qa-t3-approval-1', method: 'shell.exec',
    title: 'QA approval', message: 'Approve the T3 shell check?',
  });
  try {
    await env.page.waitForSelector('.th-approval-form, .th-question-window, [class*="approval"]', { timeout: 4000 });
    return null;
  } catch (error) {
    return `required interaction "approval surface" failed to render: ${errDetail(error)}`;
  }
}

async function openModelPicker(env, notes) {
  try {
    await env.page.click('.th-model-picker-btn');
    await env.page.waitForSelector('.th-model-picker-popover', { timeout: 4000 });
    return null;
  } catch (error) {
    return `required interaction "model picker" failed: ${errDetail(error)}`;
  }
}

/** Open the mobile drawer through its real entry point (pane hamburger or
 * the empty state's menu button). No-op on desktop viewports. */
async function openDrawer(page) {
  const hidden = await page.evaluate(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true';
  }).catch(() => true);
  if (!hidden) return;
  const menu = page.locator('.th-mobile-menu').first();
  if (await menu.isVisible().catch(() => false)) await menu.click();
  else await page.locator('.th-empty-menu').first().click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !!sidebar && !sidebar.hasAttribute('inert') && sidebar.getAttribute('aria-hidden') !== 'true';
  }, undefined, { timeout: 4000 });
}

/** G29 discipline (local copy for these probes): close the drawer through
 * the backdrop, then wait for its finite exit animations (the transform
 * slide and the delayed visibility flip) so nothing captures mid-exit. */
async function closeDrawerSettled(page) {
  const backdrop = page.locator('.th-backdrop');
  if (!(await backdrop.isVisible().catch(() => false))) return;
  const width = page.viewportSize()?.width ?? 390;
  await backdrop.click({ timeout: 2000, position: { x: Math.max(1, width - 24), y: 60 } }).catch(() => {});
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.th-sidebar');
    return !sidebar || sidebar.hasAttribute('inert') || sidebar.getAttribute('aria-hidden') === 'true';
  }, undefined, { timeout: 4000 }).catch(() => {});
  await settleDrawerMotion(page);
}

/** Wait for every FINITE animation on the drawer subtree to finish (bounded;
 * infinite progress glyphs are excluded so they cannot stall the bound). */
async function settleDrawerMotion(page) {
  await page.evaluate(() => {
    const sidebar = document.querySelector('.th-sidebar');
    if (!sidebar) return Promise.resolve();
    const finite = sidebar.getAnimations({ subtree: true }).filter(animation => {
      try { return animation.effect?.getComputedTiming()?.iterations !== Infinity; } catch { return false; }
    });
    return Promise.race([
      Promise.allSettled(finite.map(animation => animation.finished)),
      new Promise(done => setTimeout(done, 2500)),
    ]);
  }).catch(() => {});
}

/** Fold whatever overlays block the sidebar. The approval/question window
 * closes on document-level Escape (modalStack), but the model picker
 * popover ignores Escape while focus is outside it and its panel covers
 * the sidebar rows, the composer AND its own trigger (observed live), so
 * it is closed by selecting the current model in its own list - a real
 * pointer path that changes nothing. Each close is verified by detaching. */
async function dismissBlockingOverlays(page) {
  if (await page.locator('.th-modal-overlay').first().isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 2000 }).catch(() => {});
  }
  if (await page.locator('.th-model-picker-popover').first().isVisible().catch(() => false)) {
    await page.locator('.th-model-picker-popover [role="option"], .th-model-picker-list button').first()
      .click({ timeout: 3000 }).catch(() => {});
    await page.waitForSelector('.th-model-picker-popover', { state: 'detached', timeout: 2000 }).catch(() => {});
  }
}

/** Click the workspace row's real add-session action (hover-revealed) and
 * wait for the success toast. The hover must actually reveal the action
 * before the click: the tree re-renders on live updates, so the reveal is
 * waited for, and one re-hover retry covers a re-render stealing it. With
 * the provider available (default fixture) this creates the chat directly -
 * the toast is the observable. */
async function addSessionThroughRow(page) {
  const button = page.locator('button[title="Add chat session"]').first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator('.th-tree-node', { has: button }).first().hover().catch(() => {});
    try {
      await button.waitFor({ state: 'visible', timeout: 2000 });
      break;
    } catch { /* one re-hover after a tree re-render */ }
  }
  await button.click({ timeout: 4000 });
  await page.waitForSelector('.th-toast--success', { timeout: 4000 });
}

/** Publish an empty focused layout on the fixture (PUT /api/layout); the
 * app reads the layout at boot, so a reload after the PUT focuses the empty
 * pane. Below 1024px that renders the single-pane ChatEmptyState surface;
 * at split widths it renders the picker pane, which S11 measures for the
 * same presence language (orb, Display greeting, one-time entrance). */
async function focusEmptyLayout(env) {
  const response = await fetch(`${env.fixture.url}/api/layout`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'leaf', id: 'a', sessionId: null }),
  });
  if (response.status !== 200) throw new Error(`layout PUT failed: ${response.status}`);
}

/** Wait for every FINITE animation in the document to finish (bounded;
 * infinite progress glyphs are excluded). Screenshots and measurements run
 * only after the triggered state settled (T1 review lesson). */
async function settleFiniteMotion(page, timeoutMs = 2000) {
  await page.evaluate(timeoutMs => {
    const finite = document.getAnimations().filter(animation => {
      try { return animation.effect?.getComputedTiming()?.iterations !== Infinity; } catch { return false; }
    });
    return Promise.race([
      Promise.allSettled(finite.map(animation => animation.finished)),
      new Promise(done => setTimeout(done, timeoutMs)),
    ]);
  }, timeoutMs).catch(() => {});
}

async function settleSidebarToggle(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const animations = document.querySelector('.th-sidebar').getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming()?.iterations !== Infinity);
    await Promise.race([
      Promise.all(animations.map(animation => animation.finished)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('sidebar motion did not settle')), 2500)),
    ]);
  });
}

/** One whole-app state-colour sweep plus its evidence screenshot, taken
 * only after the stage's finite animations settled. */
async function stateSweep(ctx, env, stage, stages, failures) {
  await settleFiniteMotion(env.page);
  const result = await ctx.probe(env.page, probeShellStateColors);
  stages.push({
    stage,
    stateColorViolations: result.measurements.stateColorViolationCount ?? null,
    uppercaseCount: result.measurements.uppercaseCount ?? null,
    violationSamples: (result.measurements.stateColorViolationSamples ?? []).slice(0, 6),
    uppercaseSamples: result.measurements.uppercaseSamples ?? [],
  });
  for (const failure of result.failures) failures.push(`[${stage}] ${failure}`);
  return ctx.save(env.page, `-${stage}`);
}

// ---------------------------------------------------------------------------
// Scenario probes (plugin contract: async ctx -> result)
// ---------------------------------------------------------------------------

/** S5 - no state encoded by a painted coloured border or rect stroke,
 * and zero uppercase, measured only on shell surfaces. Chat-pane internals
 * and the activity shelf are not scored. */
export async function runStateColorsShell(ctx) {
  const env = await ctx.setupLive({ layout: 'two' });
  const chatId = ctx.constants.CHAT;
  const notes = [];
  const failures = [];
  const stages = [];
  let screenshots = [];
  try {
    await deliverShellLive(env, chatId, notes);
    failures.push(...await deliverRunningDag(env, chatId, notes).then(r => r ? [r] : []));
    // The picker opens BEFORE the approval: its question window is a modal
    // over the composer and would block the picker's real click otherwise.
    failures.push(...await openModelPicker(env, notes).then(r => r ? [r] : []));
    failures.push(...await deliverApproval(env, chatId, notes).then(r => r ? [r] : []));
    screenshots.push(await stateSweep(ctx, env, 'chat-surfaces', stages, failures));
    if (isSplitViewport(ctx)) {
      // Desktop: the empty pane's overview cards sit beside the chat pane.
      // Fold the picker popover AND the approval window first (one Escape
      // each) so neither overlay blocks the sidebar row's hover-revealed
      // action. Best effort: focus the empty picker pane so the add-session
      // action targets it (pane a keeps its DAG/approval surfaces for stage
      // 1; the empty split pane has no .th-empty wrapper by design).
      await dismissBlockingOverlays(env.page);
      await env.page.locator('.th-pane-wrap:not(:has(.th-termhead))').first()
        .click({ position: { x: 12, y: 12 }, timeout: 1500 }).catch(() => {});
      await addSessionThroughRow(env.page);
      notes.push('add chat session produced the success toast');
      screenshots.push(await stateSweep(ctx, env, 'shell-plus-toast', stages, failures));
    } else {
      // Narrow: the split collapses to one pane with no close affordance and
      // no empty-hero surface; the shell scope here lives in the drawer -
      // pinned overview cards (the same .th-overview-card markup), tree
      // running chip and labels - then the add-session toast. The cards are
      // required: not reaching them fails the scenario.
      await dismissBlockingOverlays(env.page);
      await openDrawer(env.page);
      let cardsFailure = null;
      try {
        await env.page.waitForSelector('.th-sidebar-live .th-overview-card', { timeout: 4000 });
        notes.push('sidebar-live overview cards rendered (drawer)');
      } catch (error) {
        cardsFailure = `required interaction "overview cards" never rendered in the drawer: ${errLine(error)}`;
      }
      screenshots.push(await stateSweep(ctx, env, 'drawer-shell', stages, failures));
      await addSessionThroughRow(env.page);
      notes.push('add chat session produced the success toast');
      failures.push(...(cardsFailure ? [cardsFailure] : []));
      screenshots.push(await stateSweep(ctx, env, 'toast-drawer', stages, failures));
      await settleDrawerMotion(env.page);
      await closeDrawerSettled(env.page);
    }
    const motion = await ctx.motionSweep(env.page);
    return {
      scenario: 'S5', pass: failures.length === 0,
      measurements: {
        scope: 'shell (sidebar/drawer, session tree, overview/live cards, empty state/picker, toasts, split dividers/pane chrome); excludes .th-chat-pane internals and .th-activity-shelf',
        surfaceNotes: notes, stages, motion,
        toastObserved: stages.some(stage => stage.stage.includes('toast')),
        pageErrors: env.errors.slice(0, 5),
      },
      failures, screenshots, teardown: await closeEnv(env),
    };
  } catch (error) {
    failures.push(`harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return {
      scenario: 'S5', pass: false,
      measurements: { surfaceNotes: notes, stages, pageErrors: env.errors.slice(0, 5) },
      failures, screenshots, teardown: await closeEnv(env),
    };
  }
}

/** S10 - sidebar selection + running identity. */
export async function runSidebarSelection(ctx) {
  const env = await ctx.setupLive();
  const chatId = ctx.constants.CHAT;
  const narrow = isNarrowViewport(ctx);
  const notes = [];
  const failures = [];
  const sidebarMotion = [];
  const sidebarViolations = [];
  let screenshots = [];
  try {
    await deliverShellLive(env, chatId, notes);
    if (narrow) await openDrawer(env.page);
    const staticResult = await ctx.probe(env.page, probeSidebarStatic);
    const staticFailures = sidebarStaticVerdict(staticResult.measurements);
    failures.push(...staticFailures);
    // Selection interaction: click the other stored session ('Newer').
    const before = await ctx.probe(env.page, probeSelectionFacts);
    await env.page.locator('.th-tree-activation', { hasText: 'Newer' }).first().click({ timeout: 4000 });
    const moved = await env.page.waitForFunction(() => {
      const active = document.querySelector('.th-tree [aria-current="true"]');
      return !!active && (active.textContent || '').includes('Newer');
    }, undefined, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!moved) failures.push('clicking the "Newer" session row did not move aria-current="true" to it');
    if (narrow) await openDrawer(env.page); // the drawer auto-closes on selection
    await settleFiniteMotion(env.page); // the indicator slide must settle before measuring
    const after = await ctx.probe(env.page, probeSelectionFacts);
    const verdict = selectionVerdict(before.measurements ?? before, after.measurements ?? after, 'Newer');
    failures.push(...verdict.failures);
    await settleDrawerMotion(env.page);
    screenshots = [await ctx.save(env.page, '')];
    if (narrow) await closeDrawerSettled(env.page);
    if (isSplitViewport(ctx)) {
      const paneIdentity = await env.page.evaluate(() => {
        const focused = document.querySelectorAll('.th-pane--focused');
        if (focused.length !== 1) return null;
        focused[0].setAttribute('data-th-t3-focus-pane', 's10-active');
        return 's10-active';
      });
      if (!paneIdentity) failures.push('expected one focused pane before sidebar interactions');
      for (const reduced of [false, true]) {
        if (reduced) await env.page.emulateMedia({ reducedMotion: 'reduce' });
        await env.page.evaluate(() => {
          window.__thT3SidebarTransitions = [];
          const sidebar = document.querySelector('.th-sidebar');
          sidebar.addEventListener('transitionrun', event => {
            window.__thT3SidebarTransitions.push(event.propertyName);
          });
        });
        const states = [];
        await env.page.locator('.th-sidebar-nav .th-sidebar-toggle').focus();
        for (const [index, collapsed] of [true, false, true, false].entries()) {
          if (index === 1 && !reduced) await env.page.evaluate(armSidebarReversal);
          await env.page.keyboard.press('Enter');
          await env.page.waitForFunction(want => document.querySelector('.th-sidebar')
            ?.classList.contains('th-sidebar--collapsed') === want, collapsed, { timeout: 4000 });
          if (index === 1 && !reduced) {
            await env.page.evaluate(async () => {
              let deadline;
              try {
                await Promise.race([
                  window.__thT3SidebarReversal.ready,
                  new Promise((_, reject) => {
                    deadline = setTimeout(() => reject(new Error('sidebar reopen transition did not start')), 2500);
                  }),
                ]);
              } finally {
                clearTimeout(deadline);
              }
            });
          } else {
            await settleSidebarToggle(env.page);
          }
          const snapshot = await ctx.probe(env.page, probeSidebarMotion);
          states.push(snapshot);
          if (!snapshot.found || snapshot.collapsed !== collapsed
            || Math.abs(snapshot.width - (collapsed ? 44 : snapshot.expandedWidth)) > 1) {
            failures.push(`sidebar ${reduced ? 'reduced ' : ''}${collapsed ? 'collapse' : 'reopen'} did not settle at its target width`);
          }
          failures.push(...sidebarFocusVerdict(snapshot, paneIdentity, collapsed)
            .map(failure => `sidebar ${reduced ? 'reduced ' : ''}${collapsed ? 'collapse' : 'reopen'}: ${failure}`));
          const declared = snapshot.transitionProperties.flatMap((property, index) =>
            (parseFloat(snapshot.transitionDurations[index % snapshot.transitionDurations.length]) > 0 ? [property] : []));
          const animated = snapshot.inventory.flatMap(animation => animation.properties);
          for (const bad of motionViolations([...declared, ...animated])) {
            failures.push(`sidebar ${reduced ? 'reduced ' : ''}${collapsed ? 'collapse' : 'reopen'} animates ${bad}`);
            sidebarViolations.push({
              kind: 'transition', name: `desktop-${collapsed ? 'collapse' : 'reopen'}${reduced ? '-reduced' : ''}`,
              violations: [bad],
            });
          }
          if (reduced && snapshot.inventory.length) {
            failures.push(`sidebar under reduced motion retains ${snapshot.inventory.length} Animation objects`);
          }
          if (index === 2 && !reduced) failures.push(...sidebarReversalVerdict(snapshot.reversingEvent));
        }
        const events = await env.page.evaluate(() => window.__thT3SidebarTransitions);
        for (const bad of motionViolations(events)) {
          failures.push(`sidebar transitionrun animates ${bad}`);
          sidebarViolations.push({ kind: 'transition', name: 'desktop-sidebar-transitionrun', violations: [bad] });
        }
        sidebarMotion.push({ reduced, states, events });
      }
    }
    return {
      scenario: 'S10', pass: failures.length === 0,
      measurements: {
        surfaceNotes: notes, selectionMode: verdict.mode,
        selectionMoved: moved,
        before: before.measurements ?? before, after: after.measurements ?? after,
        static: staticResult.measurements, sidebarMotion, motion: { violating: sidebarViolations },
        pageErrors: env.errors.slice(0, 5),
      },
      failures, screenshots, teardown: await closeEnv(env),
    };
  } catch (error) {
    failures.push(`harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return {
      scenario: 'S10', pass: false, measurements: {
        surfaceNotes: notes, sidebarMotion, motion: { violating: sidebarViolations }, pageErrors: env.errors.slice(0, 5),
      },
      failures, screenshots, teardown: await closeEnv(env),
    };
  }
}

/** S11 - empty state presence + one-time choreography + CTA wiring.
 * Below 1024px the hero lives in .th-empty. At >=1024px the empty leaf is
 * the session picker: the same orb, Display-tier greeting, one-time
 * entrance and reduced-motion static state are required there. A missing
 * picker is a failure. pass:null is never returned. */
export async function runEmptyState(ctx) {
  const env = await ctx.setupLive({ layout: 'two' });
  const page = env.page;
  const split = isSplitViewport(ctx);
  const notes = [];
  const failures = [];
  let screenshots = [];
  const reachEmptyLayout = async label => {
    await focusEmptyLayout(env);
    await page.reload();
    await page.waitForSelector('.th-empty', { state: 'visible', timeout: 8000 });
    notes.push(`empty layout reached (${label})`);
  };
  const settleEntrance = async (selector = '.th-empty, .th-picker-pane') => {
    return page.evaluate(async selector => {
      const roots = Array.from(document.querySelectorAll(selector));
      if (!roots.length) throw new Error(`settlement target missing: ${selector}`);
      const finite = [...new Set(roots.flatMap(root => root.getAnimations({ subtree: true })))].filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity);
      let deadline;
      try {
        await Promise.race([
          Promise.all(finite.map(animation => animation.finished)),
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error(`animation settlement deadline exceeded: ${selector}`)), 2500);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      if (selector === '.th-modal-overlay, .th-modal') {
        const overlay = document.querySelector('.th-modal-overlay');
        const panel = overlay?.querySelector('.th-modal');
        if (!overlay || !panel) throw new Error('portaled modal overlay or panel missing');
        const final = [overlay, panel].map(element => {
          const style = getComputedStyle(element);
          return { opacity: Number(style.opacity), transform: style.transform };
        });
        if (final.some(state => state.opacity < 0.999
          || (state.transform !== 'none' && state.transform !== 'matrix(1, 0, 0, 1, 0, 0)'))) {
          throw new Error(`portaled modal did not reach final opacity/transform: ${JSON.stringify(final)}`);
        }
        return final;
      }
      return null;
    }, selector);
  };
  const readEntrance = () => page.evaluate(() => ({
    events: (window.__thT3Entrance?.events ?? []).slice(0, 40),
    done: window.__thT3Entrance?.done === true,
  }));
  try {
    // The recorder must exist before the page that mounts the empty layout,
    // and the provider must be unavailable before that load so requestNewChat
    // opens the dialog instead of creating a chat directly.
    await env.context.addInitScript(ENTRANCE_RECORDER_SOURCE);
    await env.context.route('**/api/providers', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'omo', label: 'omo', available: false }]),
    }));
    if (split) {
      // Desktop empty leaf is the session picker. Presence is required
      // (orb, Display-tier greeting, one-time entrance, reduced-motion
      // static). A missing pane fails the cell; pass:null is not a result.
      await focusEmptyLayout(env);
      await page.reload();
      let pickerReady = false;
      try {
        await page.waitForSelector('.th-picker-pane', { state: 'visible', timeout: 8000 });
        pickerReady = true;
        notes.push('desktop split: picker pane reached');
      } catch (error) {
        failures.push(`picker pane absent at >=1024px: ${errLine(error)}`);
      }
      let facts = null;
      let entrance = null;
      let animatedProperties = [];
      let reducedEntrance = null;
      let runningUnderReduce = null;
      let dialogTitle = null;
      let dialogClosed = false;
      let modalState = null;
      if (pickerReady) {
        facts = await ctx.probe(page, probeEmptyState, { root: '.th-picker-pane', requireDisplayTier: true });
        failures.push(...emptyStateVerdict(facts));
        await settleEntrance();
        entrance = await readEntrance();
        animatedProperties = [...new Set((entrance.events ?? []).flatMap(event => event.properties ?? []))];
        for (const bad of motionViolations(animatedProperties)) {
          failures.push(`picker entrance animates disallowed property ${bad}`);
        }
        failures.push(...entranceVerdict(entrance));
        await settleEntrance();
        screenshots.push(await ctx.save(page, '-desktop-picker-pane'));
        try {
          await page.locator('.th-picker-pane-create button').click({ timeout: 4000 });
          await page.waitForSelector('.th-modal-overlay .th-modal[role="dialog"]', { state: 'visible', timeout: 4000 });
          dialogTitle = (await page.locator('#th-new-chat-title').textContent())?.trim() ?? null;
          modalState = await settleEntrance('.th-modal-overlay, .th-modal');
          screenshots.push(await ctx.save(page, '-dialog'));
          await page.keyboard.press('Escape');
          await page.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 3000 });
          dialogClosed = true;
        } catch (error) {
          failures.push(`desktop picker CTA did not open and close the new chat dialog: ${errDetail(error)}`);
        }
        if (dialogTitle !== 'New chat') failures.push(`desktop new chat dialog title was ${JSON.stringify(dialogTitle)}, expected "New chat"`);
        if (!dialogClosed) failures.push('desktop new chat dialog did not close');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        try {
          await page.waitForSelector('.th-picker-pane', { state: 'visible', timeout: 8000 });
          notes.push('desktop split: picker pane reached (reduced motion)');
        } catch (error) {
          failures.push(`picker pane absent under reduced motion: ${errLine(error)}`);
        }
        reducedEntrance = await readEntrance();
        failures.push(...entranceVerdict(reducedEntrance, { reduced: true }));
        runningUnderReduce = await page.evaluate(() => {
          let count = 0;
          for (const root of document.querySelectorAll('.th-picker-pane')) {
            count += root.getAnimations({ subtree: true }).length;
          }
          return count;
        });
        if (runningUnderReduce > 0) {
          failures.push(`${runningUnderReduce} Animation objects still exist inside .th-picker-pane under reduced motion`);
        }
        await settleEntrance();
        screenshots.push(await ctx.save(page, '-reduced'));
      } else {
        screenshots.push(await ctx.save(page, '-desktop-picker-pane'));
      }
      return {
        scenario: 'S11', pass: failures.length === 0,
        measurements: {
          surfaceNotes: notes, facts, entrance,
          entranceProperties: animatedProperties,
          reducedEntrance, runningUnderReduce, dialogTitle, dialogClosed, modalState,
          pageErrors: env.errors.slice(0, 5),
        },
        failures, screenshots, teardown: await closeEnv(env),
      };
    }
    await reachEmptyLayout('initial load');
    const facts = await ctx.probe(page, probeEmptyState);
    failures.push(...emptyStateVerdict(facts));
    await settleEntrance();
    const entrance = await readEntrance();
    const entranceFailures = entranceVerdict(entrance);
    const animatedProperties = [...new Set((entrance.events ?? []).flatMap(event => event.properties ?? []))];
    const badProperties = motionViolations(animatedProperties);
    for (const bad of badProperties) failures.push(`empty-state entrance animates disallowed property ${bad}`);
    failures.push(...entranceFailures);
    // CTA opens the new chat dialog.
    let dialogTitle = null;
    let dialogClosed = false;
    let modalState = null;
    try {
      await page.locator('.th-empty button').filter({ hasText: /new chat/i }).first().click({ timeout: 4000 });
      await page.waitForSelector('.th-modal-overlay', { timeout: 4000 });
      dialogTitle = (await page.locator('#th-new-chat-title').textContent())?.trim() ?? null;
      modalState = await settleEntrance('.th-modal-overlay, .th-modal');
      screenshots.push(await ctx.save(page, '-dialog'));
      await page.keyboard.press('Escape');
      await page.waitForSelector('.th-modal-overlay', { state: 'detached', timeout: 3000 });
      dialogClosed = true;
    } catch (error) {
      failures.push(`empty-state CTA did not open the new chat dialog: ${errLine(error)}`);
    }
    if (dialogTitle !== 'New chat') failures.push(`new chat dialog title was ${JSON.stringify(dialogTitle)}, expected "New chat"`);
    if (!dialogClosed) failures.push('new chat dialog did not close');
    await settleEntrance();
    screenshots.push(await ctx.save(page, ''));
    // Reduced motion: reload with the preference active; nothing may start.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await reachEmptyLayout('reduced motion');
    const reducedEntrance = await readEntrance();
    failures.push(...entranceVerdict(reducedEntrance, { reduced: true }));
    const runningUnderReduce = await page.evaluate(() => {
      let count = 0;
      for (const empty of document.querySelectorAll('.th-empty')) count += empty.getAnimations({ subtree: true }).length;
      return count;
    });
    if (runningUnderReduce > 0) {
      failures.push(`${runningUnderReduce} Animation objects still exist inside .th-empty under reduced motion`);
    }
    await settleEntrance();
    screenshots.push(await ctx.save(page, '-reduced'));
    return {
      scenario: 'S11', pass: failures.length === 0,
      measurements: {
        surfaceNotes: notes, facts, entrance,
        entranceProperties: animatedProperties,
        reducedEntrance, runningUnderReduce,
        dialogTitle, dialogClosed, modalState, pageErrors: env.errors.slice(0, 5),
      },
      failures, screenshots, teardown: await closeEnv(env),
    };
  } catch (error) {
    failures.push(`harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return {
      scenario: 'S11', pass: false, measurements: { surfaceNotes: notes, pageErrors: env.errors.slice(0, 5) },
      failures, screenshots, teardown: await closeEnv(env),
    };
  }
}

/** Serialized S24 probe. Only the owning scroller may move to reveal a
 * target. Measure the visible intersection, then ask the browser who owns
 * five points in it. No module-scope references (ctx.probe serializes us). */
export function probeShellCoarseTargets({ root, requireCoarse = true, scrollOwner = null } = {}) {
  const coarseMatches = matchMedia('(pointer: coarse)').matches;
  const hoverNoneMatches = matchMedia('(hover: none)').matches;
  const failures = [];
  const elements = [];
  const overlaps = [];
  const scrolls = [];
  const container = document.querySelector(root);
  if (requireCoarse && !coarseMatches) failures.push('pointer: coarse media query did not match');
  if (requireCoarse && !hoverNoneMatches) failures.push('hover: none media query did not match');
  if (!container) failures.push(`shell surface ${root} is missing`);
  if (container) {
    const scroller = scrollOwner ? document.querySelector(scrollOwner) : null;
    if (scrollOwner && (!scroller || !scroller.contains(container) && !container.contains(scroller))) {
      failures.push(`scroll owner ${scrollOwner} is missing or unrelated to ${root}`);
    }
    const interactive = 'button, a[href], [role="button"], [role="tab"], [role="option"], input, select, [tabindex="0"]';
    for (const element of container.querySelectorAll(interactive)) {
      let visible = true;
      if (element.disabled) continue;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') { visible = false; break; }
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) {
          visible = false; break;
        }
      }
      if (!visible) continue;
      const initial = element.getBoundingClientRect();
      if (initial.width <= 0 || initial.height <= 0) continue;
      const path = [];
      for (let node = element; node && node !== container; node = node.parentElement) {
        const peers = [...node.parentElement.children].filter(peer => peer.tagName === node.tagName);
        path.unshift(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.classList.length ? `.${[...node.classList].join('.')}` : ''}:nth-of-type(${peers.indexOf(node) + 1})`);
      }
      const selector = `${root} > ${path.join(' > ')}`;
      const name = (element.getAttribute('aria-label') || element.getAttribute('title')
        || element.textContent || '').trim().replace(/\s+/g, ' ');
      const region = () => {
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
        let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (!/(hidden|auto|scroll|clip)/.test(style.overflowX + style.overflowY)) continue;
          const bounds = ancestor.getBoundingClientRect();
          if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
            left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
          }
          if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
            top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
          }
        }
        return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      };
      let hit = region();
      if (scroller && scroller.contains(element) && (hit.width < 44 || hit.height < 44)) {
        const before = scroller.scrollTop;
        const bounds = scroller.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        // Move only the scroll owner. scrollIntoView() on the target could
        // scroll the page/drawer and hide a different fixed control.
        if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
        else if (rect.top < bounds.top) scroller.scrollTop += rect.top - bounds.top;
        hit = region();
        scrolls.push({ selector, owner: scrollOwner, from: before, to: scroller.scrollTop,
          visible: { width: hit.width, height: hit.height } });
      }
      const rect = element.getBoundingClientRect();
      // Rounded 44px controls clip their extreme painted corners; sample
      // inside their rounded contour while still covering four quadrants.
      const insetX = Math.min(11, hit.width / 4), insetY = Math.min(11, hit.height / 4);
      const points = hit.width && hit.height ? [
        [hit.left + hit.width / 2, hit.top + hit.height / 2],
        [hit.left + insetX, hit.top + insetY], [hit.right - insetX, hit.top + insetY],
        [hit.left + insetX, hit.bottom - insetY], [hit.right - insetX, hit.bottom - insetY],
      ] : [];
      const blocked = points.map(point => {
        const x = point[0], y = point[1];
        const owner = document.elementFromPoint(x, y);
        return { x, y, owner: owner?.tagName.toLowerCase() ?? null,
          owned: owner === element || element.contains(owner) };
      }).filter(point => !point.owned);
      const pointerEvents = getComputedStyle(element).pointerEvents;
      const target = { selector, name, size: { width: rect.width, height: rect.height },
        visible: hit, pointerEvents, blocked,
        width: hit.width, height: hit.height, x: hit.left, y: hit.top,
        scrollTop: scroller?.contains(element) ? scroller.scrollTop : null };
      elements.push(target);
      if (Math.min(hit.width, hit.height) < 44) {
        failures.push(`${selector} (${name || 'unnamed'}) visible region is ${hit.width.toFixed(2)}x${hit.height.toFixed(2)}px (<44px)`);
      }
      if (pointerEvents === 'none') failures.push(`${selector} (${name || 'unnamed'}) has pointer-events: none`);
      if (blocked.length) failures.push(`${selector} (${name || 'unnamed'}) is occluded at ${blocked.length}/5 hit points`);
    }
    for (let i = 0; i < elements.length; i += 1) {
      const a = elements[i];
      for (let j = i + 1; j < elements.length; j += 1) {
        const b = elements[j];
        if (a.scrollTop === b.scrollTop
          && Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01
          && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01) {
          overlaps.push([a.selector, b.selector]);
          failures.push(`hit areas overlap: ${a.selector} and ${b.selector}`);
        }
      }
    }
  }
  return { coarseMatches, hoverNoneMatches, elements, overlaps, scrolls, failures, pass: failures.length === 0 };
}

/** Serialized focus probe for S24's workspace-action cancellation paths. */
export function probeCancellationFocus(options = {}) {
  const triggerSelector = options.triggerSelector;
  const trigger = document.querySelector(triggerSelector);
  const composer = document.querySelector('.th-pane--focused .th-chat-input textarea');
  const main = document.querySelector('main.th-main');
  const active = document.activeElement;
  const visible = element => {
    if (!(element instanceof HTMLElement) || !element.isConnected
      || element.matches(':disabled') || element.closest('[inert]')) return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const focusable = element => visible(element) && (
    element.matches('button:not([disabled]), textarea:not([disabled])')
    || element === main && element.hasAttribute('tabindex')
  );
  const selectorOf = element => element === trigger ? triggerSelector
    : element === composer ? '.th-pane--focused .th-chat-input textarea'
      : element === main ? 'main.th-main' : element?.tagName.toLowerCase() ?? null;
  const expected = focusable(trigger) ? trigger : focusable(composer) ? composer : main;
  const destination = {
    selector: selectorOf(active),
    connected: active?.isConnected === true,
    visible: visible(active),
    focusable: focusable(active),
  };
  const failures = [];
  if (active === document.body) failures.push('focus fell to body');
  if (!destination.connected || !destination.visible || !destination.focusable) {
    failures.push('focus destination is detached, hidden, or not focusable');
  }
  if (active !== expected) failures.push(`focus reached ${destination.selector}, expected ${selectorOf(expected)}`);
  return { ...destination, expectedSelector: selectorOf(expected), failures, pass: failures.length === 0 };
}

/** S24 G40 coarse-target scenario. The shared live
 * fixture starts with a normal context; only this second, measured context is
 * mobile/touch. The fixture and both contexts are closed on every outcome. */
export async function runShellCoarseTargets(ctx) {
  const env = await ctx.setupLive();
  const failures = [];
  const screenshots = [];
  const measurements = { elements: [], stages: [], scrolls: [], captures: [], focusReturns: [], pageErrors: [] };
  let touchContext;
  let teardown;
  try {
    const browser = env.context.browser();
    if (!browser) throw new Error('live fixture context has no browser');
    touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: ctx.theme,
    });
    // Keep the real fixture's final workspace/API, but prepend enough empty
    // workspaces to make its last row require the sidebar's own scrollport.
    // No DOM or product style is patched by this scenario.
    await touchContext.route('**/api/workspaces', async route => {
      const response = await route.fetch();
      const original = await response.json();
      const earlier = Array.from({ length: 12 }, (_, index) => ({
        id: `qa-top-${index}`, name: `Earlier workspace ${index + 1}`, path: `/fixture/earlier-${index}`,
        chats: [],
      }));
      await route.fulfill({ response, json: [...earlier, ...original] });
    });
    await touchContext.route(/\/api\/workspaces\/qa-top-\d+\/sessions(?:\?.*)?$/, route =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: '' }) }));
    await touchContext.route('**/api/providers', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'omo', label: 'omo', available: false }]),
    }));
    const page = await touchContext.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => measurements.pageErrors.push(String(error)));
    await installSignals(page, { theme: ctx.theme });
    await page.goto(env.fixture.url);
    await page.waitForSelector('.th-mobile-menu', { state: 'visible', timeout: 8000 });
    const capture = async (stage) => {
      await settleFiniteMotion(page);
      const media = await page.evaluate(() => ({
        pointerCoarse: matchMedia('(pointer: coarse)').matches,
        hoverNone: matchMedia('(hover: none)').matches,
        fontSize: getComputedStyle(document.documentElement).getPropertyValue('--th-font-size').trim(),
      }));
      measurements.captures.push({ stage, ...media });
      if (!media.pointerCoarse || !media.hoverNone) failures.push(`[${stage}] screenshot was not captured in a coarse/no-hover context`);
      screenshots.push(await ctx.save(page, `-${stage}`));
    };
    const measure = async (stage, root, required, scrollOwner = null) => {
      const result = await ctx.probe(page, probeShellCoarseTargets, { root, scrollOwner });
      measurements.stages.push({ stage, root, count: result.elements.length, coarseMatches: result.coarseMatches,
        hoverNoneMatches: result.hoverNoneMatches, failing: result.failures, overlaps: result.overlaps,
        scrolls: result.scrolls });
      measurements.elements.push(...result.elements.map(element => ({ stage, ...element })));
      measurements.scrolls.push(...result.scrolls.map(scroll => ({ stage, ...scroll })));
      failures.push(...result.failures.map(failure => `[${stage}] ${failure}`));
      for (const selector of required) {
        if (!result.elements.some(element => element.selector.includes(selector))) {
          failures.push(`[${stage}] required shell target ${selector} was not measured`);
        }
      }
      return result;
    };
    await deliverShellLive(env, ctx.constants.CHAT, []);
    await page.waitForSelector('.th-sidebar-live .th-overview-card-open', { state: 'attached', timeout: 6000 });
    const revealWorkspace = async index => {
      const scroll = await page.evaluate(index => {
        const owner = document.querySelector('.th-sidebar-body');
        const row = document.querySelectorAll('.th-tree-workspace')[index];
        if (!owner || !row) throw new Error(`workspace row ${index} or sidebar scroll owner missing`);
        const from = owner.scrollTop, bounds = owner.getBoundingClientRect(), rect = row.getBoundingClientRect();
        owner.scrollTop += rect.top - bounds.top - 8;
        return { index, from, to: owner.scrollTop, max: owner.scrollHeight - owner.clientHeight };
      }, index);
      measurements.scrolls.push({ stage: 'workspace-reveal', owner: '.th-sidebar-body', ...scroll });
      return scroll;
    };
    const openActions = async (index, stage) => {
      await revealWorkspace(index);
      const row = page.locator('.th-tree-workspace').nth(index);
      await row.locator('.th-tree-actions--overflow > button').click();
      await row.locator('.th-tree-overflow-item').first().waitFor({ state: 'visible', timeout: 4000 });
      await settleFiniteMotion(page);
      const menu = await measure(stage, '.th-tree-overflow', ['.th-tree-overflow-item'], '.th-sidebar-body');
      if (menu.elements.length !== 3) {
        failures.push(`[${stage}] expected three workspace actions, measured ${menu.elements.length}`);
      }
      await capture(stage);
      return row;
    };
    const dismissActions = async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.th-tree-overflow', { state: 'detached', timeout: 4000 });
    };
    const recordCancellationFocus = async (stage, row) => {
      const controls = await row.locator('.th-tree-actions--overflow > button').getAttribute('aria-controls');
      const focus = await ctx.probe(page, probeCancellationFocus, {
        triggerSelector: `button[aria-controls="${controls}"]`,
      });
      measurements.focusReturns.push({ stage, ...focus });
      failures.push(...focus.failures.map(failure => `[${stage}] ${failure}`));
    };
    for (const fontSize of [14, 15, 24]) {
      const prefix = fontSize === 14 ? '' : `font-${fontSize}-`;
      if (fontSize !== 14) {
        // The original installSignals init script reasserts 14 on reload;
        // install the same settings-path value later in script order.
        await page.addInitScript(size => localStorage.setItem('th-font-size', String(size)), fontSize);
        await page.reload();
        await page.waitForSelector('.th-mobile-menu', { state: 'visible', timeout: 8000 });
        await deliverShellLive(env, ctx.constants.CHAT, []);
      }
      const appliedFont = await page.evaluate(() => ({
        stored: localStorage.getItem('th-font-size'),
        computed: getComputedStyle(document.documentElement).getPropertyValue('--th-font-size').trim(),
      }));
      if (appliedFont.stored !== String(fontSize) || appliedFont.computed !== `${fontSize}px`) {
        failures.push(`[${prefix}font] persisted/computed font was ${JSON.stringify(appliedFont)}, expected ${fontSize}px`);
      }
      await measure(`${prefix}header`, '.th-termhead', ['.th-mobile-menu']);
      await openDrawer(page);
      await page.waitForSelector('.th-sidebar-live .th-overview-card-open', { state: 'visible', timeout: 6000 });
      await settleDrawerMotion(page);
      await capture(`${prefix}drawer`);
      const drawer = await measure(`${prefix}drawer`, '.th-sidebar', [
        '.th-sidebar-nav-actions', '.th-overview-card-open', '.th-btn-add', '.th-tree-chevron',
        '.th-tree-activation', '.th-tree-actions', '.th-sidebar-footer', '.th-tree-more',
      ], '.th-sidebar-body');
      if (!drawer.elements.some(element => element.selector.includes('.th-tree-more'))) {
        failures.push(`[${prefix}drawer] workspace session pagination was not measured`);
      }
      await openActions(0, `${prefix}actions-top`);
      await dismissActions();
      const lastIndex = await page.locator('.th-tree-workspace').count() - 1;
      if (lastIndex < 1) failures.push(`[${prefix}actions-bottom] fixture lacks a distinct last workspace`);
      const last = await openActions(lastIndex, `${prefix}actions-bottom`);
      if (fontSize === 14 || fontSize === 24) {
        await page.keyboard.press('Tab');
        const actionFocused = await last.locator('.th-tree-overflow-item').first()
          .evaluate(element => document.activeElement === element);
        if (!actionFocused) failures.push(`[${prefix}actions-bottom-focus] Tab did not focus the first popup action`);
        await capture(`${prefix}actions-bottom-focus`);
        await dismissActions();
        const triggerFocused = await last.locator('.th-tree-actions--overflow > button')
          .evaluate(element => document.activeElement === element);
        if (!triggerFocused) failures.push(`[${prefix}actions-bottom-focus] Escape did not restore the last workspace trigger`);
      } else await dismissActions();
      if (fontSize === 14) {
        await openActions(lastIndex, 'actions-bottom-rename');
        await last.locator('.th-tree-overflow-item').nth(0).click();
        await last.locator('.th-tree-rename').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await last.locator('.th-tree-rename').waitFor({ state: 'detached' });
        await recordCancellationFocus('actions-bottom-rename-cancel', last);
        await openActions(lastIndex, 'actions-bottom-add');
        await last.locator('.th-tree-overflow-item').nth(1).click();
        await page.waitForSelector('.th-modal-overlay .th-modal[role="dialog"]', { state: 'visible' });
        await page.keyboard.press('Escape');
        await page.waitForSelector('.th-modal-overlay', { state: 'detached' });
        await recordCancellationFocus('actions-bottom-add-cancel', last);
        await openDrawer(page);
        await openActions(lastIndex, 'actions-bottom-delete');
        await last.locator('.th-tree-overflow-item').nth(2).click();
        await page.waitForSelector('.th-confirm', { state: 'visible' });
        await page.locator('.th-confirm-actions button').first().click();
        await page.waitForSelector('.th-confirm', { state: 'detached' });
        await recordCancellationFocus('actions-bottom-delete-cancel', last);
      }
    }
    await focusEmptyLayout(env);
    // Inspect the empty picker at each setting, without moving back to an
    // occupied layout in between (the previous pane-close is intentional).
    for (const fontSize of [24, 15, 14]) {
      const prefix = fontSize === 14 ? '' : `font-${fontSize}-`;
      await page.addInitScript(size => localStorage.setItem('th-font-size', String(size)), fontSize);
      await page.reload();
      await page.waitForSelector('.th-empty .th-picker-pane', { state: 'visible', timeout: 8000 });
      const appliedFont = await page.evaluate(() => ({
        stored: localStorage.getItem('th-font-size'),
        computed: getComputedStyle(document.documentElement).getPropertyValue('--th-font-size').trim(),
      }));
      if (appliedFont.stored !== String(fontSize) || appliedFont.computed !== `${fontSize}px`) {
        failures.push(`[${prefix}empty] persisted/computed font was ${JSON.stringify(appliedFont)}, expected ${fontSize}px`);
      }
      await page.locator('.th-picker-pane select').selectOption('ws');
      await page.waitForSelector('.th-picker-pane-item', { state: 'visible', timeout: 8000 });
      await settleFiniteMotion(page);
      await measure(`${prefix}empty`, '.th-empty', [
        '.th-empty-menu', '.th-empty-hero', 'select:nth-of-type', '.th-picker-pane-item',
        'button.th-btn.th-btn--ghost', '.th-picker-pane-create',
      ], '.th-empty');
      await capture(`${prefix}empty`);
    }
    if (measurements.pageErrors.length) failures.push(...measurements.pageErrors.map(error => `page error: ${error}`));
  } catch (error) {
    failures.push(`harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    if (touchContext) {
      try { await touchContext.close(); } catch (error) { failures.push(`touch context close failed: ${errLine(error)}`); }
    }
    teardown = await closeEnv(env);
  }
  return { scenario: 'S24', pass: failures.length === 0, measurements, failures, screenshots, teardown };
}

/** Plugin export merged over the built-in registry by visual-redesign.mjs. */
export const scenarios = Object.freeze({
  'S5:shell': runStateColorsShell,
  S10: runSidebarSelection,
  S11: runEmptyState,
  S24: runShellCoarseTargets,
});
