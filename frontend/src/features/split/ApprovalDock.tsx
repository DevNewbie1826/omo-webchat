import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { Question, QuestionAnswer } from "../../lib/contract/types_gen";
import { ApprovalFallbackForm, ApprovalFallbackNote, ApprovalFallbackSummaryActions } from "./ApprovalFallback";
import { ApprovalQuestionPanel, useApprovalQuestionDraft } from "./ApprovalDockQuestions";
import { computeShelfAvailableSpace } from "./useShelfAvailableSpace";
import { useGlobalKeyboardOpen } from "../../lib/useGlobalKeyboardOpen";

export interface ApprovalRequest {
	readonly id: string;
	readonly method: "select" | "confirm" | "input" | "editor" | "question" | "fallback";
	readonly title?: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly prefill?: string;
	readonly placeholder?: string;
	readonly deadlineAtMs?: number;
	readonly remainingMs?: number;
	readonly questions?: readonly Question[];
}

export interface ApprovalResponse {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
	answers?: Record<string, QuestionAnswer>;
	comment?: string;
}

export interface ApprovalDockProps {
	readonly request: ApprovalRequest;
	readonly onRespond: (response: ApprovalResponse) => void;
}

const COUNTDOWN_TICK_MS = 1_000;

/** Expanded body below this many CSS pixels would render as an unreadable
 *  sliver: the dock opens in its collapsed one-line summary instead (the
 *  goal shelf's GOAL_PANEL_FLOOR_PX pattern) until the column has room
 *  again. The summary's expand toggle stays operable even there — a pending
 *  question must always be answerable. */
const APPROVAL_BODY_FLOOR_PX = 48;

/** Mirrors the `.th-approval-dock` max-height cap in approval-dock.css. */
const APPROVAL_DOCK_COLUMN_RATIO = 0.6;

/** Usable minimum of the tight density (explicit expansion under the floor):
 *  header plus one complete option row plus the dock's borders. The clamp
 *  never goes below this while expanded — a pending question always keeps a
 *  visible, clickable box; the transcript reserve goes to zero first and the
 *  composer is the only hard floor. */
const APPROVAL_TIGHT_MIN_DOCK_PX = 32;

/** The composer is the focus handoff target for every dock exit (answered,
 *  cancelled, collapsed, floor-collapsed). It lives inside `.th-chat-input`;
 *  a pane-wide `textarea` query would find the dock's own editor first. */
function focusPaneComposer(section: HTMLElement | null): void {
	section
		?.closest(".th-chat-pane")
		?.querySelector<HTMLElement>(".th-chat-input textarea")
		?.focus();
}

/** Deferred focus handoffs, keyed by request id. An unmount alone is NOT
 *  evidence of an exit: the same request id can be re-presented in one
 *  commit (a re-keyed wrapper, a pendingApproval -> pendingQuestion
 *  reclassification), which unmounts and remounts the dock without the
 *  user ever answering. A same-id mount cancels the pending handoff, so
 *  focus is only handed to the composer when the request really went away
 *  (an external resolution - local exits hand off synchronously). */
const pendingFocusHandoffs = new Map<string, ReturnType<typeof setTimeout>>();

