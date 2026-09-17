import { useT } from "../../i18n";
import { useApprovalDeadlineCountdown } from "./QuestionWindow";
import type { ApprovalRequest } from "./QuestionWindow";

export interface QuestionNoticeBandProps {
	/** The pending request this band stands in for while the window is
	 *  closed (and reopenable from) — and while a non-blocking question
	 *  waits for the user to open its window. */
	readonly request: ApprovalRequest;
	readonly onOpen: () => void;
}

/** One-line notice band in the chat column where the inline dock lived:
 *  "Approval required · 2 questions — 45s left — [Open]". A fixed
 *  single-line band with no layout machinery: it never grows, never
 *  scrolls, and never takes over the composer — the window (opened from
 *  here) is the answering surface. Always rendered while its request is
 *  pending: closing the window leaves the band, and a non-blocking question
 *  lives in the band alone until the user opens the window. */
export function QuestionNoticeBand({ request, onOpen }: QuestionNoticeBandProps) {
	const { t } = useT();
	const countdownSeconds = useApprovalDeadlineCountdown(request);
	const questionCount = request.method === "question" ? (request.questions?.length ?? 0) : 0;
	return (
		<div className="th-question-band">
			<span className="th-question-band-title">
				{request.title ?? t("approval.title")}
			</span>
			{questionCount > 0 && (
				<span className="th-question-band-count">
					{t("approval.band.questions", { count: questionCount })}
				</span>
			)}
			{countdownSeconds !== undefined && (
				<span className="th-question-window-countdown">
					{t("approval.remaining", { seconds: countdownSeconds })}
				</span>
			)}
			<button
				type="button"
				className="th-btn th-btn--ghost th-question-band-open"
				onClick={onOpen}
			>
				{t("approval.band.open")}
			</button>
		</div>
	);
}
