import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ModalDialog } from "../../components/ModalDialog";
import { useT } from "../../i18n";
import type { Question, QuestionAnswer } from "../../lib/contract/types_gen";
import { ApprovalFallbackForm, ApprovalFallbackNote } from "./ApprovalFallback";
import { ApprovalQuestionPanel, useApprovalQuestionDraft } from "./ApprovalDockQuestions";

/** A pending approval/question request, mapped from the server frame
 *  (chatSessionState.approvalRequestOf keeps defined fields only). */
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

export interface QuestionWindowProps {
	readonly request: ApprovalRequest;
	/** False renders nothing (the notice band carries the pending request);
	 *  the window stays mounted so input/editor text survives collapse. */
	readonly open: boolean;
	/** Close (X), backdrop click, or Escape: fold back to the notice band
	 *  without responding. Reopening happens from the band. */
	readonly onCollapse: () => void;
	readonly onRespond: (response: ApprovalResponse) => void;
	/** Focus handoff target for every exit (the C3 semantics): the owning
	 *  pane's composer. Optional so headless unit mounts stay valid. */
	readonly focusComposer?: () => void;
}

const COUNTDOWN_TICK_MS = 1_000;

/** Countdown (whole seconds remaining) for a request deadline, or undefined
 *  when the request carries no deadline fields. An absolute deadlineAtMs is
 *  measured against the wall clock; a relative remainingMs is anchored to the
 *  moment its delivery arrived, and a redelivery — even one repeating the
 *  same value — restarts the countdown from that value. The anchor follows
 *  the request's own options/questions array when it has one (a caller may
 *  rebuild the request wrapper every render while passing the delivered
 *  array straight through), and otherwise the request object. */
export function useApprovalDeadlineCountdown(request: ApprovalRequest): number | undefined {
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
	return targetMs === undefined
		? undefined
		: Math.max(0, Math.ceil((targetMs - clock.nowMs) / 1000));
}

/** Deferred focus handoffs, keyed by request id. An unmount alone is NOT
 *  evidence of an exit: the same request id can be re-presented in one
 *  commit (a pendingApproval -> pendingQuestion reclassification), which
 *  unmounts and remounts the window without the user ever answering. A
 *  same-id mount cancels the pending handoff, so focus is only handed to
 *  the composer when the request really went away (an external resolution -
 *  local exits hand off synchronously). */
const pendingFocusHandoffs = new Map<string, ReturnType<typeof setTimeout>>();

/** Separate modal window for a pending approval/question request (replaces
 *  the retired inline dock). The body reuses the dock's content verbatim —
 *  options, confirm/deny, input/editor, the structured multi-question panel,
 *  and the unsupported-type fallback — inside a bounded scrollport. The
 *  window chrome (portal, overlay, initial focus, aria-modal, Escape, focus
 *  trap) belongs to ModalDialog; only the request content lives here.
 *
 *  Exits and focus (the C3 semantics): answering or cancelling is an
 *  explicit exit and hands focus to the pane's composer synchronously.
 *  Closing (X / backdrop / Escape) folds the window back to the notice band
 *  and likewise hands focus back. An unmount with focus inside and no
 *  local exit is an external resolution: the handoff is deferred one task so
 *  a same-id remount can cancel it, and it never steals focus that already
 *  landed somewhere else. */
export function QuestionWindow({
	request,
	open,
	onCollapse,
	onRespond,
	focusComposer,
}: QuestionWindowProps) {
	const { t } = useT();
	const titleId = useId();
	const contentRef = useRef<HTMLDivElement>(null);
	const [text, setText] = useState(request.prefill ?? "");
	const questionDraft = useApprovalQuestionDraft(request.id);
	const countdownSeconds = useApprovalDeadlineCountdown(request);
	// True from the moment a respond callback fires until the unmount cleanup
	// consumes it: an exit the WINDOW initiated hands focus to the composer
	// synchronously (no task-queue hop that drops focus to <body> for a tick,
	// which on iOS dismisses the keyboard mid-handoff).
	const exitedRef = useRef(false);
	const onRespondRef = useRef(onRespond);
	onRespondRef.current = onRespond;
	const onCollapseRef = useRef(onCollapse);
	onCollapseRef.current = onCollapse;
	const focusComposerRef = useRef(focusComposer);
	focusComposerRef.current = focusComposer;

	// A new request id starts a fresh draft; the previous request's typed text
	// must not leak into the new input/editor field.
	useEffect(() => {
		setText(request.prefill ?? "");
	}, [request.id, request.prefill]);

	// Collapsing hands focus back to the pane's composer. The transition
	// guard keeps the initial closed mount (and the settled request) from
	// touching focus.
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (open) {
			wasOpenRef.current = true;
			return;
		}
		if (!wasOpenRef.current) return;
		wasOpenRef.current = false;
		focusComposerRef.current?.();
	}, [open]);

	// Unmounting with focus inside must not drop focus to document.body — but
	// an unmount alone is not an exit (see pendingFocusHandoffs). Layout
	// effect: its cleanup runs before the node leaves the DOM, while
	// document.activeElement still points inside the window.
	useLayoutEffect(() => {
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
			const panel = contentRef.current?.closest(".th-modal");
			if (
				panel === undefined ||
				panel === null ||
				!panel.contains(document.activeElement)
			) {
				return;
			}
			if (exitedRef.current) {
				// Answered or cancelled from this window: hand off synchronously.
				focusComposerRef.current?.();
				return;
			}
			// No local exit — an external resolution would still deserve the
			// composer, but a remount must not steal focus. Defer by one task:
			// a same-id mount (same commit or later tick) cancels it.
			const id = request.id;
			const stale = pendingFocusHandoffs.get(id);
			if (stale !== undefined) clearTimeout(stale);
			const timer = setTimeout(() => {
				pendingFocusHandoffs.delete(id);
				// Only catch focus that actually died on <body>: if anything
				// else already took it (a replacement request's arrival focus,
				// a remounted control), it owns focus now — never steal it.
				if (document.activeElement !== document.body) return;
				focusComposerRef.current?.();
			}, 0);
			pendingFocusHandoffs.set(id, timer);
		};
		// request.id is read through the closure; the effect runs once per
		// mount and the latest id is what a remount cancels against.
	}, [request.id]);

	const submitValue = (value: string): void => {
		exitedRef.current = true;
		onRespondRef.current({ value });
	};
	const submitConfirm = (confirmed: boolean): void => {
		exitedRef.current = true;
		onRespondRef.current({ confirmed });
	};
	const cancel = (): void => {
		exitedRef.current = true;
		onRespondRef.current({ cancelled: true });
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
				onRespondRef.current(response);
			}}
			onCancel={cancel}
		/>
	);

	return (
		<ModalDialog
			open={open}
			onClose={() => onCollapseRef.current()}
			labelledBy={titleId}
			closeLabel={t("common.close")}
			initialFocusSelector="[data-approval-primary]"
		>
			<div ref={contentRef} className="th-question-window">
				<div className="th-question-window-head">
					<h3 id={titleId} className="th-question-window-title">
						{request.title ?? t("approval.title")}
					</h3>
					{countdownSeconds !== undefined && (
						<span className="th-question-window-countdown">
							{t("approval.remaining", { seconds: countdownSeconds })}
						</span>
					)}
				</div>
				<div className="th-question-window-body">
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
			</div>
		</ModalDialog>
	);
}
