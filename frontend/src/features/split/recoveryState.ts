/**
 * Recovery-phase state machine for the RPC drop/reconnect cycle, derived from
 * the observed server recovery seam: a lost socket, the re-established
 * transport, the rebinding replay's ready frame, and the server's resume
 * failure error mapping. Four phases are distinguished so the UI never
 * collapses them into one generic connected flag, and an incomplete recovery
 * is sticky — a later ready never re-reports it as a success.
 */

export type RecoveryPhase = "reconnecting" | "resuming" | "recovered" | "incomplete";

export interface RecoveryState {
	readonly phase: RecoveryPhase;
	/** incomplete only: the server's mapped resume-failure message. */
	readonly reason?: string;
}

/**
 * Error-frame codes the server produces when reopening the same durable
 * session fails. Observed during a recovery window they mean the resume did
 * not complete; outside one (initial attach) they are ordinary failures.
 */
const RECOVERY_INCOMPLETE_CODES: ReadonlySet<string> = new Set([
	"resume_failed",
	"initialize_failed",
	"session-active",
	"adoption_required",
]);

/** Socket closed. Only a drop of a previously open socket starts a cycle. */
export function recoveryAfterClose(
	current: RecoveryState | null,
	wasOpen: boolean,
): RecoveryState | null {
	return wasOpen ? { phase: "reconnecting" } : current;
}

/**
 * Server-observed transport loss (provider_disconnected). The browser socket
 * stays open while the server re-establishes the provider connection and
 * reconciles this chat, so no close/open pair ever marks the cycle. The frame
 * is only published for a live session whose transport epoch died, and a
 * repeat frame means a new loss: both restart the cycle at reconnecting.
 */
export function recoveryAfterProviderLoss(
	current: RecoveryState | null,
): RecoveryState | null {
	return { phase: "reconnecting" };
}

/** Transport re-established; the rebinding replay is now pending. */
export function recoveryAfterOpen(
	current: RecoveryState | null,
): RecoveryState | null {
	return current?.phase === "reconnecting" ? { phase: "resuming" } : current;
}

/**
 * The rebinding replay's ready frame completed the recovery. An incomplete
 * recovery is never flipped to recovered: the warning outlives late frames.
 * A server-driven cycle has no socket-open beat, so its replay ready arrives
 * while still reconnecting; both pre-replay phases complete here.
 */
export function recoveryAfterReady(
	current: RecoveryState | null,
): RecoveryState | null {
	return current?.phase === "resuming" || current?.phase === "reconnecting"
		? { phase: "recovered" }
		: current;
}

/**
 * A mapped resume failure during the recovery window marks it incomplete.
 * In a server-driven cycle the resume-failure frame is itself the first
 * post-loss signal, so it lands while still reconnecting; only a cycle that
 * never started (initial attach) keeps the failure an ordinary error.
 */
export function recoveryAfterError(
	current: RecoveryState | null,
	code: string | undefined,
	message: string,
): RecoveryState | null {
	if (current === null) return current;
	if (code === undefined || !RECOVERY_INCOMPLETE_CODES.has(code)) return current;
	return { phase: "incomplete", reason: message };
}
