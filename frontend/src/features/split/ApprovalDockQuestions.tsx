import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useT } from "../../i18n";
import { lostQuestionAnswer, QuestionDraftNotice, RemovedQuestionNoticeContext } from "./QuestionDraftNotice";
import type { QuestionDraftAnswer, RemovedQuestionNotice } from "./QuestionDraftNotice";
import { questionKey } from "../../lib/chatWsParseApproval";
import type { Question, QuestionAnswer } from "../../lib/contract/types_gen";

export interface ApprovalQuestionPanelProps {
	/** Owned by the request, or by a standalone dock while collapsed. */
	readonly draftState: ReturnType<typeof useApprovalQuestionDraft>;
	readonly questions: readonly Question[];
	readonly onSubmit: (response: {
		answers: Record<string, QuestionAnswer>;
		comment?: string;
	}) => void;
	readonly onCancel: () => void;
}

/** Draft state for a structured multi-question request: one entry per
 *  question id, plus the optional overall comment. Keyed by request id so a
 *  new request never inherits the previous request's answers. */
interface QuestionDraft {
	readonly requestId: string;
	readonly activeIndex: number;
	readonly answers: ReadonlyMap<string, QuestionDraftAnswer>;
	readonly questions: readonly Question[];
	readonly removedQuestions: readonly RemovedQuestionNotice[];
	readonly comment: string;
	readonly answering: boolean;
}

/** Reconcile at refresh, not merely at submission: retired values must not revive. */
function reconcileDraft(draft: QuestionDraft, questions: readonly Question[]): QuestionDraft {
	const answers = new Map<string, QuestionDraftAnswer>();
	questions.forEach((question, index) => {
		const key = questionKey(question, index);
		const entry = draft.answers.get(key);
		if (!entry) return;
		const options = question.options ?? [];
		const valid = entry.selected.filter(label => options.some(option => option.label === label));
		const selected = question.multiSelect ? valid : valid.slice(0, 1);
		// Typed text is the question's own answer on refresh for options
		// questions too (their dedicated input sits under the options): a
		// refresh must never wipe it back to unanswered.
		const text = entry.text;
		const textAnswered = entry.textAnswered;
		const next = { selected, text, completed: false, ...(textAnswered !== undefined ? { textAnswered } : {}) };
		answers.set(key, selected.length === entry.selected.length && text === entry.text && textAnswered === entry.textAnswered
			? entry : { ...next, invalidated: entry.invalidated || lostQuestionAnswer(entry, next) });
	});
	const removed = draft.questions.flatMap((question, index) => {
		const key = questionKey(question, index), entry = draft.answers.get(key);
		return entry && !answers.has(key) && (entry.invalidated || lostQuestionAnswer(entry)) && !draft.removedQuestions.some(notice => notice.key === key)
			? [{ key, name: question.header ?? question.question, index }] : [];
	});
	const activeIndex = Math.min(draft.activeIndex, Math.max(questions.length - 1, 0));
	const sameQuestions = questions.length === draft.questions.length && questions.every((question, index) =>
		questionKey(question, index) === questionKey(draft.questions[index], index)
		&& question.header === draft.questions[index]?.header && question.question === draft.questions[index]?.question);
	return sameQuestions && activeIndex === draft.activeIndex && answers.size === draft.answers.size && [...answers].every(([key, entry]) => draft.answers.get(key) === entry)
		? draft : { ...draft, activeIndex, answers, questions, removedQuestions: removed.length ? [...draft.removedQuestions, ...removed] : draft.removedQuestions };
}

type QuestionDraftState = readonly [QuestionDraft, Dispatch<SetStateAction<QuestionDraft>>];
const QuestionDraftContext = createContext<QuestionDraftState | null>(null);

/** How long after a touch gesture a click is treated as the same tap. */
const TOUCH_CLICK_DEDUP_MS = 500;

/** How far the first touch may drift before a tap becomes a scroll drag. */
const TOUCH_MOVE_THRESHOLD_PX = 10;

/** One in-flight touch gesture on an option button: the first touch only
 *  (extra touches are ignored), tracked from touchstart to its touchend. */
interface OptionTouchGesture {
	/** Identifier of the tracked first touch, or null when the touchstart
	 *  carried no touch list (synthetic events in tests). */
	readonly identifier: number | null;
	readonly startX: number;
	readonly startY: number;
	lastY: number;
	moved: boolean;
	readonly scroller: HTMLElement | null;
}

