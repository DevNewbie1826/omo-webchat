/**
 * Pending-transaction ledger for typed control commands (set_model,
 * set_thinking_level, extension_ui_response).
 *
 * A control arms before its optimistic update, commits when the server ack
 * arrives, and rejects on a correlated error. Transactions are keyed by the
 * client requestId that the server echoes on the ack/error, so a late error
 * for request A can never roll back request B even when both share a command.
 * Only one transaction per command may be armed, which blocks double-submit. A
 * committed transaction keeps its rollback as a restore point so a late
 * provider error (arriving after the ack) can still revert to the last
 * ack/state-confirmed value.
 */
interface Transaction {
  readonly command: string;
  readonly rollback: () => void;
  readonly commit: () => void;
}

export interface ControlLedger {
  /** Register a transaction. Returns false when the command is already armed. */
  arm(requestId: string, command: string, rollback: () => void, commit: () => void): boolean;
  /** Apply the ack for a requestId: run commit and keep the rollback as a restore point. */
  commit(requestId: string): boolean;
  /** Roll back the armed transaction or committed restore point for a requestId. */
  reject(requestId: string): boolean;
  has(command: string): boolean;
  /** Discard a stale restore point once an authoritative state frame lands. */
  dropRestore(command: string): void;
  /** Discard the restore point committed under a requestId (provider confirmed). */
  dropRestoreRequest(requestId: string): void;
  /** Disconnect: roll back every armed transaction and forget restore points. */
  failAll(): void;
}

export function controlLedger(): ControlLedger {
  const pending = new Map<string, Transaction>();
  const armedByCommand = new Map<string, string>();
  const restorePoints = new Map<string, () => void>();
  const restoreByCommand = new Map<string, string>();

  const forgetRestoreCommand = (requestId: string): void => {
    for (const [command, id] of restoreByCommand) {
      if (id === requestId) {
        restoreByCommand.delete(command);
        break;
      }
    }
  };

  const commandOfRestore = (requestId: string): string | undefined => {
    for (const [command, id] of restoreByCommand) {
      if (id === requestId) return command;
    }
    return undefined;
  };

  return {
    arm(requestId, command, rollback, commit) {
      if (armedByCommand.has(command)) return false;
      pending.set(requestId, { command, rollback, commit });
      armedByCommand.set(command, requestId);
      return true;
    },
    commit(requestId) {
      const transaction = pending.get(requestId);
      if (!transaction) return false;
      pending.delete(requestId);
      armedByCommand.delete(transaction.command);
      transaction.commit();
      // A newer commit for the same command supersedes the prior restore point,
      // so a late error for the older request can never revert the newer value.
      const prior = restoreByCommand.get(transaction.command);
      if (prior && prior !== requestId) restorePoints.delete(prior);
      restorePoints.set(requestId, transaction.rollback);
      restoreByCommand.set(transaction.command, requestId);
      return true;
    },
    reject(requestId) {
      const transaction = pending.get(requestId);
      if (transaction) {
        pending.delete(requestId);
        armedByCommand.delete(transaction.command);
        // A newer armed transaction rolls back to the confirmed baseline, which
        // supersedes any prior committed restore point for the same command.
        const prior = restoreByCommand.get(transaction.command);
        if (prior) {
          restorePoints.delete(prior);
          restoreByCommand.delete(transaction.command);
        }
        transaction.rollback();
        return true;
      }
      const restore = restorePoints.get(requestId);
      if (restore) {
        const command = commandOfRestore(requestId);
        restorePoints.delete(requestId);
        forgetRestoreCommand(requestId);
        // A newer armed transaction for the same command supersedes this stale
        // restore point: fold the rollback into its fallback baseline instead of
        // reverting now, so the optimistic newer value is not clobbered. If the
        // newer transaction later commits, its value stands; if it later
        // rejects, it rolls back through this failed one to the older baseline.
        const newerId = command === undefined ? undefined : armedByCommand.get(command);
        const newer = newerId === undefined ? undefined : pending.get(newerId);
        if (newer && newerId !== undefined) {
          pending.set(newerId, { command: newer.command, rollback: restore, commit: newer.commit });
          return true;
        }
        restore();
        return true;
      }
      return false;
    },
    has: (command) => armedByCommand.has(command),
    dropRestore(command) {
      const id = restoreByCommand.get(command);
      if (id) {
        restorePoints.delete(id);
        restoreByCommand.delete(command);
      }
    },
    dropRestoreRequest(requestId) {
      restorePoints.delete(requestId);
      forgetRestoreCommand(requestId);
    },
    failAll() {
      const transactions = [...pending.values()];
      pending.clear();
      armedByCommand.clear();
      restorePoints.clear();
      restoreByCommand.clear();
      for (const transaction of transactions) transaction.rollback();
    },
  };
}
