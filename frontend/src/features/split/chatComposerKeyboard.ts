import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import type { CommandEntry } from "../../lib/chatWs";
import type { FileMatch } from "./fileSearch";
import type { FileMention } from "./useFileMention";

interface FileKeyboardState {
  readonly open: boolean;
  readonly mention: FileMention;
  readonly onSelect: (file: FileMatch) => void;
}

interface CommandKeyboardState {
  readonly open: boolean;
  readonly matches: readonly CommandEntry[];
  readonly selectedIndex: number;
  readonly onSelect: (command: CommandEntry) => void;
  readonly setActiveIndex: Dispatch<SetStateAction<number>>;
  readonly setHidden: Dispatch<SetStateAction<boolean>>;
}

interface RunKeyboardState {
  readonly running: boolean;
  readonly onSteer: () => void;
  readonly onStop: () => void;
  readonly onSubmit: () => void;
}

interface ChatComposerKeyboardContext {
  readonly file: FileKeyboardState;
  readonly command: CommandKeyboardState;
  readonly run: RunKeyboardState;
  readonly isMobile: boolean;
}

export function handleChatComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  context: ChatComposerKeyboardContext,
): void {
  if (event.nativeEvent.isComposing) return;
  if (context.file.open && !event.shiftKey) {
    const count = context.file.mention.results.length;
    const current = context.file.mention.activeIndex;
    if (count > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      context.file.mention.setActiveIndex(current < 0 ? 0 : (current + 1) % count);
      return;
    }
    if (count > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      context.file.mention.setActiveIndex(current <= 0 ? count - 1 : current - 1);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      if (count > 0) {
        const file = context.file.mention.results[current] ?? context.file.mention.results[0];
        if (file) context.file.onSelect(file);
      } else {
        context.file.mention.hide();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      context.file.mention.hide();
      return;
    }
  }
  if (context.run.running && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    context.run.onSteer();
    return;
  }
  if (context.command.open && !event.shiftKey) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      context.command.setActiveIndex((index) => {
        const current = Math.min(Math.max(index, 0), context.command.matches.length - 1);
        return (current + 1) % context.command.matches.length;
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      context.command.setActiveIndex((index) => {
        const current = Math.min(Math.max(index, 0), context.command.matches.length - 1);
        return current <= 0 ? context.command.matches.length - 1 : current - 1;
      });
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const command = context.command.matches[context.command.selectedIndex] ?? context.command.matches[0];
      if (command) context.command.onSelect(command);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      context.command.setHidden(true);
      context.command.setActiveIndex(-1);
      return;
    }
  }
  if (event.key === "Escape" && context.run.running && !context.command.open) {
    event.preventDefault();
    context.run.onStop();
    return;
  }
  if (
    event.key === "Enter"
    && !context.isMobile
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
  ) {
    event.preventDefault();
    context.run.onSubmit();
  }
}
