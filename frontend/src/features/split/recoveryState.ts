/** Recovery is complete only after authoritative history, not route readiness. */
export type RecoveryPhase = "reconnecting" | "resuming" | "recovered" | "incomplete";

export interface RecoveryState {
	readonly phase: RecoveryPhase;
	readonly reason?: string;
}

const RECOVERY_INCOMPLETE_CODES: ReadonlySet<string> = new Set([
	"reconnect_exhausted",
	"resume_failed",
	"initialize_failed",
	"session-active",
	"adoption_required",
	"start_failed",
	"no_chat",
	"external-write-detected",
	"incomplete_history",
	"decode_failed",
	"provider_timeout",
	"provider_error",
]);

/** An incomplete warning survives every later transport/replay cycle. */
export function recoveryAfterClose(
	current: RecoveryState | null,
	wasOpen: boolean,
): RecoveryState | null {
	return wasOpen ? recoveryAfterProviderLoss(current) : current;
}

export function recoveryAfterProviderLoss(
	current: RecoveryState | null,
): RecoveryState {
	return current?.phase === "incomplete" ? current : { phase: "reconnecting" };
}

export function recoveryAfterOpen(
	current: RecoveryState | null,
): RecoveryState | null {
	return current?.phase === "reconnecting" ? { phase: "resuming" } : current;
}

/** ready is the server-driven resuming beat; durable replay is still pending. */
export function recoveryAfterReady(
	current: RecoveryState | null,
	resumed: boolean,
): RecoveryState | null {
	if (current?.phase !== "reconnecting" && current?.phase !== "resuming") return current;
	// Fresh routes have no history stream. Initial attach still stays null.
	return { phase: resumed ? "resuming" : "recovered" };
}

export function recoveryAfterHistory(
	current: RecoveryState | null,
	final: boolean,
): RecoveryState | null {
	if (current?.phase !== "reconnecting" && current?.phase !== "resuming") return current;
	return { phase: final ? "recovered" : "resuming" };
}

export function recoveryAfterError(
	current: RecoveryState | null,
	code: string | undefined,
	message: string,
	command?: string,
): RecoveryState | null {
	// A completed replay closes the window: subsequent ordinary operation
	// errors must not retroactively turn clean recovery into failure.
	if (current?.phase !== "reconnecting" && current?.phase !== "resuming") return current;
	if (code === undefined || !RECOVERY_INCOMPLETE_CODES.has(code)) return current;
	if (code === "provider_error" && command !== undefined && command !== "get_entries") return current;
	return { phase: "incomplete", reason: message };
}
