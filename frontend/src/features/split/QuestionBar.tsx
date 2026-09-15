import { useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ApprovalFrame, QuestionAnswer } from "../../lib/contract/types_gen";

export interface QuestionBarProps {
	/** A non-blocking question request (method "question"): it never takes
	 *  over the composer and is answered only through this widget. */
	readonly request: ApprovalFrame;
	readonly onAnswer: (questionId: string, answer: QuestionAnswer) => void;
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
	const question = request.questions?.[0];
	const questionId = question?.id ?? "q1";
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

	const answer = (value: QuestionAnswer): void => {
		onAnswer(questionId, value);
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
					{multiSelect && (
						<button
							type="button"
							className="th-btn"
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
