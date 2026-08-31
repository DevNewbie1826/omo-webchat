import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { useT } from "../../i18n";
import { fsList, uploadFiles } from "./terminal";
import { joinPath } from "../../lib/path";
import type { FsList } from "./terminal";
import { FileEditor } from "./FileEditor";
import type { FileEditorCloseRequest } from "./FileEditor";
import { FileTree } from "./FileTree";
import { IconAlert, IconUpload, IconX } from "../../components/icons";
import type { ToastKind } from "../../components/SessionTree";

export interface FileBrowserProps {
  readonly path: string;
  readonly wsId: string;
  readonly tmId: string;
  readonly onClose: () => void;
  readonly notify: (msg: string, kind?: ToastKind) => void;
  readonly width: number;
  readonly onWidthChange: (px: number) => void;
}

export function FileBrowser({ path, wsId, tmId, onClose, notify, width, onWidthChange }: FileBrowserProps) {
  const { t, lang } = useT();
  const FILES_PANEL_MIN = 240;
  const FILES_PANEL_MAX = 720;
  const FILES_PANEL_KEY_STEP = 24;
  const [data, setData] = useState<FsList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const browserRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [tick, setTick] = useState(0);
  const activeRequestRef = useRef(0);
  const restoreFilePathRef = useRef<string | null>(null);
  const [closeRequest, setCloseRequest] = useState<FileEditorCloseRequest>();
  const [editing, setEditing] = useState<{ readonly name: string; readonly path: string } | null>(
    null,
  );

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    activeRequestRef.current = tick;
    setLoading(true);
    setError("");
    fsList(path)
      .then((res) => {
        if (!cancelled && activeRequestRef.current === tick) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled && activeRequestRef.current === tick) setError(err instanceof Error ? err.message : t("files.error"));
      })
      .finally(() => {
        if (!cancelled && activeRequestRef.current === tick) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick, t]);

  const upload = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0 || uploadingRef.current) return;
      uploadingRef.current = true;
      setUploading(true);
      try {
        await uploadFiles(wsId, tmId, files);
        notify(t("toast.uploaded", { n: files.length }), "success");
        setTick((n) => n + 1);
      } catch (err: unknown) {
        notify(err instanceof Error ? err.message : t("toast.uploadFailed"), "error");
      } finally {
        uploadingRef.current = false;
        setUploading(false);
        setDragOver(false);
      }
    },
    [wsId, tmId, notify, t],
  );

  const onChooseFiles = (ev: ChangeEvent<HTMLInputElement>): void => {
    const input = ev.currentTarget;
    void upload(Array.from(input.files ?? [])).finally(() => {
      input.value = "";
    });
  };

  const onDrop = (ev: DragEvent<HTMLDivElement>): void => {
    ev.preventDefault();
    void upload(Array.from(ev.dataTransfer.files));
  };

  const openFile = useCallback((name: string, dir: string): void => {
    const filePath = joinPath(dir, name);
    restoreFilePathRef.current = filePath;
    setCloseRequest(undefined);
    setEditing({ name, path: filePath });
  }, []);

  useEffect(() => {
    if (editing || !restoreFilePathRef.current) return;
    const row = Array.from(browserRef.current?.querySelectorAll<HTMLButtonElement>("[data-file-path]") ?? [])
      .find((button) => button.dataset["filePath"] === restoreFilePathRef.current);
    (row ?? closeButtonRef.current)?.focus();
    restoreFilePathRef.current = null;
  }, [editing]);

  const requestBrowserClose = (): void => {
    if (!editing) {
      onClose();
      return;
    }
    setCloseRequest((request) => ({ id: (request?.id ?? 0) + 1, target: "browser" }));
  };

  const startResize = (ev: React.PointerEvent<HTMLDivElement>): void => {
    ev.preventDefault();
    const aside = browserRef.current;
    if (!aside) return;
    const right = aside.getBoundingClientRect().right;
    const move = (e: PointerEvent): void => {
      onWidthChange(Math.min(FILES_PANEL_MAX, Math.max(FILES_PANEL_MIN, Math.round(right - e.clientX))));
    };
    const up = (): void => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const onKeyResize = (ev: React.KeyboardEvent<HTMLDivElement>): void => {
    if (ev.key === "ArrowLeft") { ev.preventDefault(); onWidthChange(Math.min(FILES_PANEL_MAX, width + FILES_PANEL_KEY_STEP)); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); onWidthChange(Math.max(FILES_PANEL_MIN, width - FILES_PANEL_KEY_STEP)); }
  };

  const locale = lang === "ko" ? "ko-KR" : "en-US";

  return (
    <aside
      ref={browserRef}
      className={`th-files${dragOver ? " th-files--drag" : ""}`}
      style={{ "--th-files-width": `${width}px` } as React.CSSProperties}
      onDragOver={(ev) => {
        ev.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(ev) => {
        if (ev.target === ev.currentTarget) setDragOver(false);
      }}
      onDrop={onDrop}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        requestBrowserClose();
      }}
      aria-label={t("files.title")}
    >
      <div
        className="th-files-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("files.resize")}
        aria-valuenow={width}
        aria-valuemin={FILES_PANEL_MIN}
        aria-valuemax={FILES_PANEL_MAX}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onKeyResize}
      />
      <div className="th-files-head">
        <span className="th-files-title">{t("files.title")}</span>
        <span className="th-files-path" title={path}>
          {data?.path ?? path}
        </span>
        <button
          ref={closeButtonRef}
          type="button"
          className="th-btn-icon"
          title={t("files.close")}
          aria-label={t("files.close")}
          onClick={requestBrowserClose}
        >
          <IconX size={14} />
        </button>
      </div>
      {editing ? (
        <FileEditor
          path={editing.path}
          name={editing.name}
          {...(closeRequest ? { requestClose: closeRequest } : {})}
          onClose={(target) => {
            if (target === "browser") onClose();
            else setEditing(null);
          }}
          notify={notify}
        />
      ) : (
        <>
          <div
            className={`th-files-drop${uploading ? " th-files-drop--busy" : ""}`}
            aria-busy={uploading}
          >
            <IconUpload size={15} />
            <span>{uploading ? t("files.uploading") : t("files.uploadHint")}</span>
            <button
              type="button"
              className="th-btn th-btn--ghost th-files-choose"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {t("files.choose")}
            </button>
            <input
              ref={fileInputRef}
              className="th-files-input"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={onChooseFiles}
            />
          </div>

          {error.length > 0 ? (
            <div className="th-files-status">
              <span className="th-alert th-alert--error" role="alert">
                <IconAlert size={15} />
                <span>{error}</span>
              </span>
              <button
                type="button"
                className="th-btn th-btn--ghost"
                onClick={() => setTick((n) => n + 1)}
              >
                {t("files.retry")}
              </button>
            </div>
          ) : loading || !data ? (
            <div className="th-files-status">{t("wizard.loading")}</div>
          ) : data.entries.length === 0 ? (
            <div className="th-files-status">{t("files.empty")}</div>
          ) : (
            <FileTree entries={data.entries} path={data.path} locale={locale} onOpenFile={openFile} />
          )}
        </>
      )}
    </aside>
  );
}
