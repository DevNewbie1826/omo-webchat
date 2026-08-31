import type { Dispatch, SetStateAction } from "react";
import type { CommandEntry } from "../../lib/chatWs";
import { CommandPalette } from "./CommandPalette";
import { FilePalette } from "./FilePalette";
import type { FileMatch } from "./fileSearch";
import type { FileMention } from "./useFileMention";

interface CommandPaletteState {
  readonly open: boolean;
  readonly id: string;
  readonly optionIdPrefix: string;
  readonly matches: readonly CommandEntry[];
  readonly selectedIndex: number;
  readonly onActiveIndex: Dispatch<SetStateAction<number>>;
  readonly onSelect: (command: CommandEntry) => void;
}

interface FilePaletteState {
  readonly open: boolean;
  readonly id: string;
  readonly optionIdPrefix: string;
  readonly mention: FileMention;
  readonly onSelect: (file: FileMatch) => void;
}

interface PaletteLabels {
  readonly pathOutsideRoot: string;
  readonly pathNotFound: string;
  readonly noFiles: string;
  readonly folderEmpty: string;
  readonly searchingFiles: string;
  readonly browseCapped: string;
}

interface ChatComposerPalettesProps {
  readonly command: CommandPaletteState;
  readonly file: FilePaletteState;
  readonly labels: PaletteLabels;
}

export function ChatComposerPalettes({ command, file, labels }: ChatComposerPalettesProps) {
  const statusLabel = file.mention.loading
    ? null
    : file.mention.mode === "browse"
      ? file.mention.status === "outsideRoot"
        ? labels.pathOutsideRoot
        : file.mention.status === "notFound"
          ? labels.pathNotFound
          : null
      : file.mention.results.length === 0
        ? labels.noFiles
        : null;
  const emptyHint =
    !file.mention.loading && file.mention.mode === "browse" && file.mention.status === "empty"
      ? labels.folderEmpty
      : null;

  return (
    <>
      {command.open && (
        <CommandPalette
          id={command.id}
          optionIdPrefix={command.optionIdPrefix}
          commands={command.matches}
          activeIndex={command.selectedIndex}
          onActiveIndex={command.onActiveIndex}
          onSelect={command.onSelect}
        />
      )}
      {file.open && (
        <FilePalette
          id={file.id}
          optionIdPrefix={file.optionIdPrefix}
          results={file.mention.results}
          activeIndex={file.mention.activeIndex}
          loading={file.mention.loading}
          statusLabel={statusLabel}
          emptyHint={emptyHint}
          loadingLabel={labels.searchingFiles}
          emptyLabel={labels.noFiles}
          capped={file.mention.capped}
          cappedLabel={labels.browseCapped}
          onActiveIndex={file.mention.setActiveIndex}
          onSelect={file.onSelect}
        />
      )}
    </>
  );
}
