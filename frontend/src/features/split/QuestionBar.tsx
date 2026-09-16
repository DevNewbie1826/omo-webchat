import { useId, useRef } from "react";
import { useT } from "../../i18n";
import { questionKey } from "../../lib/chatWsParseApproval";
import type { ApprovalFrame, QuestionAnswer } from "../../lib/contract/types_gen";
import { questionDraftResponse, useApprovalQuestionDraft } from "./ApprovalDockQuestions";
import { QuestionDraftNotice } from "./QuestionDraftNotice";

export interface QuestionBarProps {
	/** A non-blocking question request (method "question"): it never takes
	 *  over the composer and is answered only through this widget. */
	readonly request: ApprovalFrame;
	readonly onAnswer: (answers: Record<string, QuestionAnswer>, comment?: string) => void;
}

/** After an answer leaves, hand focus to the owning pane's composer so the
 *  user keeps typing where they already were (the dock's exit pattern). */
function focusPaneComposer(bar: HTMLElement | null): void {
	bar
		?.closest(".th-chat-pane")
		?.querySelector<HTMLElement>(".th-chat-input textarea")
		?.focus();
}

/** Compact one-line question widget above the composer. The composer stays
 *  fully usable while a question is pending: ordinary typing and Enter send
 *  normal chat messages and never consume the question. Nothing here steals
 *  focus on arrival — only an explicit click on the answer control moves
 *  focus into the widget. */
export function QuestionBar({ request, onAnswer }: QuestionBarProps) {
	const { t } = useT();
	const titleId = useId();
	const sectionRef = useRef<HTMLElement>(null);
	const questions = request.questions ?? [];
	const [storedDraft, setDraft] = useApprovalQuestionDraft(request.id, questions);
	const firstUnanswered = questions.findIndex((question, index) => !storedDraft.answers.get(questionKey(question, index))?.completed);
	// Keep the current input active while editing, but never skip an earlier
	// question whose answer disappeared during reconciliation.
	const activeIndex = Math.min(storedDraft.activeIndex, firstUnanswered < 0 ? Math.max(questions.length - 1, 0) : firstUnanswered);
	const draft = activeIndex === storedDraft.activeIndex ? storedDraft : { ...storedDraft, activeIndex, answering: false };
	const question = questions[activeIndex];
	const questionId = questionKey(question, activeIndex);
	const options = (question?.options ?? []).filter(
		(option): option is typeof option & { readonly label: string } =>
			option.label !== undefined,
	);
	const multiSelect = question?.multiSelect === true;
	const entry = draft.answers.get(questionId) ?? { selected: [], text: "", completed: false };
	const { text, selected: picked } = entry;
	const answering = options.length === 0 && draft.answering;

	const answer = (value: QuestionAnswer): void => {
		const completed = { ...draft, answers: new Map(draft.answers).set(questionId, {
			selected: value.selected ?? entry.selected,
			text: value.text ?? entry.text,
			// Explicitly sending blank text differs from leaving a question unanswered.
			...(value.text !== undefined ? { textAnswered: true } : {}),
			completed: true,
		}) };
		// Sequence inside the one-line band; settle only after every question
		// has an answer so an unseen remainder can never be discarded.
		const nextUnanswered = questions.findIndex((question, index) => !completed.answers.get(questionKey(question, index))?.completed);
		if (nextUnanswered >= 0) {
			setDraft({ ...completed, activeIndex: nextUnanswered, answering: false });
		} else {
			const response = questionDraftResponse(completed, questions);
			onAnswer(response.answers, response.comment);
		}
		focusPaneComposer(sectionRef.current);
	};

	const togglePick = (label: string): void => {
		setDraft({ ...draft, answers: new Map(draft.answers).set(questionId, {
			...entry,
			invalidated: false,
			completed: false,
			selected: picked.includes(label) ? picked.filter((item) => item !== label) : [...picked, label],
		}) });
	};

	return (
		<>
		<QuestionDraftNotice answers={draft.answers} questions={questions} />
		<section
			ref={sectionRef}
			className="th-question-bar"
			aria-labelledby={titleId}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || !answering) return;
				event.preventDefault();
				setDraft({ ...draft, answering: false });
				focusPaneComposer(event.currentTarget);
			}}
		>
			<span id={titleId} className="th-question-bar-text">
				{question?.question ?? request.title ?? t("question.label")}
			</span>
			{!answering && options.length > 0 && (
				<span className="th-question-bar-actions">
					{/* Chips live in their own scroll lane so a narrow pane clips the
					 *  lane — never the row; Send stays pinned outside it. */}
					<span className="th-question-bar-options">
					{options.map((option) =>
						multiSelect ? (
							<button
								key={option.label}
								type="button"
								className={
									picked.includes(option.label)
										? "th-btn"
										: "th-btn th-btn--ghost"
								}
								aria-pressed={picked.includes(option.label)}
								title={option.description}
								onClick={() => togglePick(option.label)}
							>
								{option.label}
							</button>
						) : (
							<button
								key={option.label}
								type="button"
								className="th-btn th-btn--ghost"
								title={option.description}
								onClick={() => answer({ selected: [option.label] })}
							>
								{option.label}
							</button>
						),
					)}
					</span>
					{multiSelect && (
						<button
							type="button"
							className="th-btn th-question-bar-send"
							disabled={picked.length === 0}
							onClick={() => answer({ selected: picked })}
						>
							{t("question.submit")}
						</button>
					)}
				</span>
			)}
			{!answering && options.length === 0 && (
				<button
					type="button"
					className="th-btn th-btn--ghost"
					onClick={() => {
						setDraft({ ...draft, answering: true });
						// Explicit user gesture: focus moves into the answer field.
						requestAnimationFrame(() => {
							sectionRef.current
								?.querySelector<HTMLElement>(".th-question-bar-input")
								?.focus();
						});
					}}
				>
					{t("question.answer")}
				</button>
			)}
			{answering && (
				<form
					className="th-question-bar-form"
					onSubmit={(event) => {
						event.preventDefault();
						answer({ text });
					}}
				>
					<input
						type="text"
						className="th-approval-input th-question-bar-input"
						placeholder={t("question.placeholder")}
						value={text}
						onChange={(event) => setDraft({ ...draft, answers: new Map(draft.answers).set(questionId, {
							...entry, invalidated: false, text: event.target.value, completed: false, textAnswered: false,
						}) })}
					/>
					<button type="submit" className="th-btn">
						{t("question.submit")}
					</button>
				</form>
			)}
		</section>
		</>
	);
}
