import { useT } from "../../i18n";

const TOTAL_STEPS = 3;

interface WorkspaceWizardHeaderProps {
  readonly step: number;
}

export function WorkspaceWizardHeader({ step }: WorkspaceWizardHeaderProps) {
  const { t } = useT();
  const titles: Readonly<Record<number, readonly [string, string]>> = {
    1: [t("wizard.step1Title"), t("wizard.step1Desc")],
    2: [t("wizard.step2Title"), t("wizard.step2Desc")],
    3: [t("wizard.step3Title"), t("wizard.step3Desc")],
  };
  const [title, desc] = titles[step] ?? [t("wizard.title"), ""];

  return (
    <div className="th-wizard-head">
      <div className="th-wizard-kicker">
        {t("wizard.stepOf", { n: step, total: TOTAL_STEPS })}
      </div>
      <h2 className="th-wizard-title" id="th-wizard-title">
        {title}
      </h2>
      <p className="th-wizard-desc">{desc}</p>
      <div className="th-wizard-steps" aria-hidden="true">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            className={
              n < step
                ? "th-wizard-step th-wizard-step--done"
                : n === step
                  ? "th-wizard-step th-wizard-step--current"
                  : "th-wizard-step"
            }
          />
        ))}
      </div>
    </div>
  );
}
