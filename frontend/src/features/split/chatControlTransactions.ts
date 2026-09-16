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
type ControlCommand = string | {
  readonly key: string;
  /** A superseded owner can never use its restore point again. */
  readonly ownsRestore: () => boolean;
};

interface Transaction {
  readonly command: string;
  readonly ownsRestore?: () => boolean;
  readonly rollback: () => void;
  readonly commit: () => void;
}

export interface ControlLedger {
  /** Register a transaction. Returns false when the command is already armed. */
  arm(requestId: string, command: ControlCommand, rollback: () => void, commit: () => void): boolean;
  /** Apply the ack for a requestId: run commit and keep the rollback as a restore point. */
  commit(requestId: string): boolean;
  /** Roll back the armed transaction or committed restore point for a requestId. */
  reject(requestId: string): boolean;
  has(command: string): boolean;
  /** Discard a stale restore point once an authoritative state frame lands. */
  dropRestore(command: string): void;
  /** Discard the restore point; a matching model confirmation returns its command once. */
  dropRestoreRequest(requestId: string, confirmedCommand?: string): "set_model" | undefined;
  /** Disconnect: roll back every armed transaction and forget restore points. */
  failAll(): void;
}

export function controlLedger(): ControlLedger {
  const pending = new Map<string, Transaction>();
  const armedByCommand = new Map<string, string>();
  const restorePoints = new Map<string, Transaction>();
  const restoreByCommand = new Map<string, string>();
  // Model state may retire rollback before the correlated result arrives.
  const awaitingConfirmation = new Map<string, "set_model">();

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
      const key = typeof command === "string" ? command : command.key;
      if (armedByCommand.has(key)) return false;
      pending.set(requestId, { command: key, rollback, commit,
        ...(typeof command === "string" ? {} : { ownsRestore: command.ownsRestore }) });
      if (key === "set_model") awaitingConfirmation.set(requestId, key);
      armedByCommand.set(key, requestId);
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
      if (transaction.command === "set_model") {
        for (const id of awaitingConfirmation.keys()) if (id !== requestId) awaitingConfirmation.delete(id);
      }
      // Generation-specific commands may coexist while pending, but only their
      // current owners need late-error recovery after settlement.
      for (const [id, restore] of restorePoints) {
        if (restore.ownsRestore?.() === false) {
          restorePoints.delete(id);
          restoreByCommand.delete(restore.command);
        }
      }
      if (transaction.ownsRestore?.() !== false) {
        restorePoints.set(requestId, transaction);
        restoreByCommand.set(transaction.command, requestId);
      }
      return true;
    },
    reject(requestId) {
      awaitingConfirmation.delete(requestId);
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
          pending.set(newerId, { ...newer, rollback: restore.rollback });
          return true;
        }
        restore.rollback();
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
    dropRestoreRequest(requestId, confirmedCommand) {
      const command = awaitingConfirmation.get(requestId);
      if (command !== undefined && confirmedCommand !== undefined && command !== confirmedCommand) return undefined;
      awaitingConfirmation.delete(requestId);
      restorePoints.delete(requestId);
      forgetRestoreCommand(requestId);
      return command === confirmedCommand ? command : undefined;
    },
    failAll() {
      const transactions = [...pending.values()];
      pending.clear();
      awaitingConfirmation.clear();
      armedByCommand.clear();
      restorePoints.clear();
      restoreByCommand.clear();
      for (const transaction of transactions) transaction.rollback();
    },
  };
}
