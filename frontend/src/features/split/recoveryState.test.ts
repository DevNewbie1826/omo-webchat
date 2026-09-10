import { describe, expect, it } from "vitest";
import { recoveryAfterClose, recoveryAfterError, recoveryAfterHistory, recoveryAfterOpen, recoveryAfterProviderLoss, recoveryAfterReady } from "./recoveryState";

describe("recovery replay boundary", () => {
 it("uses readiness to start resuming and terminal history to end the recovery window silently", () => {
  const lost = recoveryAfterProviderLoss(null);
  expect(lost.phase).toBe("reconnecting");
  const ready = recoveryAfterReady(lost, true);
  expect(ready?.phase).toBe("resuming");
  const partial = recoveryAfterHistory(ready, false);
  expect(partial?.phase).toBe("resuming");
  const complete = recoveryAfterHistory(partial, true);
  // A successful replay is silent: the recovery window closes with no phase.
  expect(complete).toBeNull();
  expect(recoveryAfterError(complete, "provider_error", "later ordinary history query", "get_entries")).toBe(complete);
  expect(recoveryAfterError(ready, "provider_error", "ordinary send", "chat.send")).toBe(ready);
 });
 it.each(["resume_failed", "initialize_failed", "session-active", "adoption_required", "reconnect_exhausted", "start_failed", "no_chat", "external-write-detected", "incomplete_history", "decode_failed", "provider_timeout", "provider_error"])("captures %s during replay but leaves initial attach alone", code => {
  expect(recoveryAfterError(null, code, code)).toBeNull();
  const state = recoveryAfterReady(recoveryAfterProviderLoss(null), true);
  const failure = recoveryAfterError(state, code, code, "get_entries");
  expect(failure).toEqual({ phase: "incomplete", reason: code });
  expect(recoveryAfterHistory(recoveryAfterReady(recoveryAfterOpen(recoveryAfterClose(failure, true)), true), true)).toBe(failure);
  expect(recoveryAfterProviderLoss(failure)).toBe(failure);
 });
 it("accepts authoritative fresh-route readiness without waiting for nonexistent history", () => {
  // Fresh routes have no history stream; authoritative readiness closes the window silently.
  expect(recoveryAfterReady(recoveryAfterProviderLoss(null), false)).toBeNull();
  expect(recoveryAfterReady(null, false)).toBeNull();
 });
});
