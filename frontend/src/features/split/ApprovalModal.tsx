import { useId, useState } from "react";
import { ModalDialog } from "../../components/ModalDialog";
import { useT } from "../../i18n";

export interface ApprovalRequest {
  readonly id: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly string[];
  readonly prefill?: string;
  readonly placeholder?: string;
}

export interface ApprovalModalProps {
  readonly request: ApprovalRequest;
  readonly onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}

export function ApprovalModal({ request, onRespond }: ApprovalModalProps) {
  const { t } = useT();
  const titleId = useId();
  const [text, setText] = useState(request.prefill ?? "");

  const submitValue = (value: string): void => onRespond({ value });
  const submitConfirm = (confirmed: boolean): void => onRespond({ confirmed });
  const cancel = (): void => onRespond({ cancelled: true });

  return (
    <ModalDialog
      open
      onClose={cancel}
      labelledBy={titleId}
      closeLabel={t("approval.cancel")}
      initialFocusSelector="[data-approval-primary]"
    >
      <div className="th-approval-card">
        <h3 id={titleId} className="th-approval-title">{request.title ?? t("approval.title")}</h3>
        {request.message && <p className="th-approval-message">{request.message}</p>}

        {request.method === "select" && (
          <div className="th-approval-options">
            {(request.options ?? []).map((opt, index) => (
              <button key={opt} type="button" className="th-btn" data-approval-primary={index === 0 ? "" : undefined} onClick={() => submitValue(opt)}>
                {opt}
              </button>
            ))}
            <button type="button" className="th-btn th-btn--ghost" data-approval-primary={(request.options ?? []).length === 0 ? "" : undefined} onClick={cancel}>
              {t("approval.cancel")}
            </button>
          </div>
        )}

        {request.method === "confirm" && (
          <div className="th-approval-options">
            <button type="button" className="th-btn" data-approval-primary onClick={() => submitConfirm(true)}>
              {t("approval.confirm")}
            </button>
            <button type="button" className="th-btn th-btn--ghost" onClick={() => submitConfirm(false)}>
              {t("approval.deny")}
            </button>
          </div>
        )}

        {(request.method === "input" || request.method === "editor") && (
          <form
            className="th-approval-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitValue(text);
            }}
          >
            {request.method === "editor" ? (
              <textarea
                className="th-approval-input th-approval-editor"
                data-approval-primary
                placeholder={request.placeholder ?? ""}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            ) : (
              <input
                type="text"
                className="th-approval-input"
                data-approval-primary
                placeholder={request.placeholder ?? ""}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            )}
            <button type="submit" className="th-btn">{t("approval.submit")}</button>
            <button type="button" className="th-btn th-btn--ghost" onClick={cancel}>
              {t("approval.cancel")}
            </button>
          </form>
        )}
      </div>
    </ModalDialog>
  );
}
