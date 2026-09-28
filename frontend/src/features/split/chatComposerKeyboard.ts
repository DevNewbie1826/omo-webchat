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
  /** A blocking question waits for its answer: Esc never aborts the run
   *  (omo keeps the question alive while it is being answered). */
  readonly blockingQuestion?: boolean;
  readonly onSteer: () => void;
  readonly onStop: () => void;
  readonly onSubmit: () => void;
  /** Alt+Enter: always send as a normal chat message, even in reply mode
   *  (omo's followUp key bypasses the question destination). */
  readonly onSubmitMessage?: () => void;
}

interface QuestionKeyboardState {
  /** The digit shortcut only fires on an empty composer (omo
   *  handleAskUserShortcut). */
  readonly inputEmpty: boolean;
  /** Option labels of the shown question's first unanswered question. */
  readonly options: readonly string[];
  readonly onPickOption: (optionIndex: number) => void;
}

interface ChatComposerKeyboardContext {
  readonly file: FileKeyboardState;
  readonly command: CommandKeyboardState;
  readonly run: RunKeyboardState;
  readonly question?: QuestionKeyboardState;
  /** True on touch-first devices (soft keyboard), where Enter inserts a
   *  newline instead of sending. Not tied to viewport width: a narrow desktop
   *  window still has a physical keyboard. */
  readonly isTouch: boolean;
}

/** Touch-first device: no hover and a coarse primary pointer. */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

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
  if (event.key === "Escape" && context.run.running && !context.run.blockingQuestion && !context.command.open) {
    event.preventDefault();
    context.run.onStop();
    return;
  }
  // Empty composer + a shown question: 1-9 opens the question window with
  // that option picked (omo handleAskUserShortcut); the digit never inserts.
  if (
    context.question
    && context.question.inputEmpty
    && !context.command.open
    && !context.file.open
    && /^[1-9]$/.test(event.key)
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
  ) {
    const optionIndex = Number(event.key) - 1;
    if (context.question.options[optionIndex] !== undefined) {
      event.preventDefault();
      context.question.onPickOption(optionIndex);
      return;
    }
  }
  if (
    event.key === "Enter"
    && event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && context.run.onSubmitMessage
  ) {
    event.preventDefault();
    context.run.onSubmitMessage();
    return;
  }
  if (
    event.key === "Enter"
    && !context.isTouch
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
  ) {
    event.preventDefault();
    context.run.onSubmit();
  }
}