/** One option toggle of a structured question. Touch contract (ported from
 *  the PR #177 keyboard work, selectors adapted to the window DOM — the
 *  focus scope is the dialog and the drag-scroll target is the window body):
 *  - FOCUS SCOPE: the touch contract applies only while focus is inside the
 *    question window (the typing context where the software keyboard must
 *    survive). With focus anywhere else, touches behave natively: nothing
 *    is canceled, the browser scrolls the list itself, and the synthesized
 *    click activates the option through onClick.
 *  - FOCUS KEEP: with focus inside the window, iOS Safari steals focus at
 *    the TOUCH level, before pointerdown - so touchstart is canceled. React
 *    registers root touchstart listeners as passive (scrolling-intervention
 *    emulation), which silently ignores preventDefault, hence native
 *    non-passive listeners on the button.
 *  - MOVEMENT GATE: the first touch's start point is recorded at
 *    touchstart; a displacement over TOUCH_MOVE_THRESHOLD_PX marks the
 *    gesture a drag. touchend activates only for taps (not moved) - a drag
 *    across the options must never submit the option it started on.
 *  - DRAG SCROLL: canceling touchstart kills native scrolling for the
 *    gesture, so while the contract is active a drag scrolls the window
 *    body manually by the touch delta on each touchmove.
 *  - CLICK DEDUP: canceling touchstart/touchend suppresses the synthesized
 *    click, so touchend applies the toggle itself for taps. onClick stays
 *    the mouse/keyboard path; a click landing within TOUCH_CLICK_DEDUP_MS of
 *    any completed gesture - tap OR drag, whose timestamp is recorded
 *    without activating - is that gesture's echo and ignored, so a drag's
 *    stray click cannot toggle either. The synthesized click always targets
 *    the touched button, so the dedup timestamp lives per button.
 *  - onPointerDown/onMouseDown preventDefault remains for desktop mouse
 *    focus (mousedown fires without any touch). Tabs and the action row
 *    keep default focus behavior: they switch or end the editing context,
 *    where focus-follows-tap is the honest outcome. */
function OptionButton({
	label,
	description,
	selected,
	onToggle,
}: {
	readonly label: string;
	readonly description: string | undefined;
	readonly selected: boolean;
	readonly onToggle: () => void;
}): ReactElement {
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const lastTouchActivation = useRef(0);
	const touchGesture = useRef<OptionTouchGesture | null>(null);
	useEffect(() => {
		const button = buttonRef.current;
		if (!button) return undefined;
		const windowRoot = button.closest(".th-question-window");
		const focusInsideWindow = (): boolean => {
			const active = document.activeElement;
			return windowRoot !== null && active !== null && windowRoot.contains(active);
		};
		const onTouchStart = (event: TouchEvent): void => {
			if (!focusInsideWindow()) return; // native: browser scrolls, click activates
			event.preventDefault();
			const touch = event.touches?.[0];
			touchGesture.current = {
				identifier: touch?.identifier ?? null,
				startX: touch?.clientX ?? 0,
				startY: touch?.clientY ?? 0,
				lastY: touch?.clientY ?? 0,
				moved: false,
				scroller: button.closest<HTMLElement>(".th-question-window-body"),
			};
		};
		const onTouchMove = (event: TouchEvent): void => {
			const gesture = touchGesture.current;
			if (!gesture || gesture.identifier === null) return;
			const touch = Array.from(event.touches ?? [])
				.concat(Array.from(event.changedTouches ?? []))
				.find((entry) => entry.identifier === gesture.identifier);
			if (!touch) return;
			if (!gesture.moved
				&& Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY)
					<= TOUCH_MOVE_THRESHOLD_PX) {
				gesture.lastY = touch.clientY;
				return;
			}
			gesture.moved = true;
			event.preventDefault();
			if (gesture.scroller) gesture.scroller.scrollTop += gesture.lastY - touch.clientY;
			gesture.lastY = touch.clientY;
		};
		const onTouchEnd = (event: TouchEvent): void => {
			const gesture = touchGesture.current;
			if (!gesture) return; // contract inactive: the native click activates
			if (gesture.identifier !== null
				&& !Array.from(event.changedTouches ?? [])
					.some((entry) => entry.identifier === gesture.identifier)) {
				return; // an ignored extra touch ended; the first is still down
			}
			touchGesture.current = null;
			event.preventDefault();
			// Taps and drags alike record the dedup timestamp: a drag must not
			// activate, and its stray click must not toggle afterwards either.
			lastTouchActivation.current = Date.now();
			if (!gesture.moved) onToggle();
		};
		button.addEventListener("touchstart", onTouchStart, { passive: false });
		button.addEventListener("touchmove", onTouchMove, { passive: false });
		button.addEventListener("touchend", onTouchEnd, { passive: false });
		return () => {
			button.removeEventListener("touchstart", onTouchStart);
			button.removeEventListener("touchmove", onTouchMove);
			button.removeEventListener("touchend", onTouchEnd);
		};
	}, [onToggle]);
	return (
		<button
			ref={buttonRef}
			type="button"
			className="th-approval-question-option"
			aria-pressed={selected}
			onClick={() => {
				if (Date.now() - lastTouchActivation.current < TOUCH_CLICK_DEDUP_MS) return;
				onToggle();
			}}
			onPointerDown={(event) => event.preventDefault()}
			onMouseDown={(event) => event.preventDefault()}
		>
			<span className="th-approval-question-option-label">{label}</span>
			{description && (
				<span className="th-approval-question-option-description">
					{description}
				</span>
			)}
		</button>
	);
}

