import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { Question, QuestionAnswer } from "../../lib/contract/types_gen";
import { ApprovalFallbackForm, ApprovalFallbackNote, ApprovalFallbackSummaryActions } from "./ApprovalFallback";
import { ApprovalQuestionPanel, useApprovalQuestionDraft } from "./ApprovalDockQuestions";
import { computeShelfAvailableSpace } from "./useShelfAvailableSpace";

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
			const budget = computeShelfAvailableSpace(column, section, { minSelfPx: minDockPx });
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
		return () => {
			observer.disconnect();
			mutation.disconnect();
			window.removeEventListener("resize", measure);
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

	// Unmounting (answered, or resolved by another client) must not drop focus
	// to document.body: if the dock still holds focus, hand it to the owning
	// pane's composer. Focus elsewhere is left untouched — never steal it.
	// Layout effect: its cleanup runs before the node leaves the DOM, while
	// document.activeElement still points inside the dock.
	useLayoutEffect(() => {
		const section = sectionRef.current;
		return () => {
			if (!section?.contains(document.activeElement)) return;
			focusPaneComposer(section);
		};
	}, []);

	const submitValue = (value: string): void => onRespond({ value });
	const submitConfirm = (confirmed: boolean): void => onRespond({ confirmed });
	const cancel = (): void => onRespond({ cancelled: true });

	// Structured multi-question requests render as one tabbed panel owned by
	// ApprovalDockQuestions.tsx (a tab per question, one structured response).
	const questionPanel = request.method === "question" && (request.questions?.length ?? 0) > 0 && (
		<ApprovalQuestionPanel
			draftState={questionDraft}
			questions={request.questions ?? []}
			onSubmit={onRespond}
			onCancel={cancel}
		/>
	);

	const countdown = countdownSeconds !== undefined && (
		<span className="th-approval-dock-countdown">
			{t("approval.remaining", { seconds: countdownSeconds })}
		</span>
	);

	return (
		<section
			ref={sectionRef}
			role="region"
			className={
				tight
					? "th-approval-dock th-approval-dock--tight"
					: !expanded && expansionImpossible
						? "th-approval-dock th-approval-dock--compact"
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
					? effectiveClampPx !== null
						? // Round UP: rounding the fractional minimum down (74.34375 →
						  // 74) leaves the rendered body at 47.65625px — under the
						  // 48px floor. Ceil guarantees body >= floor; the
						  // sub-pixel difference comes out of the transcript
						  // reserve, never out of the composer.
							{ flexShrink: 0, maxHeight: `${Math.max(Math.ceil(effectiveClampPx), 0)}px` }
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