export function ApprovalDock({ request, onRespond }: ApprovalDockProps) {
	const { t } = useT();
	const titleId = useId();
	const sectionRef = useRef<HTMLElement>(null);
	const [text, setText] = useState(request.prefill ?? "");
	const questionDraft = useApprovalQuestionDraft(request.id);
	// Manual collapse is keyed by request id: it is the user's intent about
	// THAT request. A new request id must never inherit it (a collapsed
	// one-line summary would hide the arrival), while a replay of the same
	// id still honours it.
	const [collapsedForId, setCollapsedForId] = useState<string | null>(null);
	const collapsed = collapsedForId === request.id;
	// True from the moment a respond callback fires until the unmount cleanup
	// consumes it: an exit the DOCK initiated hands focus to the composer
	// synchronously (no task-queue hop that drops focus to <body> for a tick,
	// which on iOS dismisses the keyboard mid-handoff).
	const exitedRef = useRef(false);
	// Keyboard awareness comes from the app-global decision: the boot
	// script raises data-th-keyboard-open when the visible viewport shrinks
	// past its threshold, and global.css shrinks #root by the same attribute.
	// The dock must not re-derive keyboard-ness from its own geometry — a
	// second judgment prices the keyboard twice (the #root shrink AND a local
	// clamp).
	const keyboardOpen = useGlobalKeyboardOpen();
	// The column clamp's measure() closure outlives renders; the keyboard
	// floor below must price the budget with the CURRENT keyboard state.
	const keyboardOpenRef = useRef(false);
	keyboardOpenRef.current = keyboardOpen;
	// Explicit user expansion, keyed by request id: overrides the space floor
	// so the toggle always works. A new request resets to the automatic
	// presentation.
	const [expandOverrideForId, setExpandOverrideForId] = useState<string | null>(null);
	const [columnSpace, setColumnSpace] = useState<{
		readonly clampPx: number | null;
		readonly minDockPx: number;
	}>({ clampPx: null, minDockPx: APPROVAL_BODY_FLOOR_PX });
	const headerHeightRef = useRef(0);

	// Measured clamp (the goal shelf's pattern): the column budgets the dock
	// like any other fixed band, excluding the dock itself so the measurement
	// cannot oscillate with the dock's own size. The transcript keeps its
	// reserve and scrolls — but the reserve yields to the dock's minimum
	// (header + borders + body floor) while a request is pending: the dock is
	// transient and urgent, transcript history can scroll, and the composer
	// band is the only hard floor.
	useEffect(() => {
		const section = sectionRef.current;
		const column = section?.closest<HTMLElement>(".th-chat-main");
		if (!section || !column || typeof ResizeObserver === "undefined") return;
		const measure = (): void => {
			const columnHeight = column.getBoundingClientRect().height;
			// A hidden/unlaid-out column has no usable measurement yet.
			if (columnHeight === 0) {
				setColumnSpace((previous) =>
					previous.clampPx === null ? previous : { ...previous, clampPx: null },
				);
				return;
			}
			// The floor must be decided from a density-INDEPENDENT input: the
			// tight density sheds header chrome, so measuring the header while
			// tight feeds the density decision's own output back in as its
			// input — the floor moves, the decision flips, and the loop
			// oscillates every frame. Only measure in a fixed density (the
			// normal header, or the collapsed summary, which is the same
			// one-line band); the tight density never updates the floor. The
			// first measurement always runs untight: `tight` requires a
			// measured clamp, which starts null.
			const band =
				section.querySelector(".th-approval-dock-header") ??
				section.querySelector(".th-approval-dock-summary");
			if (band && !section.classList.contains("th-approval-dock--tight")) {
				headerHeightRef.current = band.getBoundingClientRect().height;
			}
			// The floor and the budget both price the whole dock box: the
			// borders come out of the body, so they count against the minimum.
			const style = getComputedStyle(section);
			const borders =
				(Number.parseFloat(style.borderTopWidth) || 0) +
				(Number.parseFloat(style.borderBottomWidth) || 0);
			const minDockPx = headerHeightRef.current + borders + APPROVAL_BODY_FLOOR_PX;
			// Input-priority floor: while the keyboard holds the viewport short
			// AND focus sits inside the dock (the keyboard is typing into the
			// dock's own answer field), the transcript reserve yields further —
			// enough body for the pinned tab strip + the focused answer input +
			// the pinned actions row — so the slice the focused input must be
			// visible in actually exists. A keyboard raised for the COMPOSER
			// (focus outside the dock) must not inflate the dock: the transcript
			// keeps its reserve there.
			// This raises the budget's reserve-yield minimum ONLY: the collapse
			// decision (floorCollapsed) and the inline ceilings keep pricing
			// minDockPx, and the budget is still capped by the column's real
			// available space, so an unachievable band floor merely yields the
			// whole reserve — it can never push the composer out or collapse
			// the dock to its summary.
			let minSelfPx = minDockPx;
			const bandTabs = section.querySelector<HTMLElement>(".th-approval-question-tabs");
			const bandAnswer = section.querySelector<HTMLElement>(".th-approval-question-text");
			const bandActions = section.querySelector<HTMLElement>(".th-approval-question-actions");
			const bandBody = section.querySelector<HTMLElement>(".th-approval-dock-body");
			if (
				keyboardOpenRef.current &&
				section.contains(document.activeElement) &&
				bandTabs &&
				bandAnswer &&
				bandActions &&
				bandBody
			) {
				const bandPadBottom = Number.parseFloat(getComputedStyle(bandBody).paddingBottom) || 0;
				minSelfPx =
					headerHeightRef.current +
					borders +
					bandTabs.offsetHeight +
					bandAnswer.offsetHeight +
					bandActions.offsetHeight +
					bandPadBottom;
			}
			const budget = computeShelfAvailableSpace(column, section, { minSelfPx });
			const cap = Math.round(columnHeight * APPROVAL_DOCK_COLUMN_RATIO);
			const clampPx = Math.min(budget, cap);
			setColumnSpace((previous) =>
				previous.clampPx === clampPx && previous.minDockPx === minDockPx
					? previous
					: { clampPx, minDockPx },
			);
		};
		const observer = new ResizeObserver(measure);
		const watch = (): void => {
			observer.observe(column);
			for (const child of column.children) observer.observe(child);
			const content = column.querySelector(":scope > .th-chat-main-content");
			if (content) for (const child of content.children) observer.observe(child);
		};
		watch();
		measure();
		const mutation = new MutationObserver(() => {
			watch();
			measure();
		});
		mutation.observe(column, { childList: true, subtree: true });
		window.addEventListener("resize", measure);
		// The input-priority floor and the --keyboard modifier depend on WHERE
		// focus sits (the dock's answer field vs the composer), so focus moves
		// across the dock boundary re-measure too.
		section.addEventListener("focusin", measure);
		section.addEventListener("focusout", measure);
		return () => {
			observer.disconnect();
			mutation.disconnect();
			window.removeEventListener("resize", measure);
			section.removeEventListener("focusin", measure);
			section.removeEventListener("focusout", measure);
		};
	}, []);

	// Expansion floor: clamped below a usable minimum (header plus borders
	// plus one complete option row), the dock opens as the summary bar only —
	// never a sliver. `collapsed` keeps the user's intent, so the panel
	// returns on its own when the column gains space again; an explicit
	// toggle click overrides the floor, because a pending question must
	// always be answerable.
	const floorCollapsed =
		columnSpace.clampPx !== null && columnSpace.clampPx < columnSpace.minDockPx;
	// Below the tight density's usable minimum even an explicit expansion
	// cannot render a usable panel — forcing one in would push the composer
	// out of the column (the one hard floor). The arithmetic at 390x200: the
	// 156px column pays ~78px for the composer and ~44px for the control
	// strip, leaving ~30px — less than the tight minimum, so expansion is
	// impossible by arithmetic, not by policy. There the collapsed summary
	// itself becomes the answerable surface: the request's primary actions
	// render as a compact row inside the summary band, so the user answers
	// without expanding and nothing is pushed out.
	const expansionImpossible =
		columnSpace.clampPx !== null && columnSpace.clampPx < APPROVAL_TIGHT_MIN_DOCK_PX;
	const expanded =
		!collapsed &&
		(!floorCollapsed || (expandOverrideForId === request.id && !expansionImpossible));
	// An explicit expansion under the floor trades padding for answerability:
	// the tight density sheds vertical chrome so the header plus one complete
	// clickable option row fit whatever the column can give.
	const tight = expanded && floorCollapsed;

	// The dock must never render a zero-height or unusable box. When the
	// measured clamp is below the tight density's usable minimum, the tight
	// density's own floor (header + one complete option row + borders)
	// becomes the effective minimum.
	const effectiveMinDockPx = tight
		? APPROVAL_TIGHT_MIN_DOCK_PX
		: columnSpace.minDockPx;
	const effectiveClampPx =
		columnSpace.clampPx !== null
			? Math.max(columnSpace.clampPx, effectiveMinDockPx)
			: null;

	// Countdown target: an absolute deadline, or remainingMs measured from the
	// moment the update that carried it arrived. `remainingMs` is relative to
	// its own delivery, so the anchor follows the delivery rather than the
	// request id: a refresh of the SAME request that moves remainingMs — or
	// repeats the same value — restarts the countdown from that value. An
	// absolute deadlineAtMs ignores the anchor and stays fixed to the wall clock.
	//
	// The delivery's mark is the request's own options/questions array when it
	// has one, and otherwise the request object. Every delivery is parsed into
	// fresh objects, so both change exactly once per update; but a caller may
	// rebuild the request wrapper on every render (the structured-question dock
	// is assembled from the pending frame each time) while passing the delivered
	// array straight through, and re-anchoring on those rebuilds would peg the
	// countdown at its full value instead of letting it descend.
	const delivery: object = request.questions ?? request.options ?? request;
	const anchorRef = useRef<{ delivery: object; atMs: number } | null>(null);
	if (anchorRef.current?.delivery !== delivery) {
		anchorRef.current = { delivery, atMs: Date.now() };
	}
	const targetMs =
		request.deadlineAtMs ??
		(request.remainingMs !== undefined
			? anchorRef.current.atMs + request.remainingMs
			: undefined);

	// The clock is keyed to the countdown target: when a new request's
	// deadline replaces a long-pending request that never started an
	// interval, the first paint must already show the NEW request's
	// remaining time — not the stale mount-time clock corrected one tick
	// later. Adjusting during render (React's sanctioned pattern) re-anchors
	// before commit, so there is no one-frame flash of the stale value.
	const [clock, setClock] = useState<{ targetMs: number | undefined; nowMs: number }>(() => ({
		targetMs,
		nowMs: Date.now(),
	}));
	if (clock.targetMs !== targetMs) {
		setClock({ targetMs, nowMs: Date.now() });
	}
	useEffect(() => {
		if (targetMs === undefined) return;
		const timer = setInterval(
			() => setClock((previous) => ({ ...previous, nowMs: Date.now() })),
			COUNTDOWN_TICK_MS,
		);
		return () => clearInterval(timer);
	}, [targetMs]);
	const countdownSeconds =
		targetMs === undefined
			? undefined
			: Math.max(0, Math.ceil((targetMs - clock.nowMs) / 1000));

	// Focus discipline: only a newly arrived request or an explicit user
	// expansion (clicking or keying the expand control) moves focus to the
	// primary control. A space-driven expansion — the column grew, the floor
	// stopped forcing the summary — leaves existing focus untouched.
	// No trap: Tab leaves the panel freely.
	const arrivalFocusConsumedForRef = useRef<string | null>(null);
	const userExpandPendingRef = useRef(false);
	useEffect(() => {
		if (!expanded) {
			// A request that arrives collapsed is consumed: its later
			// space-driven expansion must not steal focus.
			arrivalFocusConsumedForRef.current = request.id;
			return;
		}
		const userRequested = userExpandPendingRef.current;
		userExpandPendingRef.current = false;
		const arrival = arrivalFocusConsumedForRef.current !== request.id;
		arrivalFocusConsumedForRef.current = request.id;
		if (!userRequested && !arrival) return;
		sectionRef.current
			?.querySelector<HTMLElement>("[data-approval-primary]")
			?.focus();
	}, [expanded, request.id]);

	// Keep the focused control fully inside the clamped body — after the
	// first measurement and after every re-measure (a resize changes the
	// clamp and with it the visible slice), not only on expansion.
	useEffect(() => {
		if (!expanded) return;
		const section = sectionRef.current;
		const body = section?.querySelector<HTMLElement>(".th-approval-dock-body");
		if (!section || !body) return;
		const active = document.activeElement;
		const target =
			active instanceof HTMLElement && body.contains(active)
				? active
				: section.querySelector<HTMLElement>("[data-approval-primary]");
		if (!target) return;
		const bodyRect = body.getBoundingClientRect();
		const rect = target.getBoundingClientRect();
		if (rect.bottom > bodyRect.bottom) body.scrollTop += rect.bottom - bodyRect.bottom;
		if (rect.top < bodyRect.top) body.scrollTop -= bodyRect.top - rect.top;
	}, [expanded, columnSpace.clampPx, request.id]);

	// Keyboard-aware height: the dock's bottom must stay inside the visual
	// viewport even in the frame before the column's ResizeObserver re-clamps
	// the measured budget. The cap is measured per viewport change (the dock's
	// top is laid out by the bands above it), floored at the same usable
	// minimum as the measured clamp — a pending question always keeps a
	// visible, clickable box — and never applied without a measurement.
	const [viewportCapPx, setViewportCapPx] = useState<number | null>(null);
	useLayoutEffect(() => {
		const section = sectionRef.current;
		if (!expanded || !section) {
			setViewportCapPx((previous) => (previous === null ? previous : null));
			return;
		}
		// Read the visual viewport imperatively: it is the only geometry that
		// sees a covering keyboard (iOS never shrinks the layout viewport).
		const update = (): void => {
			const viewport = window.visualViewport ?? null;
			const viewportBottom = viewport
				? viewport.offsetTop + viewport.height
				: window.innerHeight;
			const cap = Math.round(viewportBottom - section.getBoundingClientRect().top);
			setViewportCapPx((previous) =>
				previous !== null && Math.abs(previous - cap) < 1 ? previous : Math.max(cap, 0),
			);
		};
		update();
		const viewport = window.visualViewport ?? null;
		viewport?.addEventListener("resize", update);
		viewport?.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		return () => {
			viewport?.removeEventListener("resize", update);
			viewport?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, [expanded, keyboardOpen]);

	// Keyboard-aware scroll discipline: while an input inside the body holds
	// focus and the keyboard state transitions (the keyboard opening or
	// closing reshapes the visible slice), keep the focused input inside the
	// body's
	// ACTUAL visible slice — the band between the pinned tab strip and the
	// pinned actions row (either edge falls back to the body's own edge when
	// that band is not pinned). When the bands plus the input cannot all
	// fit, the focused input wins (it is the control being typed into): it
	// scrolls at most until its top reaches the slice top — never above it.
	// Input-priority fallback: when even that cannot seat the input above the
	// pinned actions row, the TAB band yields (position: static via the dock's
	// --input-priority modifier, so it scrolls with the content) — a pinned
	// strip must never cover the focused input that owns the slice. The
	// actions row keeps its pin (the documented secondary: Next/Submit stay
	// reachable under the input's priority). Both regime checks read pinned
	// offsets only (scroll-independent), so the decision cannot oscillate.
	const [tabsYield, setTabsYield] = useState(false);
	useLayoutEffect(() => {
		if (!expanded || !keyboardOpen) return;
		const section = sectionRef.current;
		const body = section?.querySelector<HTMLElement>(".th-approval-dock-body");
		if (!section || !body) return;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !body.contains(active)) return;
		if (!active.matches("input, textarea")) return;
		const tabs = body.querySelector<HTMLElement>(".th-approval-question-tabs");
		const actions = body.querySelector<HTMLElement>(".th-approval-question-actions");
		const bodyRect = body.getBoundingClientRect();
		const inputRect = active.getBoundingClientRect();
		const actionsRect = actions?.getBoundingClientRect();
		const tabsRect = tabs?.getBoundingClientRect();
		const actionsPinned =
			!!actions &&
			actionsRect !== undefined &&
			getComputedStyle(actions).position === "sticky" &&
			actionsRect.bottom <= bodyRect.bottom + 0.5;
		const tabsSticky = !!tabs && tabsRect !== undefined && getComputedStyle(tabs).position === "sticky";
		const tabsPinned = tabsSticky && tabsRect.top <= bodyRect.top + 0.5;
		// The slice reserves BOTH pinned bands: content scrolled beneath the
		// sticky tab strip is as invisible as content under the pinned actions.
		const sliceTop = tabsPinned ? tabsRect.bottom : bodyRect.top;
		const sliceBottom = actionsPinned && actionsRect ? actionsRect.top : bodyRect.bottom;
		const inputFits = inputRect.height <= sliceBottom - sliceTop + 0.5;
		if (tabsSticky && !tabsYield) {
			if (!inputFits && inputRect.height <= sliceBottom - bodyRect.top + 0.5) {
				// The slice cannot seat the input below the pinned tab band but
				// can without it: yield the tab band and re-run — the re-render
				// applies the modifier before this effect scrolls.
				setTabsYield(true);
				return;
			}
		} else if (
			tabsYield &&
			inputRect.height <= sliceBottom - (bodyRect.top + (tabsRect?.height ?? 0)) + 0.5
		) {
			setTabsYield(false);
			return;
		}
		const overBottom = inputRect.bottom - sliceBottom;
		const overTop = inputRect.top - sliceTop;
		let delta = 0;
		if (overTop < -0.5) delta = overTop;
		else if (overBottom > 0.5) delta = Math.min(overBottom, overTop);
		if (!actionsPinned && actionsRect) {
			const actionsDelta = Math.max(actionsRect.bottom - bodyRect.bottom, 0);
			// Scrolling past the input's top would push it above the slice:
			// cap the actions pull-in at the slice top.
			const cap = Math.max(overTop, delta);
			delta = Math.max(delta, Math.min(actionsDelta, cap));
		}
		if (delta !== 0) body.scrollTop += delta;
	}, [expanded, keyboardOpen, columnSpace.clampPx, tabsYield, request.id]);

	// scrollIntoView on focus: the browser's native focus scroll does not
	// reserve the pinned footer's band; scroll-padding-bottom on the body
	// does, so an explicit nearest-scroll keeps a focused field clear of the
	// actions row it would otherwise be scrolled under.
	useEffect(() => {
		const section = sectionRef.current;
		if (!expanded || !section) return;
		const onFocusIn = (event: FocusEvent): void => {
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				target.matches("input, textarea") &&
				typeof target.scrollIntoView === "function"
			) {
				target.scrollIntoView({ block: "nearest" });
			}
		};
		section.addEventListener("focusin", onFocusIn);
		return () => section.removeEventListener("focusin", onFocusIn);
	}, [expanded]);

	// A floor collapse unmounts the body without a user gesture; focus inside
	// it drops to <body>. Hand it to the composer rather than losing it.
	useEffect(() => {
		if (!floorCollapsed) return;
		if (document.activeElement !== document.body) return;
		focusPaneComposer(sectionRef.current);
	}, [floorCollapsed]);

	// A new request id starts a fresh draft; the previous request's typed text
	// must not leak into the new input/editor field.
	useEffect(() => {
		setText(request.prefill ?? "");
	}, [request.id, request.prefill]);

	// Collapsing hands focus back to the pane's composer textarea when present.
	useEffect(() => {
		if (!collapsed) return;
		focusPaneComposer(sectionRef.current);
	}, [collapsed]);

	// Unmounting with focus inside must not drop focus to document.body — but
	// an unmount alone is not an exit (see pendingFocusHandoffs). Layout
	// effect: its cleanup runs before the node leaves the DOM, while
	// document.activeElement still points inside the dock.
	useLayoutEffect(() => {
		const section = sectionRef.current;
		// A same-id mount after this instance's unmount is a remount, not an
		// exit: cancel any handoff a previous unmount of this request deferred.
		const cancelPending = (): void => {
			const timer = pendingFocusHandoffs.get(request.id);
			if (timer !== undefined) {
				clearTimeout(timer);
				pendingFocusHandoffs.delete(request.id);
			}
		};
		cancelPending();
		return () => {
			if (!section?.contains(document.activeElement)) return;
			if (exitedRef.current) {
				// Answered or cancelled from this dock: hand off synchronously.
				focusPaneComposer(section);
				return;
			}
			// No local exit — an external resolution would still deserve the
			// composer, but a remount must not steal focus. Defer by one task:
			// a same-id mount (same commit or later tick) cancels it.
			const id = request.id;
			const paneComposer =
				section
					?.closest(".th-chat-pane")
					?.querySelector<HTMLElement>(".th-chat-input textarea") ?? null;
			const stale = pendingFocusHandoffs.get(id);
			if (stale !== undefined) clearTimeout(stale);
			const timer = setTimeout(() => {
				pendingFocusHandoffs.delete(id);
				// Only catch focus that actually died on <body>: if anything
				// else already took it (a replacement request's arrival focus,
				// a remounted control), it owns focus now — never steal it.
				if (document.activeElement !== document.body) return;
				// The pane may itself have gone away (route change): only hand
				// off to a composer that is still connected.
				if (paneComposer?.isConnected) paneComposer.focus();
			}, 0);
			pendingFocusHandoffs.set(id, timer);
		};
		// request.id is read through the closure; the effect runs once per
		// mount and the latest id is what a remount cancels against.
	}, [request.id]);

	const submitValue = (value: string): void => {
		exitedRef.current = true;
		onRespond({ value });
	};
	const submitConfirm = (confirmed: boolean): void => {
		exitedRef.current = true;
		onRespond({ confirmed });
	};
	const cancel = (): void => {
		exitedRef.current = true;
		onRespond({ cancelled: true });
	};

	// Structured multi-question requests render as one tabbed panel owned by
	// ApprovalDockQuestions.tsx (a tab per question, one structured response).
	// The panel's own submit routes through the same exit discipline as every
	// other respond path.
	const questionPanel = request.method === "question" && (request.questions?.length ?? 0) > 0 && (
		<ApprovalQuestionPanel
			draftState={questionDraft}
			questions={request.questions ?? []}
			onSubmit={(response) => {
				exitedRef.current = true;
				onRespond(response);
			}}
			onCancel={cancel}
		/>
	);

	const countdown = countdownSeconds !== undefined && (
		<span className="th-approval-dock-countdown">
			{t("approval.remaining", { seconds: countdownSeconds })}
		</span>
	);

	// The expanded dock's inline ceiling: the measured column budget, further
	// bounded by the visual viewport's remaining space below the dock's top
	// when a viewport measurement exists. Both are floored at the same usable
	// minimum — a pending question always keeps a visible, clickable box.
	const viewportCeilingPx =
		viewportCapPx === null ? null : Math.max(viewportCapPx, effectiveMinDockPx);
	const expandedMaxPx =
		effectiveClampPx !== null || viewportCeilingPx !== null
			? Math.ceil(
					Math.min(
						effectiveClampPx ?? Number.POSITIVE_INFINITY,
						viewportCeilingPx ?? Number.POSITIVE_INFINITY,
					),
				)
			: null;

	return (
		<section
			ref={sectionRef}
			role="region"
			className={
				tight
					? "th-approval-dock th-approval-dock--tight"
					: !expanded && expansionImpossible
						? "th-approval-dock th-approval-dock--compact"
						: keyboardOpen && sectionRef.current?.contains(document.activeElement)
							? tabsYield
								? "th-approval-dock th-approval-dock--keyboard th-approval-dock--input-priority"
								: "th-approval-dock th-approval-dock--keyboard"
							: "th-approval-dock"
			}
			aria-labelledby={titleId}
			// While the clamp is measured, hold the yield with flex-shrink: 0 so a
			// long transcript's deficit lands on the transcript alone, and bound
			// the panel with an inline max-height (the column's real available
			// space, still under the CSS cqh cap). Collapsed, the one-line summary
			// is a fixed band: never let the column squeeze it into a sliver.
			style={
				expanded
				? expandedMaxPx !== null
					? // Round UP: rounding the fractional minimum down (74.34375 →
						  // 74) leaves the rendered body at 47.65625px — under the
						  // 48px floor. Ceil guarantees body >= floor; the
						  // sub-pixel difference comes out of the transcript
						  // reserve, never out of the composer.
							{ flexShrink: 0, maxHeight: `${Math.max(expandedMaxPx, 0)}px` }
						: undefined
					: // The collapsed summary is a fixed band (never squeezed);
					  // when expansion is impossible the band is also bounded by
					  // the measured budget so a wrapping action row scrolls
					  // inside it instead of pushing the composer out.
						expansionImpossible
						? {
								flexShrink: 0,
								maxHeight: `${Math.max(Math.ceil(columnSpace.clampPx ?? 0), 0)}px`,
							}
						: { flexShrink: 0 }
			}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || collapsed) return;
				event.preventDefault();
				setCollapsedForId(request.id);
			}}
		>
			{!expanded ? (
				<div className="th-approval-dock-summary">
					<span id={titleId} className="th-approval-dock-summary-title">
						{request.title ?? t("approval.title")}
					</span>
					{expansionImpossible ? (
						<>
							{countdown}
							{/* Expansion cannot fit even the tight dock here, so the
							    summary band itself carries the answers: the request's
							    primary actions as a compact row. No expand toggle —
							    a toggle that could only produce an overflowing
							    panel would be a lie. */}
							{request.method === "question" && questionPanel}
							{/* The unsupported fallback keeps its answerable compact row
							    (rendering lives in ApprovalFallback). */}
							{request.method === "fallback" && (
								<ApprovalFallbackSummaryActions
									onConfirm={() => submitConfirm(true)}
									onCancel={cancel}
								/>
							)}
							{request.method === "select" && (
								<div className="th-approval-dock-summary-actions">
									{(request.options ?? []).map((opt, index) => (
										<button
											key={opt}
											type="button"
											className="th-btn"
											data-approval-primary={index === 0 ? "" : undefined}
											onClick={() => submitValue(opt)}
										>
											{opt}
										</button>
									))}
									<button
										type="button"
										className="th-btn th-btn--ghost"
										data-approval-primary={
											(request.options ?? []).length === 0 ? "" : undefined
										}
										onClick={cancel}
									>
										{t("approval.cancel")}
									</button>
								</div>
							)}
							{request.method === "confirm" && (
								<div className="th-approval-dock-summary-actions">
									<button
										type="button"
										className="th-btn"
										data-approval-primary
										onClick={() => submitConfirm(true)}
									>
										{t("approval.confirm")}
									</button>
									<button
										type="button"
										className="th-btn th-btn--ghost"
										onClick={() => submitConfirm(false)}
									>
										{t("approval.deny")}
									</button>
									<button
										type="button"
										className="th-btn th-btn--ghost"
										onClick={cancel}
									>
										{t("approval.cancel")}
									</button>
								</div>
							)}
							{(request.method === "input" || request.method === "editor") && (
								<form
									className="th-approval-dock-summary-form"
									onSubmit={(event) => {
										event.preventDefault();
										submitValue(text);
									}}
								>
									{/* A one-line field stands in for the editor here: the
									    band cannot host a multiline area, and an answerable
									    single line beats an overflowing panel. */}
									<input
										type="text"
										className="th-approval-input"
										data-approval-primary
										placeholder={request.placeholder ?? ""}
										value={text}
										onChange={(event) => setText(event.target.value)}
									/>
									<button type="submit" className="th-btn">
										{t("approval.submit")}
									</button>
									<button
										type="button"
										className="th-btn th-btn--ghost"
										onClick={cancel}
									>
										{t("approval.cancel")}
									</button>
								</form>
							)}
						</>
					) : (
						<>
							<span className="th-approval-dock-summary-pending">
								{t("approval.pending")}
							</span>
							{countdown}
							{/* Always operable, even under the space floor: a pending
							    question must always be answerable. An explicit click
							    overrides the floor and moves focus to the primary
							    control; space-driven re-expansion never does. */}
							<button
								type="button"
								className="th-approval-dock-toggle"
								aria-label={t("approval.expand")}
								onClick={() => {
									userExpandPendingRef.current = true;
									setExpandOverrideForId(request.id);
									setCollapsedForId(null);
								}}
							>
								{t("approval.expand")}
							</button>
						</>
					)}
				</div>
			) : (
				<>
					<div className="th-approval-dock-header">
						<h3 id={titleId} className="th-approval-dock-title">
							{request.title ?? t("approval.title")}
						</h3>
						{countdown}
						<button
							type="button"
							className="th-approval-dock-toggle"
							aria-label={t("approval.collapse")}
							onClick={() => setCollapsedForId(request.id)}
						>
							{t("approval.collapse")}
						</button>
					</div>
					<div className="th-approval-dock-body">
						{request.method === "fallback" && <ApprovalFallbackNote />}
						{request.message && (
							<p className="th-approval-message">{request.message}</p>
						)}

						{request.method === "question" && questionPanel}

						{request.method === "select" && (
							<div className="th-approval-options">
								{(request.options ?? []).map((opt, index) => (
									<button
										key={opt}
										type="button"
										className="th-btn"
										data-approval-primary={index === 0 ? "" : undefined}
										onClick={() => submitValue(opt)}
									>
										{opt}
									</button>
								))}
								<button
									type="button"
									className="th-btn th-btn--ghost"
									data-approval-primary={
										(request.options ?? []).length === 0 ? "" : undefined
									}
									onClick={cancel}
								>
									{t("approval.cancel")}
								</button>
							</div>
						)}

						{request.method === "confirm" && (
							<div className="th-approval-options">
								<button
									type="button"
									className="th-btn"
									data-approval-primary
									onClick={() => submitConfirm(true)}
								>
									{t("approval.confirm")}
								</button>
								<button
									type="button"
									className="th-btn th-btn--ghost"
									onClick={() => submitConfirm(false)}
								>
									{t("approval.deny")}
								</button>
								<button
									type="button"
									className="th-btn th-btn--ghost"
									onClick={cancel}
								>
									{t("approval.cancel")}
								</button>
							</div>
						)}

						{(request.method === "input" || request.method === "editor") && (
							<form
								className="th-approval-form"
								onSubmit={(event) => {
									event.preventDefault();
									submitValue(text);
								}}
							>
								{request.method === "editor" ? (
									<textarea
										className="th-approval-input th-approval-editor"
										data-approval-primary
										placeholder={request.placeholder ?? ""}
										value={text}
										onChange={(event) => setText(event.target.value)}
									/>
								) : (
									<input
										type="text"
										className="th-approval-input"
										data-approval-primary
										placeholder={request.placeholder ?? ""}
										value={text}
										onChange={(event) => setText(event.target.value)}
									/>
								)}
								<button type="submit" className="th-btn">
									{t("approval.submit")}
								</button>
								<button
									type="button"
									className="th-btn th-btn--ghost"
									onClick={cancel}
								>
									{t("approval.cancel")}
								</button>
								</form>
						)}
						{request.method === "fallback" && (
							<ApprovalFallbackForm
								placeholder={request.placeholder}
								value={text}
								onValueChange={setText}
								onSubmitValue={submitValue}
								onConfirm={() => submitConfirm(true)}
								onCancel={cancel}
							/>
						)}
					</div>
				</>
			)}
		</section>
	);
}
