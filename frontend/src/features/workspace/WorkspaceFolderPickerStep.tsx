import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { IconAlert, IconArrowUp, IconCheck, IconFolder, IconFolderOpen, IconPlus, IconX } from "../../components/icons";
import { useT } from "../../i18n";
import { joinPath } from "../../lib/path";
import { fsCreateFolder } from "../terminal/terminal";
import type { FolderPickerState } from "./WorkspaceWizard";

interface WorkspaceFolderPickerStepProps {
  readonly picker: FolderPickerState;
  readonly onSelect: () => void;
}

export function WorkspaceFolderPickerStep({ picker, onSelect }: WorkspaceFolderPickerStepProps) {
  const { t } = useT();
  const data = picker.data;
  const parent = data?.parent;
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Starting over in a different directory invalidates the in-progress name.
  useEffect(() => {
    setNaming(false);
    setNewName("");
    setCreateError("");
  }, [data?.path]);

  const submitNewFolder = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = newName.trim();
    if (!data || creating || name.length === 0) return;
    setCreating(true);
    setCreateError("");
    try {
      const created = await fsCreateFolder(data.path, name);
      setNaming(false);
      setNewName("");
      picker.navigate(created.path);
      picker.reload();
    } catch (err) {
      setCreateError(
        err instanceof Error && err.message.length > 0 ? err.message : t("wizard.createFolderError"),
      );
    } finally {
      setCreating(false);
    }
  };

  if (picker.error.length > 0) {
    return (
      <div className="th-picker-status">
        <span className="th-alert th-alert--error" role="alert">
          <IconAlert size={15} />
          <span>{picker.error}</span>
        </span>
      </div>
    );
  }

  return (
    <div>
      <div className="th-picker-path">
        <IconFolderOpen size={14} />
        <span className="th-picker-path-text">{data?.path ?? "…"}</span>
      </div>

      {picker.loading || !data ? (
        <div className="th-picker-status">{t("wizard.loading")}</div>
      ) : (
        <div className="th-picker-list" role="list" aria-label={t("wizard.step1Title")}>
          {parent && (
            <button
              type="button"
              className="th-picker-row"
              onClick={() => picker.navigate(parent)}
            >
              <IconArrowUp size={14} />
              <span className="th-picker-row-label">{t("picker.parent")}</span>
            </button>
          )}
          {data.dirs.length === 0 && <div className="th-picker-status">{t("picker.empty")}</div>}
          {data.dirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="th-picker-row"
              onClick={() => picker.navigate(joinPath(data.path, dir))}
            >
              <IconFolder size={14} />
              <span className="th-picker-row-label">{dir}</span>
            </button>
          ))}
        </div>
      )}

      {data && (
        <div className="th-picker-newfolder">
          {createError.length > 0 && (
            <span className="th-alert th-alert--error" role="alert">
              <IconAlert size={15} />
              <span>{createError}</span>
            </span>
          )}
          {naming ? (
            <form
              className="th-picker-newfolder-form"
              onSubmit={(event) => {
                void submitNewFolder(event);
              }}
            >
              <input
                type="text"
                className="th-input th-picker-newfolder-input"
                value={newName}
                placeholder={t("wizard.newFolderPlaceholder")}
                aria-label={t("wizard.newFolder")}
                autoFocus
                disabled={creating}
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="submit"
                className="th-btn th-btn--primary"
                disabled={creating || newName.trim().length === 0}
              >
                <IconCheck size={13} />
                {creating ? t("wizard.creatingFolder") : t("wizard.newFolder")}
              </button>
              <button
                type="button"
                className="th-btn th-btn--ghost"
                disabled={creating}
                onClick={() => {
                  setNaming(false);
                  setNewName("");
                }}
              >
                <IconX size={13} />
                {t("wizard.cancel")}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="th-btn th-btn--ghost th-picker-newfolder-toggle"
              onClick={() => setNaming(true)}
            >
              <IconPlus size={13} />
              {t("wizard.newFolder")}
            </button>
          )}
        </div>
      )}

      <div className="th-picker-select">
        <span className="th-picker-select-path">{picker.selected ?? "…"}</span>
        <button
          type="button"
          className="th-btn th-btn--ghost"
          onClick={onSelect}
          disabled={!picker.selected}
        >
          <IconCheck size={13} />
          {t("wizard.selectHere")}
        </button>
      </div>
    </div>
  );
}
