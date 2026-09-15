import { isRecord, optNumber, optString, reqString } from "./chatWsParseFields";

/**
 * Safety net for request frames the panel cannot fully render. An
 * approval-shaped request that carries an id and a prompt-like payload but a
 * method or shape this client does not recognise (per the observed engine
 * contract) is surfaced as a minimal fallback frame instead of dropped
 * silently: the dock names the request, offers a plain confirmation, free
 * text, and the explicit cancel control, and notes that the request type is
 * not fully supported by this client.
 */
export interface FallbackApprovalFrame {
  readonly type: "approval";
  readonly sessionId: string | null;
  readonly id: string;
  /** Raw wire method name, preserved verbatim for diagnostics. */
  readonly method: string;
  readonly fallback: true;
  readonly title?: string;
  readonly message?: string;
  readonly prefill?: string;
  readonly placeholder?: string;
  readonly deadlineAtMs?: number;
  readonly remainingMs?: number;
}

/** One console line per distinct diagnostic: a replayed frame never floods. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Lenient fallback parse for an approval frame the strict parse rejected.
 * Returns null only when the frame cannot be surfaced at all (not an
 * approval, or no id to answer or dismiss) — those stay ignored, but the
 * no-id case is logged once so the drop is never invisible.
 */
export function parseFallbackApprovalFrame(msg: unknown): FallbackApprovalFrame | null {
  if (!isRecord(msg) || msg["type"] !== "approval") return null;
  const id = reqString(msg, "id");
  if (id === null) {
    const droppedMethod = typeof msg["method"] === "string" ? msg["method"] : "";
    warnOnce(
      "approval-no-id",
      `[chatWsParse] dropped a malformed approval frame without an id (method "${droppedMethod}")`,
    );
    return null;
  }
  const rawMethod = msg["method"];
  const method = typeof rawMethod === "string" ? rawMethod : "";
  if (method === "") {
    warnOnce(
      "approval-no-method",
      '[chatWsParse] approval frame without a method rendered as a minimal fallback (id "' + id + '")',
    );
  } else {
    warnOnce(
      `approval-method:${method}`,
      `[chatWsParse] unsupported approval method "${method}" rendered as a minimal fallback`,
    );
  }
  const sessionId = optString(msg, "sessionId");
  const title = optString(msg, "title");
  const message = optString(msg, "message");
  const prefill = optString(msg, "prefill");
  const placeholder = optString(msg, "placeholder");
  const deadlineAtMs = optNumber(msg, "deadlineAtMs");
  const remainingMs = optNumber(msg, "remainingMs");
  return {
    type: "approval",
    sessionId: sessionId ?? null,
    id,
    method,
    fallback: true,
    // Lenient by design: a malformed optional field is dropped, not fatal —
    // the request must still surface.
    ...(title != null ? { title } : {}),
    ...(message != null ? { message } : {}),
    ...(prefill != null ? { prefill } : {}),
    ...(placeholder != null ? { placeholder } : {}),
    ...(deadlineAtMs != null ? { deadlineAtMs } : {}),
    ...(remainingMs != null ? { remainingMs } : {}),
  };
}

/** Narrow a parsed server frame to the fallback approval safety-net shape. */
export function isFallbackApprovalFrame(frame: unknown): frame is FallbackApprovalFrame {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { readonly fallback?: unknown }).fallback === true
  );
}
