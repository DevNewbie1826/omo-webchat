import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n";

export interface ApprovalRequest {
	readonly id: string;
	readonly method: "select" | "confirm" | "input" | "editor";
	readonly title?: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly prefill?: string;
	readonly placeholder?: string;
	readonly deadlineAtMs?: number;
	readonly remainingMs?: number;
}

export interface ApprovalDockProps {
	readonly request: ApprovalRequest;
	readonly onRespond: (response: {
		value?: string;
		confirmed?: boolean;
		cancelled?: boolean;
	}) => void;
}

const COUNTDOWN_TICK_MS = 1_000;

export function ApprovalDock({ request, onRespond }: ApprovalDockProps) {
	const { t } = useT();
	const titleId = useId();
	const sectionRef = useRef<HTMLElement>(null);
	const [text, setText] = useState(request.prefill ?? "");
	const [collapsed, setCollapsed] = useState(false);

	// Countdown target: an absolute deadline, or remainingMs anchored to the
	// moment this request arrived. Re-anchored when a new request id shows up.
	const anchorRef = useRef<{ id: string; atMs: number } | null>(null);
	if (anchorRef.current?.id !== request.id) {
		anchorRef.current = { id: request.id, atMs: Date.now() };
	}
	const targetMs =
		request.deadlineAtMs ??
		(request.remainingMs !== undefined
			? anchorRef.current.atMs + request.remainingMs
			: undefined);

	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		if (targetMs === undefined) return;
		const timer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
		return () => clearInterval(timer);
	}, [targetMs]);
	const countdownSeconds =
		targetMs === undefined ? undefined : Math.max(0, Math.ceil((targetMs - nowMs) / 1000));

	// Move focus to the primary control so a keyboard user can answer at once,
	// both on arrival and when a collapsed panel expands again.
	// No trap: Tab leaves the panel freely.
	useEffect(() => {
		if (collapsed) return;
		sectionRef.current?.querySelector<HTMLElement>("[data-approval-primary]")?.focus();
	}, [request.id, collapsed]);

	// A new request id starts a fresh draft; the previous request's typed text
	// must not leak into the new input/editor field.
	useEffect(() => {
		setText(request.prefill ?? "");
	}, [request.id, request.prefill]);

	// Collapsing hands focus back to the pane's composer textarea when present.
	useEffect(() => {
		if (!collapsed) return;
		sectionRef.current
			?.closest(".th-chat-pane")
			?.querySelector<HTMLElement>("textarea")
			?.focus();
	}, [collapsed]);

	const submitValue = (value: string): void => onRespond({ value });
	const submitConfirm = (confirmed: boolean): void => onRespond({ confirmed });
	const cancel = (): void => onRespond({ cancelled: true });

	const countdown = countdownSeconds !== undefined && (
		<span className="th-approval-dock-countdown">
			{t("approval.remaining", { seconds: countdownSeconds })}
		</span>
	);

	return (
		<section
			ref={sectionRef}
			role="region"
			className="th-approval-dock"
			aria-labelledby={titleId}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || collapsed) return;
				event.preventDefault();
				setCollapsed(true);
			}}
		>
			{collapsed ? (
				<div className="th-approval-dock-summary">
					<span id={titleId} className="th-approval-dock-summary-title">
						{request.title ?? t("approval.title")}
					</span>
					<span className="th-approval-dock-summary-pending">
						{t("approval.pending")}
					</span>
					{countdown}
					<button
						type="button"
						className="th-approval-dock-toggle"
						aria-label={t("approval.expand")}
						onClick={() => setCollapsed(false)}
					>
						{t("approval.expand")}
					</button>
				</div>
			) : (
				<>
					<div className="th-approval-dock-header">
						<h3 id={titleId} className="th-approval-dock-title">
							{request.title ?? t("approval.title")}
						</h3>
						{countdown}
						<button
							type="button"
							className="th-approval-dock-toggle"
							aria-label={t("approval.collapse")}
							onClick={() => setCollapsed(true)}
						>
							{t("approval.collapse")}
						</button>
					</div>
					<div className="th-approval-dock-body">
						{request.message && (
							<p className="th-approval-message">{request.message}</p>
						)}

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
					</div>
				</>
			)}
		</section>
	);
}
