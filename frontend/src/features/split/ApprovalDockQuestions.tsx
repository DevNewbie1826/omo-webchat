import { useState } from "react";
import { useT } from "../../i18n";
import type { Question, QuestionAnswer } from "../../lib/contract/types_gen";

export interface ApprovalQuestionPanelProps {
	/** Owned by the dock so collapsing the body preserves the draft. */
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
	readonly answers: ReadonlyMap<
		string, { readonly selected: readonly string[]; readonly text: string }
	>;
	readonly comment: string;
}

function questionKey(question: Question, index: number): string {
	return question.id ?? `q${index}`;
}

/** Tabbed panel for a structured multi-question request: one tab per
 *  question, option descriptions visible, each question's own multiSelect
 *  flag respected (single replaces, multi toggles), a free-text input for
 *  questions without options, and one optional overall comment. One Submit
 *  sends a single response with answers keyed by question id. Every
 *  question's draft lives in one record, so switching tabs never loses
 *  selections already made. */
export function useApprovalQuestionDraft(requestId: string) {
	const [draft, setDraft] = useState<QuestionDraft>({
		requestId,
		activeIndex: 0,
		answers: new Map(),
		comment: "",
	});
	if (draft.requestId !== requestId) {
		setDraft({ requestId, activeIndex: 0, answers: new Map(), comment: "" });
	}

	return [draft, setDraft] as const;
}

export function ApprovalQuestionPanel({
	draftState: [draft, setDraft],
	questions,
	onSubmit,
	onCancel,
}: ApprovalQuestionPanelProps) {
	const { t } = useT();
	const activeIndex = Math.min(draft.activeIndex, Math.max(questions.length - 1, 0));

	const patchDraft = (
		index: number,
		patch: { selected?: readonly string[]; text?: string },
	): void => {
		const question = questions[index];
		if (!question) return;
		const key = questionKey(question, index);
		const previous = draft.answers.get(key) ?? { selected: [], text: "" };
		setDraft({
			...draft,
			answers: new Map(draft.answers).set(key, {
				selected: patch.selected ?? previous.selected,
				text: patch.text ?? previous.text,
			}),
		});
	};

	const toggleOption = (index: number, label: string): void => {
		const question = questions[index];
		if (!question) return;
		const key = questionKey(question, index);
		const previous = draft.answers.get(key) ?? { selected: [], text: "" };
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

	const submit = (): void => {
		const answers = new Map<string, QuestionAnswer>();
		questions.forEach((question, index) => {
			const entry = draft.answers.get(questionKey(question, index));
			if (!entry) return;
			const answer: { selected?: readonly string[]; text?: string } = {};
			if (entry.selected.length > 0) answer.selected = entry.selected;
			if (entry.text.trim() !== "") answer.text = entry.text;
			if (answer.selected !== undefined || answer.text !== undefined) {
				answers.set(questionKey(question, index), answer);
			}
		});
		const comment = draft.comment.trim();
		onSubmit({ answers: Object.fromEntries(answers), ...(comment !== "" ? { comment: draft.comment } : {}) });
	};

	return (
		<div className="th-approval-question">
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
