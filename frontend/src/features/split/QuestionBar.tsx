import { useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { questionKey } from "../../lib/chatWsParseApproval";
import type { ApprovalFrame, QuestionAnswer } from "../../lib/contract/types_gen";

export interface QuestionBarProps {
	/** A non-blocking question request (method "question"): it never takes
	 *  over the composer and is answered only through this widget. */
	readonly request: ApprovalFrame;
	readonly onAnswer: (answers: Record<string, QuestionAnswer>) => void;
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
	const [requestId, setRequestId] = useState(request.id);
	const [activeIndex, setActiveIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
	const question = request.questions?.[activeIndex];
	const questionId = questionKey(question, activeIndex);
	const options = (question?.options ?? []).filter(
		(option): option is typeof option & { readonly label: string } =>
			option.label !== undefined,
	);
	const multiSelect = question?.multiSelect === true;
	// The expanded answer row is keyed by request id: a new request must never
	// inherit an open input or a stale multi-select draft.
	const [answeringForId, setAnsweringForId] = useState<string | null>(null);
	const answering = answeringForId === request.id;
	const [text, setText] = useState("");
	const [picked, setPicked] = useState<readonly string[]>([]);

	if (requestId !== request.id) {
		setRequestId(request.id);
		setActiveIndex(0);
		setAnswers({});
		setAnsweringForId(null);
		setText("");
		setPicked([]);
	}

	const answer = (value: QuestionAnswer): void => {
		const completed = { ...answers, [questionId]: value };
		// Sequence inside the one-line band; settle only after every question
		// has an answer so an unseen remainder can never be discarded.
		if (activeIndex + 1 < (request.questions?.length ?? 0)) {
			setAnswers(completed);
			setActiveIndex(activeIndex + 1);
			setAnsweringForId(null);
			setText("");
			setPicked([]);
		} else {
			onAnswer(completed);
		}
		focusPaneComposer(sectionRef.current);
	};

	const togglePick = (label: string): void => {
		setPicked((current) =>
			current.includes(label)
				? current.filter((item) => item !== label)
				: [...current, label],
		);
	};

	return (
		<section
			ref={sectionRef}
			className="th-question-bar"
			aria-labelledby={titleId}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || !answering) return;
				event.preventDefault();
				setAnsweringForId(null);
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
						setAnsweringForId(request.id);
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
						onChange={(event) => setText(event.target.value)}
					/>
					<button type="submit" className="th-btn">
						{t("question.submit")}
					</button>
				</form>
			)}
		</section>
	);
}
