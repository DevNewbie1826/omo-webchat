import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiDownload } from "../../lib/api";
import { joinPath } from "../../lib/path";
import { IconChevron, IconDownload, IconFile, IconFolder } from "../../components/icons";
import { downloadUrl, fsList } from "./terminal";
import type { FsEntry, FsList } from "./terminal";

interface FileTreeProps {
  readonly entries: readonly FsEntry[];
  readonly path: string;
  readonly locale: string;
  readonly onOpenFile: (name: string, dir: string) => void;
}

function sortEntries(entries: readonly FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

const INDENT_BASE = 8;
const INDENT_STEP = 16;

function indentStyle(depth: number): { readonly paddingLeft: number } {
  return { paddingLeft: INDENT_BASE + depth * INDENT_STEP };
}

interface EntryRowProps {
  readonly depth: number;
  readonly locale: string;
  readonly onOpenFile: (name: string, dir: string) => void;
}

interface FileRowProps extends EntryRowProps {
  readonly entry: FsEntry;
  readonly dir: string;
}

function FileRow({ entry, dir, depth, locale, onOpenFile }: FileRowProps) {
  const { t } = useT();
  return (
    <div className="th-files-row" style={indentStyle(depth)}>
      <IconFile size={14} />
      <button
        type="button"
        className="th-files-name th-files-name--link"
        data-file-path={joinPath(dir, entry.name)}
        title={t("files.openEditor")}
        onClick={() => onOpenFile(entry.name, dir)}
      >
        {entry.name}
      </button>
      <span className="th-files-meta">{formatSize(entry.size)}</span>
      <span className="th-files-meta th-files-meta--dim">
        {new Date(entry.modTime).toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <button
        type="button"
        className="th-files-dl"
        title={t("files.download")}
        onClick={() => {
          void apiDownload(downloadUrl(joinPath(dir, entry.name)), entry.name).catch((error: unknown) => {
            console.error("File download failed", error);
          });
        }}
      >
        <IconDownload size={13} />
      </button>
    </div>
  );
}

interface FolderNodeProps extends EntryRowProps {
  readonly name: string;
  readonly path: string;
}

function FolderNode({ name, path, depth, locale, onOpenFile }: FolderNodeProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null && !loading) {
      setLoading(true);
      setError("");
      fsList(path)
        .then((res) => {
          if (mountedRef.current) setChildren(res);
        })
        .catch((err: unknown) => {
          if (mountedRef.current) setError(err instanceof Error ? err.message : t("files.error"));
        })
        .finally(() => {
          if (mountedRef.current) setLoading(false);
        });
    }
  };

  const indent = indentStyle(depth);
  const childIndent = indentStyle(depth + 1);

  return (
    <>
      <div className="th-files-row th-files-row--muted" style={indent}>
        <button
          type="button"
          className={`th-files-chevron${expanded ? " th-files-chevron--open" : ""}`}
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={name}
        >
          <IconChevron size={12} />
        </button>
        <IconFolder size={14} />
        <button type="button" className="th-files-name th-files-name--dir" onClick={toggle}>
          {name}
        </button>
      </div>
      {expanded &&
        (loading ? (
          <div className="th-files-childstatus" style={childIndent}>
            {t("wizard.loading")}
          </div>
        ) : error.length > 0 ? (
          <div className="th-files-childstatus th-files-childstatus--error" style={childIndent}>
            {error}
          </div>
        ) : children === null ? null : children.entries.length === 0 ? (
          <div className="th-files-childstatus" style={childIndent}>
            {t("files.empty")}
          </div>
        ) : (
          sortEntries(children.entries).map((entry) =>
            entry.isDir ? (
              <FolderNode
                key={`d-${entry.name}`}
                name={entry.name}
                path={joinPath(path, entry.name)}
                depth={depth + 1}
                locale={locale}
                onOpenFile={onOpenFile}
              />
            ) : (
              <FileRow
                key={`f-${entry.name}`}
                entry={entry}
                dir={path}
                depth={depth + 1}
                locale={locale}
                onOpenFile={onOpenFile}
              />
            ),
          )
        ))}
    </>
  );
}

export function FileTree({ entries, path, locale, onOpenFile }: FileTreeProps) {
  return (
    <div className="th-files-list">
      {sortEntries(entries).map((entry) =>
        entry.isDir ? (
          <FolderNode
            key={entry.name}
            name={entry.name}
            path={joinPath(path, entry.name)}
            depth={0}
            locale={locale}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileRow
            key={entry.name}
            entry={entry}
            dir={path}
            depth={0}
            locale={locale}
            onOpenFile={onOpenFile}
          />
        ),
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
