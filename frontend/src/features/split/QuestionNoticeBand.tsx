import { useT } from "../../i18n";
import { useApprovalDeadlineCountdown } from "./QuestionWindow";
import type { ApprovalRequest } from "./QuestionWindow";
import { questionDeliveryErrorText } from "./ApprovalDockQuestions";

export interface QuestionNoticeBandProps {
	/** The pending request this band stands in for while the window is
	 *  closed (and reopenable from) — and while a non-blocking question
	 *  waits for the user to open its window. */
	readonly request: ApprovalRequest;
	readonly onOpen: () => void;
	/** Total pending questions; >1 shows the count and a next control. */
	readonly pendingCount?: number;
	readonly onNextQuestion?: () => void;
	/** Re-send the stored submitted answer after a failed delivery. */
	readonly onResend?: () => void;
}

/** One-line notice band in the chat column where the inline dock lived:
 *  "Approval required · 2 questions — 45s left — [Open]". A fixed
 *  single-line band with no layout machinery: it never grows, never
 *  scrolls, and never takes over the composer — the window (opened from
 *  here) is the answering surface. Always rendered while its request is
 *  pending: closing the window leaves the band, and a non-blocking question
 *  lives in the band alone until the user opens the window. */
export function QuestionNoticeBand({ request, onOpen, pendingCount, onNextQuestion, onResend }: QuestionNoticeBandProps) {
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
			{pendingCount !== undefined && pendingCount > 1 && (
				<span className="th-question-pending">
					<span className="th-question-pending-count">
						{t("question.pending.count", { count: pendingCount })}
					</span>
					{onNextQuestion && (
						<button
							type="button"
							className="th-btn th-btn--ghost th-question-pending-next"
							onClick={onNextQuestion}
						>
							{t("question.pending.next")}
						</button>
					)}
				</span>
			)}
			{request.delivery === "sending" && (
				<span className="th-question-delivery th-question-delivery--sending" role="status">
					{t("question.delivery.sending")}
				</span>
			)}
			{request.delivery === "failed" && (
				<span className="th-question-delivery th-question-delivery--failed" role="alert">
					<span className="th-question-delivery-error">
						{questionDeliveryErrorText(t, request.deliveryError)}
					</span>
					{onResend && (
						<button
							type="button"
							className="th-btn th-question-delivery-resend"
							onClick={onResend}
						>
							{t("question.delivery.resend")}
						</button>
					)}
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
