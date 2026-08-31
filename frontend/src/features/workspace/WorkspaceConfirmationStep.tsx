import { useT } from "../../i18n";

interface WorkspaceConfirmationStepProps {
  readonly name: string;
  readonly path: string | null;
}

export function WorkspaceConfirmationStep({ name, path }: WorkspaceConfirmationStepProps) {
  const { t } = useT();

  return (
    <div className="th-summary">
      <div className="th-summary-row">
        <span className="th-summary-key">{t("wizard.summaryName")}</span>
        <span className="th-summary-val">{name.trim()}</span>
      </div>
      <div className="th-summary-row">
        <span className="th-summary-key">{t("wizard.summaryPath")}</span>
        <span className="th-summary-val">{path}</span>
      </div>
    </div>
  );
}
