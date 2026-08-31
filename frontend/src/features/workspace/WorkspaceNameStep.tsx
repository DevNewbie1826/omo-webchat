import { IconAlert } from "../../components/icons";
import { useT } from "../../i18n";

interface WorkspaceNameStepProps {
  readonly name: string;
  readonly nameTouched: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onNameTouched: () => void;
  readonly onNext: () => void;
}

export function WorkspaceNameStep({
  name,
  nameTouched,
  onNameChange,
  onNameTouched,
  onNext,
}: WorkspaceNameStepProps) {
  const { t } = useT();

  return (
    <div className="th-field">
      <label className="th-field-label" htmlFor="th-ws-name">
        {t("wizard.nameLabel")}
      </label>
      <input
        id="th-ws-name"
        className="th-input th-input--mono"
        autoFocus
        value={name}
        placeholder={t("wizard.namePlaceholder")}
        onChange={(ev) => {
          onNameChange(ev.target.value);
          onNameTouched();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && name.trim().length > 0) onNext();
        }}
      />
      {nameTouched && name.trim().length === 0 && (
        <span className="th-alert th-alert--warning" role="alert">
          <IconAlert size={14} />
          <span>{t("wizard.nameRequired")}</span>
        </span>
      )}
    </div>
  );
}
