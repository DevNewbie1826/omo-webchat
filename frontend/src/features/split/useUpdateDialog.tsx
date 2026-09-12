import { useId, useRef, useState } from "react";
import { ModalDialog } from "../../components/ModalDialog";
import { useT } from "../../i18n";
import { apiVoid } from "../../lib/api";
import type { CommandEntry } from "../../lib/chatWs";
import type { ChatDraft } from "./chatSessionTypes";
import { UPDATE_COMMAND } from "./curatedCommands";

type UpdatePhase = "confirm" | "running" | "success" | "error";

const MESSAGE_KEYS = {
  confirm: "chat.updateConfirm",
  running: "chat.updateRunning",
  success: "chat.updateSuccess",
  error: "chat.updateFailed",
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
  const inFlight = useRef(false);

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

  const dialog = (
    <ModalDialog open={open} onClose={() => setOpen(false)} labelledBy={titleId} closeLabel={t("common.close")}>
      <div className="th-confirm th-update-dialog" data-update-state={phase}>
        <h2 id={titleId} className="th-confirm-title">{t("chat.updateTitle")}</h2>
        <p className="th-confirm-message" role="status" aria-live="polite">{t(MESSAGE_KEYS[phase])}</p>
        {error && <pre className="th-update-output" role="alert" tabIndex={0}>{error}</pre>}
        <div className="th-confirm-actions">
          <button type="button" className="th-btn th-btn--ghost" data-update-close onClick={() => setOpen(false)}>
            {t(phase === "confirm" ? "common.cancel" : "common.close")}
          </button>
          {phase !== "success" && (
            <button type="button" className="th-btn th-btn--primary" data-update-confirm
              disabled={phase === "running"} onClick={() => void install()}>
              {t(phase === "error" ? "common.retry" : "chat.updateAction")}
            </button>
          )}
        </div>
      </div>
    </ModalDialog>
  );

  return { submit, dialog };
}
