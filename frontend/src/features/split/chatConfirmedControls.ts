import { useRef, useState } from "react";
import type { ChatServerFrame } from "../../lib/chatWs";
import { type ControlLedger, controlLedger } from "./chatControlTransactions";

type StateFrame = Extract<ChatServerFrame, { readonly type: "state" }>;

/**
 * Authoritative control values for model and thinking level. Optimistic
 * updates apply immediately; the confirmed baseline moves only on a server
 * ack (through the ledger commit closure) or an authoritative state frame.
 * Rollbacks revert to that confirmed baseline. While a transaction is armed,
 * state frames update the baseline without clobbering the optimistic value.
 */
export function useConfirmedControls() {
  const ledgerRef = useRef<ControlLedger | null>(null);
  if (!ledgerRef.current) ledgerRef.current = controlLedger();
  const ledger = ledgerRef.current;
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [currentModelKey, setCurrentModelKey] = useState("");
  const confirmedModelKeyRef = useRef("");
  const confirmedThinkingRef = useRef("");

  const applyConfirmedModelKey = (key: string): void => {
    confirmedModelKeyRef.current = key;
    setCurrentModelKey(key);
  };
  const applyConfirmedThinkingLevel = (level: string): void => {
    confirmedThinkingRef.current = level;
    setThinkingLevel(level);
  };

  const absorbState = (frame: StateFrame): void => {
    if (frame.thinkingLevel) {
      confirmedThinkingRef.current = frame.thinkingLevel;
      ledger.dropRestore("set_thinking_level");
      if (!ledger.has("set_thinking_level")) setThinkingLevel(frame.thinkingLevel);
    }
    if (frame.model) {
      const modelKey = `${frame.model.provider}/${frame.model.modelId}`;
      confirmedModelKeyRef.current = modelKey;
      ledger.dropRestore("set_model");
      if (!ledger.has("set_model")) setCurrentModelKey(modelKey);
    }
  };

  return {
    ledger,
    thinkingLevel,
    currentModelKey,
    setThinkingLevel,
    setCurrentModelKey,
    absorbState,
    confirmedModelKey: () => confirmedModelKeyRef.current,
    confirmedThinkingLevel: () => confirmedThinkingRef.current,
    applyConfirmedModelKey,
    applyConfirmedThinkingLevel,
  };
}
