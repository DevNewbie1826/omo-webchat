import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { computeShelfAvailableSpace } from "./useShelfAvailableSpace";

export interface ApprovalRequest {
	readonly id: string;
	readonly method: "select" | "confirm" | "input" | "editor";
	readonly title?: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly prefill?: string;
	readonly placeholder?: string;
	readonly deadlineAtMs?: number;
	readonly remainingMs?: number;
}

export interface ApprovalDockProps {
	readonly request: ApprovalRequest;
	readonly onRespond: (response: {
		value?: string;
		confirmed?: boolean;
		cancelled?: boolean;
	}) => void;
}

const COUNTDOWN_TICK_MS = 1_000;

/** Expanded body below this many CSS pixels would render as an unreadable
 *  sliver: the dock falls back to its collapsed one-line summary instead
 *  (the goal shelf's GOAL_PANEL_FLOOR_PX pattern) until the column has room
 *  again. */
const APPROVAL_BODY_FLOOR_PX = 48;

/** Mirrors the `.th-approval-dock` max-height cap in approval-dock.css. */
const APPROVAL_DOCK_COLUMN_RATIO = 0.6;

export function ApprovalDock({ request, onRespond }: ApprovalDockProps) {
	const { t } = useT();
	const titleId = useId();
	const sectionRef = useRef<HTMLElement>(null);
	const [text, setText] = useState(request.prefill ?? "");
	const [collapsed, setCollapsed] = useState(false);
	const [columnClampPx, setColumnClampPx] = useState<number | null>(null);
	const headerHeightRef = useRef(0);

	// Measured clamp (the goal shelf's pattern): the column budgets the dock
	// like any other fixed band, excluding the dock itself so the measurement
	// cannot oscillate with the dock's own size. The transcript keeps its
	// reserve and scrolls; the dock yields only below the readability floor.
	useEffect(() => {
		const section = sectionRef.current;
		const column = section?.closest<HTMLElement>(".th-chat-main");
		if (!section || !column || typeof ResizeObserver === "undefined") return;
		const measure = (): void => {
			const columnHeight = column.getBoundingClientRect().height;
			// A hidden/unlaid-out column has no usable measurement yet.
			if (columnHeight === 0) {
				setColumnClampPx(null);
				return;
			}
			const header = section.querySelector(".th-approval-dock-header");
			if (header) headerHeightRef.current = header.getBoundingClientRect().height;
			const budget = computeShelfAvailableSpace(column, section);
			const cap = Math.round(columnHeight * APPROVAL_DOCK_COLUMN_RATIO);
			const next = Math.min(budget, cap);
			setColumnClampPx((previous) => (previous === next ? previous : next));
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

	// Expansion floor: clamped below a usable minimum (header plus one
	// complete option row), show the summary bar only — never a sliver.
	// `collapsed` keeps the user's intent, so the panel returns on its own
	// when the column gains space again.
	const floorCollapsed =
		columnClampPx !== null &&
		columnClampPx < headerHeightRef.current + APPROVAL_BODY_FLOOR_PX;
	const expanded = !collapsed && !floorCollapsed;

	// Countdown target: an absolute deadline, or remainingMs anchored to the
	// moment this request arrived. Re-anchored when a new request id shows up.
	const anchorRef = useRef<{ id: string; atMs: number } | null>(null);
	if (anchorRef.current?.id !== request.id) {
		anchorRef.current = { id: request.id, atMs: Date.now() };
	}
	const targetMs =
		request.deadlineAtMs ??
		(request.remainingMs !== undefined
			? anchorRef.current.atMs + request.remainingMs
			: undefined);

	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		if (targetMs === undefined) return;
		const timer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
		return () => clearInterval(timer);
	}, [targetMs]);
	const countdownSeconds =
		targetMs === undefined ? undefined : Math.max(0, Math.ceil((targetMs - nowMs) / 1000));

	// Move focus to the primary control so a keyboard user can answer at once,
	// both on arrival and when a collapsed panel expands again.
	// No trap: Tab leaves the panel freely.
	useEffect(() => {
		if (!expanded) return;
		const primary =
			sectionRef.current?.querySelector<HTMLElement>("[data-approval-primary]");
		if (!primary) return;
		primary.focus();
		// A height-clamped body opens at its scroll top; a long message would
		// leave the focused primary control below the visible slice.
		const body = sectionRef.current?.querySelector<HTMLElement>(
			".th-approval-dock-body",
		);
		if (!body) return;
		const bodyRect = body.getBoundingClientRect();
		const rect = primary.getBoundingClientRect();
		if (rect.bottom > bodyRect.bottom) body.scrollTop += rect.bottom - bodyRect.bottom;
		else if (rect.top < bodyRect.top) body.scrollTop -= bodyRect.top - rect.top;
	}, [request.id, expanded]);

	// A floor collapse unmounts the body without a user gesture; focus inside
	// it drops to <body>. Hand it to the composer rather than losing it.
	useEffect(() => {
		if (!floorCollapsed) return;
		if (document.activeElement !== document.body) return;
		sectionRef.current
			?.closest(".th-chat-pane")
			?.querySelector<HTMLElement>("textarea")
			?.focus();
	}, [floorCollapsed]);

	// A new request id starts a fresh draft; the previous request's typed text
	// must not leak into the new input/editor field.
	useEffect(() => {
		setText(request.prefill ?? "");
	}, [request.id, request.prefill]);

	// Collapsing hands focus back to the pane's composer textarea when present.
	useEffect(() => {
		if (!collapsed) return;
		sectionRef.current
			?.closest(".th-chat-pane")
			?.querySelector<HTMLElement>("textarea")
			?.focus();
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
			section
				.closest(".th-chat-pane")
				?.querySelector<HTMLElement>("textarea")
				?.focus();
		};
	}, []);

	const submitValue = (value: string): void => onRespond({ value });
	const submitConfirm = (confirmed: boolean): void => onRespond({ confirmed });
	const cancel = (): void => onRespond({ cancelled: true });

	const countdown = countdownSeconds !== undefined && (
		<span className="th-approval-dock-countdown">
			{t("approval.remaining", { seconds: countdownSeconds })}
		</span>
	);

	return (
		<section
			ref={sectionRef}
			role="region"
			className="th-approval-dock"
			aria-labelledby={titleId}
			// While the clamp is measured, hold the yield with flex-shrink: 0 so a
			// long transcript's deficit lands on the transcript alone, and bound
			// the panel with an inline max-height (the column's real available
			// space, still under the CSS cqh cap). Collapsed, the one-line summary
			// is a fixed band: never let the column squeeze it into a sliver.
			style={
				expanded
					? columnClampPx !== null
						? { flexShrink: 0, maxHeight: `${Math.max(Math.round(columnClampPx), 0)}px` }
						: undefined
					: { flexShrink: 0 }
			}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || collapsed) return;
				event.preventDefault();
				setCollapsed(true);
			}}
		>
			{!expanded ? (
				<div className="th-approval-dock-summary">
					<span id={titleId} className="th-approval-dock-summary-title">
						{request.title ?? t("approval.title")}
					</span>
					<span className="th-approval-dock-summary-pending">
						{t("approval.pending")}
					</span>
					{countdown}
					{/* While the floor forces the collapse, expanding cannot work:
					    say so instead of inviting a click that changes nothing.
					    aria-disabled (not `disabled`) keeps the control in the tab
					    order so keyboard users can discover it and its reason. */}
					<button
						type="button"
						className={
							floorCollapsed
								? "th-approval-dock-toggle th-approval-dock-toggle--disabled"
								: "th-approval-dock-toggle"
						}
						aria-label={
							floorCollapsed
								? `${t("approval.expand")} — ${t("approval.noSpace")}`
								: t("approval.expand")
						}
						aria-disabled={floorCollapsed || undefined}
						title={floorCollapsed ? t("approval.noSpace") : undefined}
						onClick={() => {
							if (floorCollapsed) return;
							setCollapsed(false);
						}}
					>
						{t("approval.expand")}
					</button>
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
							onClick={() => setCollapsed(true)}
						>
							{t("approval.collapse")}
						</button>
					</div>
					<div className="th-approval-dock-body">
						{request.message && (
							<p className="th-approval-message">{request.message}</p>
						)}

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
					</div>
				</>
			)}
		</section>
	);
}
