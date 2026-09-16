import { useT } from "../../i18n";

/**
 * Minimal fallback rendering for a request type this client cannot fully
 * render (unknown method or shape, per the observed engine contract). Kept
 * wholly in this component so the dock only carries small, clearly-scoped
 * insertions. The entry always names the request (the dock's title), shows
 * the request's text (the dock's shared message block), offers a plain
 * confirmation and free text, and always keeps the explicit cancel control.
 */

/** The "not fully supported by this client" note, rendered above the body. */
export function ApprovalFallbackNote() {
	const { t } = useT();
	return <p className="th-approval-fallback-note">{t("approval.unsupportedNote")}</p>;
}

export interface ApprovalFallbackFormProps {
	readonly placeholder?: string | undefined;
	readonly value: string;
	readonly onValueChange: (value: string) => void;
	readonly onSubmitValue: (value: string) => void;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}

/** The answerable body: free text, a plain confirmation, and the always
 *  present explicit cancel control. The payload's semantics are unknown,
 *  so nothing stronger than these plain responses is offered. */
export function ApprovalFallbackForm({
	placeholder,
	value,
	onValueChange,
	onSubmitValue,
	onConfirm,
	onCancel,
}: ApprovalFallbackFormProps) {
	const { t } = useT();
	return (
		<form
			className="th-approval-form"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmitValue(value);
			}}
		>
			<input
				type="text"
				className="th-approval-input"
				data-approval-primary
				placeholder={placeholder ?? t("approval.unsupportedPlaceholder")}
				value={value}
				onChange={(event) => onValueChange(event.target.value)}
			/>
			<button type="submit" className="th-btn">
				{t("approval.submit")}
			</button>
			<button type="button" className="th-btn" onClick={onConfirm}>
				{t("approval.confirm")}
			</button>
			<button type="button" className="th-btn th-btn--ghost" onClick={onCancel}>
				{t("approval.cancel")}
			</button>
		</form>
	);
}

export interface ApprovalFallbackSummaryActionsProps {
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}

/** The compact summary row for the ultra-tight density where expansion
 *  cannot fit: plain confirmation plus the always-present cancel, so the
 *  fallback stays answerable without expanding. */
export function ApprovalFallbackSummaryActions({ onConfirm, onCancel }: ApprovalFallbackSummaryActionsProps) {
	const { t } = useT();
	return (
		<div className="th-approval-dock-summary-actions">
			<button type="button" className="th-btn" data-approval-primary onClick={onConfirm}>
				{t("approval.confirm")}
			</button>
			<button type="button" className="th-btn th-btn--ghost" onClick={onCancel}>
				{t("approval.cancel")}
			</button>
		</div>
	);
}
