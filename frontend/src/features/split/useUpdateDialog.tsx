import { useId, useRef, useState } from "react";
import { ModalDialog } from "../../components/ModalDialog";
import { useT } from "../../i18n";
import { apiVoid } from "../../lib/api";
import type { CommandEntry } from "../../lib/chatWs";
import { restartEngine } from "../system/system";
import type { ChatDraft } from "./chatSessionTypes";
import { UPDATE_COMMAND } from "./curatedCommands";

type UpdatePhase =
  | "confirm"
  | "running"
  | "success"
  | "error"
  | "applying"
  | "applied"
  | "apply-failed";

const MESSAGE_KEYS = {
  confirm: "chat.updateConfirm",
  running: "chat.updateRunning",
  success: "chat.updateSuccess",
  error: "chat.updateFailed",
  applying: "chat.updateApplying",
  applied: "chat.updateApplied",
  "apply-failed": "chat.updateApplyFailed",
} as const;

export function useUpdateDialog(
  commands: readonly CommandEntry[],
  submitPrompt: (draft: ChatDraft) => boolean,
) {
  const { t } = useT();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("confirm");
  const [error, setError] = useState("");
  const [applied, setApplied] = useState<{ before: string; after: string } | null>(null);
  const inFlight = useRef(false);
  const applyInFlight = useRef(false);

  const submit = (draft: ChatDraft): boolean => {
    const ownsUpdate = draft.command ? draft.command === UPDATE_COMMAND
      : !commands.some((command) => command.name === UPDATE_COMMAND.name);
    if (draft.text.trim() !== "/update" || draft.image !== null || !ownsUpdate) return submitPrompt(draft);
    setOpen(true);
    return true;
  };

  const install = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("running");
    setError("");
    try {
      await apiVoid("/api/system/update", { method: "POST", body: {} });
      setPhase("success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("chat.updateFailed"));
      setPhase("error");
    } finally {
      inFlight.current = false;
    }
  };

  const apply = async (): Promise<void> => {
    if (applyInFlight.current) return;
    applyInFlight.current = true;
    setPhase("applying");
    setError("");
    try {
      const result = await restartEngine();
      setApplied({ before: result.engineVersionBefore, after: result.engineVersionAfter });
      setPhase("applied");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("chat.updateApplyFailed"));
      setPhase("apply-failed");
    } finally {
      applyInFlight.current = false;
    }
  };

  const dialog = (
    <ModalDialog open={open} onClose={() => setOpen(false)} labelledBy={titleId} closeLabel={t("common.close")}>
      <div className="th-confirm th-update-dialog" data-update-state={phase}>
        <h2 id={titleId} className="th-confirm-title">{t("chat.updateTitle")}</h2>
        <p className="th-confirm-message" role="status" aria-live="polite">
          {phase === "applied" && applied ? t("chat.updateApplied", applied) : t(MESSAGE_KEYS[phase])}
        </p>
        {error && <pre className="th-update-output" role="alert" tabIndex={0}>{error}</pre>}
        <div className="th-confirm-actions">
          <button type="button" className="th-btn th-btn--ghost" data-update-close onClick={() => setOpen(false)}>
            {t(phase === "confirm" ? "common.cancel" : "common.close")}
          </button>
          {(phase === "confirm" || phase === "running" || phase === "error") && (
            <button type="button" className="th-btn th-btn--primary" data-update-confirm
              disabled={phase === "running"} onClick={() => void install()}>
              {t(phase === "error" ? "common.retry" : "chat.updateAction")}
            </button>
          )}
          {(phase === "success" || phase === "applying" || phase === "apply-failed") && (
            <button type="button" className="th-btn th-btn--primary" data-update-apply
              disabled={phase === "applying"} onClick={() => void apply()}>
              {t(phase === "apply-failed" ? "chat.updateApplyRetry" : "chat.updateApplyAction")}
            </button>
          )}
        </div>
      </div>
    </ModalDialog>
  );

  return { submit, dialog };
}
