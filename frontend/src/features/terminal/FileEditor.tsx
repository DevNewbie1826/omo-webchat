import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useT } from "../../i18n";
import { fsRead, fsWrite } from "./terminal";
import { IconAlert, IconCheck, IconX } from "../../components/icons";
import type { ToastKind } from "../../components/SessionTree";
import { useConfirm } from "../../components/ConfirmDialog";

export interface FileEditorCloseRequest {
  readonly id: number;
  readonly target: "browser";
}

export interface FileEditorProps {
  readonly path: string;
  readonly name: string;
  readonly requestClose?: FileEditorCloseRequest;
  readonly onClose: (target: "editor" | "browser") => void;
  readonly notify: (msg: string, kind?: ToastKind) => void;
}

export function FileEditor({ path, name, requestClose, onClose, notify }: FileEditorProps) {
  const { t } = useT();
  const { confirm, dialog: confirmDialog } = useConfirm(t);
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setContent(null);
    fsRead(path)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setOriginal(res.content);
        textareaRef.current?.focus();
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("editor.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, t]);

  const dirty = content !== null && content !== original;

  const save = useCallback(async (): Promise<void> => {
    if (content === null || savingRef.current || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await fsWrite(path, content);
      setOriginal(content);
      notify(t("editor.saved"), "success");
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : t("editor.saveError"), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [path, content, dirty, notify, t]);

  const handleClose = useCallback(async (target: "editor" | "browser" = "editor"): Promise<void> => {
    if (dirty) {
      const ok = await confirm({
        title: t("editor.unsaved"),
        message: t("editor.discardConfirm"),
        confirmLabel: t("editor.discard"),
        danger: true,
      });
      if (!ok) return;
    }
    onClose(target);
  }, [dirty, onClose, t, confirm]);

  // Each close request is handled exactly once, keyed by id. handleClose is
  // read through a ref so dirty/save churn never re-runs the effect and never
  // replays a cancelled (or already settled) browser close.
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  const handledCloseIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!requestClose) return;
    if (handledCloseIdsRef.current.has(requestClose.id)) return;
    handledCloseIdsRef.current.add(requestClose.id);
    void handleCloseRef.current(requestClose.target);
  }, [requestClose]);

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "s" || ev.key === "Enter")) {
      ev.preventDefault();
      void save();
    }
  };

  return (
    <div
      className="th-editor"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        void handleClose();
      }}
    >
      <div className="th-editor-head">
        <span className="th-editor-name" title={path}>
          {name}
          {dirty && (
            <span className="th-editor-dirty" role="img" aria-label={t("editor.unsaved")}>
              ●
            </span>
          )}
        </span>
        <button
          type="button"
          className="th-btn th-btn--primary th-editor-save"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? t("editor.saving") : t("editor.save")}
          {!saving && <IconCheck size={13} />}
        </button>
        <button type="button" className="th-btn-icon" title={t("editor.close")} onClick={() => void handleClose()}>
          <IconX size={14} />
        </button>
      </div>

      {error.length > 0 ? (
        <div className="th-editor-status">
          <span className="th-alert th-alert--error" role="alert">
            <IconAlert size={15} />
            <span>{error}</span>
          </span>
          <button type="button" className="th-btn th-btn--ghost" onClick={() => void handleClose()}>
            {t("editor.close")}
          </button>
        </div>
      ) : loading || content === null ? (
        <div className="th-editor-status">{t("wizard.loading")}</div>
      ) : (
        <textarea
          ref={textareaRef}
          className="th-editor-area"
          value={content}
          onChange={(ev) => setContent(ev.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          wrap="off"
          aria-label={name}
        />
      )}
      {confirmDialog}
    </div>
  );
}
