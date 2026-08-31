import { describe, expect, it, vi } from "vitest";
import { controlLedger } from "./chatControlTransactions";

describe("controlLedger", () => {
  it("blocks a second arm for the same command until resolution", () => {
    const ledger = controlLedger();
    expect(ledger.arm("r1", "set_model", () => undefined, () => undefined)).toBe(true);
    expect(ledger.arm("r2", "set_model", () => undefined, () => undefined)).toBe(false);
    expect(ledger.has("set_model")).toBe(true);
  });

  it("arms independent commands independently", () => {
    const ledger = controlLedger();
    expect(ledger.arm("r1", "set_model", () => undefined, () => undefined)).toBe(true);
    expect(ledger.arm("r2", "set_thinking_level", () => undefined, () => undefined)).toBe(true);
  });

  it("commit runs the commit handler and keeps a restore point for late errors", () => {
    const ledger = controlLedger();
    const rollback = vi.fn();
    const commit = vi.fn();
    ledger.arm("r1", "set_model", rollback, commit);

    expect(ledger.commit("r1")).toBe(true);
    expect(commit).toHaveBeenCalledExactlyOnceWith();
    expect(rollback).not.toHaveBeenCalled();
    expect(ledger.has("set_model")).toBe(false);

    // A provider error arriving after the ack still rolls back exactly once.
    expect(ledger.reject("r1")).toBe(true);
    expect(rollback).toHaveBeenCalledExactlyOnceWith();
    expect(ledger.reject("r1")).toBe(false);
  });

  it("supersedes request A's restore point once request B commits the same command", () => {
    const ledger = controlLedger();
    // One shared mutable value stands in for the confirmed control the UI shows;
    // apply() is what every commit/rollback closure ultimately mutates.
    let confirmed = "base";
    let displayed = "base";
    const apply = (value: string): void => {
      confirmed = value;
      displayed = value;
    };

    // Request A arms against the "base" baseline, then its ack commits "A".
    const restoreA = confirmed;
    displayed = "A";
    ledger.arm("req-A", "set_model", () => apply(restoreA), () => apply("A"));
    expect(ledger.commit("req-A")).toBe(true);
    expect(displayed).toBe("A");
    expect(confirmed).toBe("A");

    // Request B arms against the now-confirmed "A", then its ack commits "B".
    const restoreB = confirmed;
    displayed = "B";
    ledger.arm("req-B", "set_model", () => apply(restoreB), () => apply("B"));
    expect(ledger.commit("req-B")).toBe(true);
    expect(displayed).toBe("B");
    expect(confirmed).toBe("B");

    // A late failure correlated with A is a no-op: it must not revert the shared
    // value past B's commit, and A's superseded rollback never runs.
    expect(ledger.reject("req-A")).toBe(false);
    expect(displayed).toBe("B");
    expect(confirmed).toBe("B");

    // B's own restore point is still live and reverts exactly once to its baseline.
    expect(ledger.reject("req-B")).toBe(true);
    expect(displayed).toBe("A");
    expect(confirmed).toBe("A");
    expect(ledger.reject("req-B")).toBe(false);
  });

  it("folds a stale restore point into a newer armed transaction that later commits", () => {
    const ledger = controlLedger();
    let confirmed = "base";
    let displayed = "base";
    const apply = (value: string): void => {
      confirmed = value;
      displayed = value;
    };

    // A arms against base and its ack commits A.
    const restoreA = confirmed;
    displayed = "A";
    ledger.arm("req-A", "set_model", () => apply(restoreA), () => apply("A"));
    ledger.commit("req-A");
    expect(confirmed).toBe("A");

    // B arms optimistic against confirmed A but has NOT committed yet.
    const restoreB = confirmed;
    displayed = "B";
    ledger.arm("req-B", "set_model", () => apply(restoreB), () => apply("B"));

    // A late error for A must not clobber the optimistic B; it folds into B.
    expect(ledger.reject("req-A")).toBe(true);
    expect(displayed).toBe("B");
    expect(confirmed).toBe("A");

    // B then commits: visible/confirmed B remains.
    expect(ledger.commit("req-B")).toBe(true);
    expect(displayed).toBe("B");
    expect(confirmed).toBe("B");
    // A's folded restore point is gone; a repeat late error for A is a no-op.
    expect(ledger.reject("req-A")).toBe(false);
  });

  it("rolls a newer armed transaction back through a failed stale restore point to base", () => {
    const ledger = controlLedger();
    let confirmed = "base";
    let displayed = "base";
    const apply = (value: string): void => {
      confirmed = value;
      displayed = value;
    };

    const restoreA = confirmed;
    displayed = "A";
    ledger.arm("req-A", "set_model", () => apply(restoreA), () => apply("A"));
    ledger.commit("req-A");
    expect(confirmed).toBe("A");

    const restoreB = confirmed;
    displayed = "B";
    ledger.arm("req-B", "set_model", () => apply(restoreB), () => apply("B"));

    // Late error for A folds into B without clobbering the optimistic B.
    expect(ledger.reject("req-A")).toBe(true);
    expect(displayed).toBe("B");

    // B then fails: it rolls back through failed A all the way to base.
    expect(ledger.reject("req-B")).toBe(true);
    expect(displayed).toBe("base");
    expect(confirmed).toBe("base");
    expect(ledger.reject("req-B")).toBe(false);
  });

  it("reject of a pending transaction rolls back and clears the prior restore point", () => {
    const ledger = controlLedger();
    const firstRollback = vi.fn();
    ledger.arm("r1", "set_model", firstRollback, () => undefined);
    ledger.commit("r1");

    const secondRollback = vi.fn();
    ledger.arm("r2", "set_model", secondRollback, () => undefined);
    expect(ledger.reject("r2")).toBe(true);
    expect(secondRollback).toHaveBeenCalledExactlyOnceWith();
    expect(firstRollback).not.toHaveBeenCalled();
    // The superseded restore point is gone: a late error for r1 is now a no-op.
    expect(ledger.reject("r1")).toBe(false);
    expect(ledger.reject("r2")).toBe(false);
  });

  it("dropRestore discards a stale restore point when state confirms", () => {
    const ledger = controlLedger();
    const rollback = vi.fn();
    ledger.arm("r1", "set_model", rollback, () => undefined);
    ledger.commit("r1");
    ledger.dropRestore("set_model");
    expect(ledger.reject("r1")).toBe(false);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("dropRestoreRequest discards only the correlated restore point", () => {
    const ledger = controlLedger();
    const rollbackA = vi.fn();
    const rollbackB = vi.fn();
    ledger.arm("req-A", "set_model", rollbackA, () => undefined);
    ledger.commit("req-A");
    ledger.arm("req-B", "set_thinking_level", rollbackB, () => undefined);
    ledger.commit("req-B");

    ledger.dropRestoreRequest("req-A");
    expect(ledger.reject("req-A")).toBe(false);
    expect(rollbackA).not.toHaveBeenCalled();
    expect(ledger.reject("req-B")).toBe(true);
    expect(rollbackB).toHaveBeenCalledExactlyOnceWith();
  });

  it("failAll rolls back every pending transaction and clears restore points", () => {
    const ledger = controlLedger();
    const modelRollback = vi.fn();
    const approvalRollback = vi.fn();
    ledger.arm("r1", "set_model", modelRollback, () => undefined);
    ledger.arm("r2", "extension_ui_response", approvalRollback, () => undefined);
    ledger.arm("r3", "set_thinking_level", () => undefined, () => undefined);
    ledger.commit("r3");

    ledger.failAll();

    expect(modelRollback).toHaveBeenCalledExactlyOnceWith();
    expect(approvalRollback).toHaveBeenCalledExactlyOnceWith();
    expect(ledger.has("set_model")).toBe(false);
    expect(ledger.has("extension_ui_response")).toBe(false);
    expect(ledger.reject("r3")).toBe(false);
  });
});
