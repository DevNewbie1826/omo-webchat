import { createContext, useContext, useLayoutEffect, useState } from "react";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useT } from "../../i18n";
import { QuestionDraftNotice } from "./QuestionDraftNotice";
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

type QuestionDraftAnswer = {
	readonly selected: readonly string[];
	readonly text: string;
	readonly textAnswered?: boolean;
	/** Explicit single-choice activation or inline Send, never draft presence. */
	readonly completed: boolean;
	readonly invalidated?: boolean;
};

/** Draft state for a structured multi-question request: one entry per
 *  question id, plus the optional overall comment. Keyed by request id so a
 *  new request never inherits the previous request's answers. */
interface QuestionDraft {
	readonly requestId: string;
	readonly activeIndex: number;
	readonly answers: ReadonlyMap<string, QuestionDraftAnswer>;
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
		const text = options.length === 0 ? entry.text : "";
		const textAnswered = options.length === 0 ? entry.textAnswered : undefined;
		answers.set(key, selected.length === entry.selected.length && text === entry.text && textAnswered === entry.textAnswered
			? entry : { selected, text, completed: false, invalidated: true, ...(textAnswered !== undefined ? { textAnswered } : {}) });
	});
	const activeIndex = Math.min(draft.activeIndex, Math.max(questions.length - 1, 0));
	return activeIndex === draft.activeIndex && answers.size === draft.answers.size && [...answers].every(([key, entry]) => draft.answers.get(key) === entry)
		? draft : { ...draft, activeIndex, answers };
}

type QuestionDraftState = readonly [QuestionDraft, Dispatch<SetStateAction<QuestionDraft>>];
const QuestionDraftContext = createContext<QuestionDraftState | null>(null);

/** This owner stays mounted when the same request changes presentation. */
export function QuestionDraftProvider({ requestId, children }: {
	readonly requestId: string;
	readonly children: ReactElement<{ readonly request: { readonly questions?: readonly Question[] } }>;
}) {
	const draftState = useApprovalQuestionDraft(requestId, children.props.request.questions ?? []);
	return <QuestionDraftContext.Provider value={draftState}>{children}</QuestionDraftContext.Provider>;
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
		comment: "",
		answering: false,
	});
	const current = draft.requestId !== requestId
		? { requestId, activeIndex: 0, answers: new Map(), comment: "", answering: false }
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

	return (
		<div className="th-approval-question">
			<QuestionDraftNotice answers={draft.answers} questions={questions} />
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
							<div className="th-approval-question-options">
								{options.map((option) => {
									const label = option.label ?? "";
									const selected = entry.selected.includes(label);
									return (
										<button
											key={label}
											type="button"
											className="th-approval-question-option"
											aria-pressed={selected}
											onClick={() => toggleOption(index, label)}
										>
											<span className="th-approval-question-option-label">{label}</span>
											{option.description && (
												<span className="th-approval-question-option-description">
													{option.description}
												</span>
											)}
										</button>
									);
								})}
							</div>
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
			<input
				type="text"
				className="th-approval-input th-approval-question-comment"
				placeholder={t("approval.question.commentPlaceholder")}
				value={draft.comment}
				onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
			/>
			<div className="th-approval-question-actions">
				<button type="button" className="th-btn" onClick={submit}>
					{t("approval.submit")}
				</button>
				<button type="button" className="th-btn th-btn--ghost" onClick={onCancel}>
					{t("approval.cancel")}
				</button>
			</div>
		</div>
	);
}
