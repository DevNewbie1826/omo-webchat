import { useEffect, useRef } from "react";
import { IconFile, IconFolder } from "../../components/icons";
import type { FileMatch } from "./fileSearch";

interface FilePaletteProps {
  readonly id: string;
  readonly optionIdPrefix: string;
  readonly results: readonly FileMatch[];
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly statusLabel: string | null;
  readonly emptyHint: string | null;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly capped: boolean;
  readonly cappedLabel: string;
  readonly onActiveIndex: (index: number) => void;
  readonly onSelect: (file: FileMatch) => void;
}

export function FilePalette({
  id,
  optionIdPrefix,
  results,
  activeIndex,
  loading,
  statusLabel,
  emptyHint,
  loadingLabel,
  emptyLabel,
  capped,
  cappedLabel,
  onActiveIndex,
  onSelect,
}: FilePaletteProps) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  // While re-fetching on navigation, keep the previous listing on screen
  // (avoids a flash to "loading"); only show a status row when there are no
  // results to display.
  const showStatus = results.length === 0;
  const statusText = loading ? loadingLabel : (statusLabel ?? emptyLabel);

  return (
    <div className="th-chat-slash th-chat-files" id={id} role="listbox">
      {showStatus ? (
        <div className="th-chat-files-status" role="status">
          {statusText}
        </div>
      ) : (
        <>
          {results.map((file, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={file.path}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                id={`${optionIdPrefix}-${index}`}
                type="button"
                role="option"
                aria-selected={active}
                onMouseMove={() => onActiveIndex(index)}
                onMouseEnter={() => onActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(file)}
                className={file.isDir || file.isParent ? "th-chat-files-dir" : undefined}
              >
                <span aria-hidden="true">{active ? "›" : " "}</span>
                {file.isParent ? (
                  <span className="th-chat-files-up" aria-hidden="true">
                    ‹
                  </span>
                ) : file.isDir ? (
                  <IconFolder size={13} />
                ) : (
                  <IconFile size={13} />
                )}
                <strong>{file.name}</strong>
                {!file.isDir && !file.isParent && file.path && file.path !== file.name ? (
                  <span className="th-chat-files-path">{file.path}</span>
                ) : null}
              </button>
            );
          })}
          {emptyHint ? (
            <div className="th-chat-files-status" role="status">
              {emptyHint}
            </div>
          ) : null}
          {capped ? (
            <div className="th-chat-files-capped" role="status">
              {cappedLabel}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
