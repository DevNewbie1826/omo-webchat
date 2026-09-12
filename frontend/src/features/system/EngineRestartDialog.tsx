import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { ModalDialog } from "../../components/ModalDialog";
import { IconAlert } from "../../components/icons";
import { restartEngine } from "./system";

export interface EngineRestartDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Chats the sidebar currently treats as running; drives the confirm warning. */
  readonly runningChats: number;
}

type Phase =
  | { readonly kind: "confirm" }
  | { readonly kind: "running" }
  | { readonly kind: "success"; readonly before: string; readonly after: string }
  | { readonly kind: "error"; readonly message: string };

export function EngineRestartDialog({ open, onClose, runningChats }: EngineRestartDialogProps) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  // One in-flight request per dialog: the ref guards re-entry within the same
  // frame, before the disabled confirm button can reach the DOM.
  const inFlightRef = useRef(false);

  // Closing never cancels the request, so a reopen during one must show the
  // work in progress; only an idle dialog starts a fresh confirmation.
  useEffect(() => {
    if (open && !inFlightRef.current) setPhase({ kind: "confirm" });
  }, [open]);

  const start = (): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase({ kind: "running" });
    restartEngine()
      .then((res) => {
        setPhase({ kind: "success", before: res.engineVersionBefore, after: res.engineVersionAfter });
      })
      .catch((err: unknown) => {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : t("engineRestart.error") });
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  };

  return (
    <ModalDialog open={open} onClose={onClose} labelledBy="th-engine-restart-title" closeLabel={t("common.close")}>
      <div className="th-confirm">
        <h2 id="th-engine-restart-title" className="th-confirm-title">
          {t("engineRestart.title")}
        </h2>
        <p className="th-confirm-message">{t("engineRestart.description")}</p>
        {phase.kind === "confirm" && runningChats > 0 && (
          <span className="th-alert th-alert--warning">
            <IconAlert size={15} />
            <span>{t("engineRestart.runningWarning", { count: runningChats })}</span>
          </span>
        )}
        {(phase.kind === "running" || phase.kind === "success") && (
          <p className="th-confirm-message" role="status" aria-live="polite">
            {phase.kind === "running"
              ? t("engineRestart.running")
              : t("engineRestart.success", { before: phase.before, after: phase.after })}
          </p>
        )}
        {phase.kind === "error" && (
          <span className="th-alert th-alert--error" role="alert">
            <IconAlert size={15} />
            <span>{phase.message}</span>
          </span>
        )}
        <div className="th-confirm-actions">
          <button type="button" className="th-btn th-btn--ghost" onClick={onClose}>
            {phase.kind === "success" ? t("common.close") : t("wizard.cancel")}
          </button>
          {phase.kind === "error" ? (
            <button type="button" className="th-btn th-btn--primary" onClick={start}>
              {t("engineRestart.retry")}
            </button>
          ) : (
            phase.kind !== "success" && (
              <button
                type="button"
                className="th-btn th-btn--danger"
                disabled={phase.kind === "running"}
                onClick={start}
              >
                {t("engineRestart.confirm")}
              </button>
            )
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