/** This owner stays mounted when the same request changes presentation. */
export function QuestionDraftProvider({ requestId, children }: {
	readonly requestId: string;
	readonly children: ReactElement<{ readonly request: { readonly questions?: readonly Question[] } }>;
}) {
	const draftState = useApprovalQuestionDraft(requestId, children.props.request.questions ?? []);
	return <QuestionDraftContext.Provider value={draftState}>
		<RemovedQuestionNoticeContext.Provider value={draftState[0].removedQuestions}>{children}</RemovedQuestionNoticeContext.Provider>
	</QuestionDraftContext.Provider>;
}

/** Both presentations send the same per-question draft, including its comment. */
export function questionDraftResponse(draft: QuestionDraft, questions: readonly Question[]) {
	const answers = new Map<string, QuestionAnswer>();
	questions.forEach((question, index) => {
		const key = questionKey(question, index);
		const entry = draft.answers.get(key);
		if (!entry) return;
		const answer = {
			...(entry.selected.length > 0 ? { selected: entry.selected } : {}),
			...(entry.textAnswered || entry.text.trim() !== "" ? { text: entry.text } : {}),
		};
		if (answer.selected !== undefined || answer.text !== undefined) answers.set(key, answer);
	});
	return { answers: Object.fromEntries(answers), ...(draft.comment.trim() !== "" ? { comment: draft.comment } : {}) };
}

/** Tabbed panel for a structured multi-question request: one tab per
 *  question, option descriptions visible, each question's own multiSelect
 *  flag respected (single replaces, multi toggles), a free-text input for
 *  questions without options, and one optional overall comment. One Submit
 *  sends a single response with answers keyed by question id. Every
 *  question's draft lives in one record, so switching tabs never loses
 *  selections already made. */
export function useApprovalQuestionDraft(requestId: string, questions?: readonly Question[]): QuestionDraftState {
	const owned = useContext(QuestionDraftContext);
	const [draft, setDraft] = useState<QuestionDraft>({
		requestId,
		activeIndex: 0,
		answers: new Map(),
		questions: [], removedQuestions: [],
		comment: "",
		answering: false,
	});
	const current: QuestionDraft = draft.requestId !== requestId
		? { requestId, activeIndex: 0, answers: new Map(), questions: [], removedQuestions: [], comment: "", answering: false }
		: questions ? reconcileDraft(draft, questions) : draft;
	if (current !== draft) setDraft(current);

	return owned ?? [current, setDraft];
}

