import { useT } from "../../i18n";
import type { ResumeCandidate } from "../../lib/chatWs";

export interface MissingOriginalBannerProps {
  readonly candidates: readonly ResumeCandidate[];
}

/**
 * Shown when a chat's stored identity no longer resolves (resume_failed):
 * when branch candidates exist the original conversation IS recoverable — it
 * lives inside another session file — so the headline says so and lists the
 * hosts. Only the no-candidate case is a true "not found".
 */
export function MissingOriginalBanner({ candidates }: MissingOriginalBannerProps) {
  const { t } = useT();
  const recoverable = candidates.length > 0;
  return (
    <div className="th-alert th-alert--warning" role="status">
      <span>
        <strong>{t(recoverable ? "chat.missingOriginalElsewhere" : "chat.missingOriginal")}</strong>
        {recoverable ? (
          <ul className="th-alert-list">
            {candidates.map((candidate) => (
              <li key={candidate.id}>{candidate.name}</li>
            ))}
          </ul>
        ) : (
          <span>{t("chat.missingOriginalNone")}</span>
        )}
      </span>
    </div>
  );
}
