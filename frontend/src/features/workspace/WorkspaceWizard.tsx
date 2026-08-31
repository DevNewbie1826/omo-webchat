import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { ModalDialog } from "../../components/ModalDialog";
import { IconAlert } from "../../components/icons";
import { createWorkspace } from "./workspace";
import type { Workspace } from "./workspace";
import { fsBrowse } from "../terminal/terminal";
import type { FsBrowse } from "../terminal/terminal";
import { WorkspaceConfirmationStep } from "./WorkspaceConfirmationStep";
import { WorkspaceFolderPickerStep } from "./WorkspaceFolderPickerStep";
import { WorkspaceNameStep } from "./WorkspaceNameStep";
import { WorkspaceWizardHeader } from "./WorkspaceWizardHeader";

export interface WorkspaceWizardProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (ws: Workspace) => void;
}

export function WorkspaceWizard({ open, onClose, onCreated }: WorkspaceWizardProps) {
  const { t } = useT();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const picker = useFolderPicker(open);
  const creatingRef = useRef(false);
  const createGeneration = useRef(0);

  // Reset wizard state each time it opens, and invalidate a request if its
  // owner closes the dialog through any external path.
  useEffect(() => {
    if (open) {
      setStep(1);
      setName("");
      setNameTouched(false);
      creatingRef.current = false;
      setCreating(false);
      setError("");
      return;
    }
    createGeneration.current += 1;
    creatingRef.current = false;
  }, [open]);

  const closeWizard = useCallback((): void => {
    createGeneration.current += 1;
    creatingRef.current = false;
    onClose();
  }, [onClose]);

  const create = async (): Promise<void> => {
    const path = picker.selected;
    if (creatingRef.current || !path) return;
    creatingRef.current = true;
    const generation = createGeneration.current;
    setCreating(true);
    setError("");
    try {
      const ws = await createWorkspace(name.trim(), path);
      if (generation !== createGeneration.current) return;
      onCreated(ws);
      closeWizard();
    } catch (err) {
      if (generation !== createGeneration.current) return;
      setError(err instanceof Error ? err.message : t("wizard.createError"));
    } finally {
      if (generation === createGeneration.current) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  };

  const nextFromPicker = (): void => {
    if (!picker.selected) return;
    if (name.trim().length === 0) setName(basename(picker.selected));
    setStep(2);
  };
  return (
    <ModalDialog open={open} onClose={closeWizard} labelledBy="th-wizard-title" closeLabel={t("common.close")}>
      <WorkspaceWizardHeader step={step} />

      <div className="th-wizard-body">
        {error.length > 0 && (
          <div className="th-alert th-alert--error" role="alert" style={{ marginBottom: 14 }}>
            <IconAlert size={15} />
            <span>{error}</span>
          </div>
        )}

        {step === 1 && <WorkspaceFolderPickerStep picker={picker} onSelect={nextFromPicker} />}

        {step === 2 && (
          <WorkspaceNameStep
            name={name}
            nameTouched={nameTouched}
            onNameChange={setName}
            onNameTouched={() => setNameTouched(true)}
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && <WorkspaceConfirmationStep name={name} path={picker.selected} />}
      </div>

      <div className="th-wizard-foot">
        <button type="button" className="th-btn th-btn--ghost" onClick={closeWizard}>
          {t("wizard.cancel")}
        </button>
        <div className="th-wizard-foot-spacer" />
        {step > 1 && (
          <button
            type="button"
            className="th-btn th-btn--ghost"
            disabled={creating}
            onClick={() => setStep(step - 1)}
          >
            {t("wizard.back")}
          </button>
        )}
        {step === 1 && (
          <button
            type="button"
            className="th-btn th-btn--primary"
            disabled={!picker.selected}
            onClick={nextFromPicker}
          >
            {t("wizard.next")}
          </button>
        )}
        {step === 2 && (
          <button
            type="button"
            className="th-btn th-btn--primary"
            disabled={name.trim().length === 0}
            onClick={() => setStep(3)}
          >
            {t("wizard.next")}
          </button>
        )}
        {step === 3 && (
          <button type="button" className="th-btn th-btn--primary" disabled={creating} onClick={create}>
            {creating ? t("wizard.creating") : t("wizard.create")}
          </button>
        )}
      </div>
    </ModalDialog>
  );
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export interface FolderPickerState {
  readonly data: FsBrowse | null;
  readonly selected: string | null;
  readonly loading: boolean;
  readonly error: string;
  readonly navigate: (path: string) => void;
  readonly reload: () => void;
}

function useFolderPicker(active: boolean): FolderPickerState {
  const { t } = useT();
  const [data, setData] = useState<FsBrowse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      setData(null);
      setSelected(null);
      setError("");
      setTick(0);
      return;
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fsBrowse(selected ?? "")
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setSelected(res.path);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("wizard.browseError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, selected, tick, t]);

  const navigate = useCallback((path: string) => setSelected(path), []);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { data, selected, loading, error, navigate, reload };
}