export function ApprovalQuestionPanel({
	draftState: [storedDraft, setDraft],
	questions,
	onSubmit,
	onCancel,
}: ApprovalQuestionPanelProps) {
	const { t } = useT();
	const commentId = useId();
	const draft = reconcileDraft(storedDraft, questions);
	useLayoutEffect(() => {
		if (draft !== storedDraft) setDraft(draft);
	}, [draft, storedDraft, setDraft]);
	const activeIndex = Math.min(draft.activeIndex, Math.max(questions.length - 1, 0));

	const patchDraft = (
		index: number,
		patch: { selected?: readonly string[]; text?: string },
	): void => {
		const question = questions[index];
		if (!question) return;
		const key = questionKey(question, index);
		const previous = draft.answers.get(key) ?? { selected: [], text: "", completed: false };
		setDraft({
			...draft,
			answering: patch.text !== undefined ? true : draft.answering,
			answers: new Map(draft.answers).set(key, {
				...previous,
				invalidated: false,
				selected: patch.selected ?? previous.selected,
				text: patch.text ?? previous.text,
				completed: patch.selected !== undefined && !question.multiSelect,
				...(patch.text !== undefined ? { textAnswered: false } : {}),
			}),
		});
	};

	const toggleOption = (index: number, label: string): void => {
		const question = questions[index];
		if (!question) return;
		const key = questionKey(question, index);
		const previous = draft.answers.get(key) ?? { selected: [], text: "", completed: false };
		if (question.multiSelect) {
			patchDraft(index, {
				selected: previous.selected.includes(label)
					? previous.selected.filter((entry) => entry !== label)
					: [...previous.selected, label],
			});
		} else {
			patchDraft(index, { selected: [label] });
		}
	};

	const submit = (): void => onSubmit(questionDraftResponse(draft, questions));
	const isLastQuestion = activeIndex >= questions.length - 1;
	const unanswered = questions.filter((question, index) => {
		const entry = draft.answers.get(questionKey(question, index));
		return !entry || (entry.selected.length === 0 && entry.text.trim() === "");
	}).length;

	return (
		<div className="th-approval-question">
			<QuestionDraftNotice answers={draft.answers} questions={questions} removedQuestions={draft.removedQuestions} />
			<div className="th-approval-question-tabs" role="tablist">
				{questions.map((question, index) => (
					<button
						key={questionKey(question, index)}
						type="button"
						role="tab"
						aria-selected={index === activeIndex}
						className="th-approval-question-tab"
						data-approval-primary={index === 0 ? "" : undefined}
						onClick={() => setDraft({ ...draft, activeIndex: index })}
					>
						{question.header ??
							question.question ??
							t("approval.question.tab", { index: index + 1 })}
					</button>
				))}
			</div>
			{questions.map((question, index) => {
				if (index !== activeIndex) return null;
				const entry = draft.answers.get(questionKey(question, index)) ?? {
					selected: [],
					text: "",
					completed: false,
				};
				const options = question.options ?? [];
				return (
					<div
						key={questionKey(question, index)}
						role="tabpanel"
						className="th-approval-question-panel"
					>
						{question.question && (
							<p className="th-approval-question-text-prompt">{question.question}</p>
						)}
						{options.length > 0 ? (
							<>
								<div className="th-approval-question-options">
									{options.map((option) => {
										const label = option.label ?? "";
										return (
											<OptionButton
												key={label}
												label={label}
												description={option.description}
												selected={entry.selected.includes(label)}
												onToggle={() => toggleOption(index, label)}
											/>
										);
									})}
								</div>

								{/* The question's own answer box: free text typed here is
								 * submitted as THIS question's answer alongside any selected
								 * option - never as the overall comment below. */}
								<input
									type="text"
									className="th-approval-input th-approval-question-text"
									placeholder={t("approval.question.answerOptionPlaceholder")}
									value={entry.text}
									onChange={(event) => patchDraft(index, { text: event.target.value })}
								/>
							</>
						) : (
							<input
								type="text"
								className="th-approval-input th-approval-question-text"
								placeholder={t("approval.question.answerPlaceholder")}
								value={entry.text}
								onChange={(event) => patchDraft(index, { text: event.target.value })}
							/>
						)}
					</div>
				);
			})}
			<div className="th-approval-question-comment-group">
				<label className="th-approval-question-comment-label" htmlFor={commentId}>
					{t("approval.question.commentLabel")}
				</label>
				<input
					id={commentId}
					type="text"
					className="th-approval-input th-approval-question-comment"
					placeholder={t("approval.question.commentPlaceholder")}
					value={draft.comment}
					onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
				/>
			</div>
			<div className="th-approval-question-actions">
				{unanswered > 0 && (
					<span className="th-approval-question-unanswered">
						{t("approval.question.unanswered", { count: unanswered })}
					</span>
				)}
				{isLastQuestion ? (
					<button type="button" className="th-btn" onClick={submit}>
						{t("approval.submit")}
				</button>
				) : (
					<button
						type="button"
						className="th-btn"
						onClick={() => setDraft({ ...draft, activeIndex: activeIndex + 1 })}
					>
						{t("approval.question.next")}
					</button>
				)}
				<button type="button" className="th-btn th-btn--ghost" onClick={onCancel}>
					{t("approval.cancel")}
				</button>
			</div>
		</div>
	);
}
