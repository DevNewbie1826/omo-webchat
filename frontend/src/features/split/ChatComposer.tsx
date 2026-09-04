import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MOBILE_QUERY } from "../../components/Sidebar";
import type { CommandEntry } from "../../lib/chatWs";
import { useT } from "../../i18n";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { ChatComposerAttachment, ChatComposerAttachmentPreview } from "./chatComposerAttachment";
import { ChatComposerEditor } from "./chatComposerEditor";
import { handleChatComposerKeyDown } from "./chatComposerKeyboard";
import { ChatComposerPalettes } from "./chatComposerPalettes";
import { commandPrefix, detectCommandTrigger, matchCommands } from "./commandMatch";
import { mergeCommands } from "./curatedCommands";
import { detectFileTrigger, type FileMatch } from "./fileSearch";
import type { ChatDraft } from "./chatSessionTypes";
import { useFileMention } from "./useFileMention";
import { useImageAttachment } from "./useImageAttachment";

interface ChatComposerProps {
  readonly commands: readonly CommandEntry[];
  readonly running: boolean;
  readonly isCompacting: boolean;
  readonly disabled?: boolean;
  readonly retryDraft: (ChatDraft & { readonly version: number }) | null;
  readonly onSubmit: (draft: ChatDraft) => boolean;
  readonly onSteer: (text: string) => void;
  readonly onStop: () => void;
  readonly provider: string;
  readonly cwd: string;
  readonly imageSupported?: boolean;
}

export function ChatComposer({ commands, running, disabled = false, retryDraft, onSubmit, onSteer, onStop, provider, cwd, imageSupported = true }: ChatComposerProps) {
  const { t } = useT();
  const [input, setInput] = useState("");
  const [draftCommand, setDraftCommand] = useState<CommandEntry | null>(null);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const paletteId = useId();
  const paletteListboxId = `${paletteId}-command-listbox`, paletteOptionIdPrefix = `${paletteId}-command-option`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const { pendingImage, setPendingImage, clear: clearImage, pick: pickImage, fileInputRef, isDragOver, dragHandlers } = useImageAttachment();
  const [caret, setCaret] = useState(0);
  const fileId = useId();
  const fileListboxId = `${fileId}-file-listbox`, fileOptionIdPrefix = `${fileId}-file-option`;
  const fileMention = useFileMention(cwd, input, caret);
  const allCommands = useMemo(() => mergeCommands(commands), [commands]);
  const commandTrigger = useMemo(() => detectCommandTrigger(input, caret), [input, caret]);
  const matches = useMemo(() => {
    if (!commandTrigger) return [];
    return matchCommands(
      allCommands.filter((command) => commandPrefix(command) === commandTrigger.prefix),
      commandTrigger.query,
    );
  }, [allCommands, commandTrigger]);
  const paletteOpen = matches.length > 0 && !paletteHidden;
  const fileOpen = !paletteOpen && fileMention.open;
  const selectedIndex = paletteOpen ? Math.min(Math.max(activeIndex, 0), matches.length - 1) : -1;


  useEffect(() => {
    if (!paletteOpen) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((index) => index < 0 ? 0 : Math.min(index, matches.length - 1));
  }, [matches.length, paletteOpen]);

  useEffect(() => {
    if (!retryDraft) return;
    setInput(retryDraft.text);
    setCaret(retryDraft.text.length);
    setPendingImage(retryDraft.image);
    textareaRef.current?.focus();
  }, [retryDraft, setPendingImage]);

  useEffect(() => {
    if (!imageSupported && pendingImage) clearImage();
  }, [imageSupported, pendingImage, clearImage]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.value !== input) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  const selectCommand = (command: CommandEntry): void => {
    const trigger = commandTrigger;
    if (!trigger) return;
    const before = input.slice(0, trigger.start);
    const after = input.slice(caret);
    const invocation = `${commandPrefix(command)}${command.name}`;
    const inserted = /^\s/.test(after) ? invocation : `${invocation} `;
    const at = before.length + inserted.length;
    setInput(before + inserted + after);
    setDraftCommand(command);
    setCaret(at);
    setPaletteHidden(true);
    setActiveIndex(-1);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(at, at);
      }
    });
  };

  const selectFile = (file: FileMatch): void => {
    const trigger = detectFileTrigger(input, caret);
    if (!trigger) return;
    const before = input.slice(0, trigger.start);
    const after = input.slice(caret);
    const focusAfter = (inserted: string): void => {
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        const at = (before + inserted).length;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(at, at);
        }
      });
    };
    // Directory / parent row: navigate by rewriting the @-query (no trailing
    // space, caret right after the slash) and keep the palette open so the hook
    // re-browses the resolved path.
    if (file.isDir || file.isParent) {
      const inserted = `@${file.path.replace(/\/+$/, "")}/`;
      setInput(before + inserted + after);
      setCaret((before + inserted).length);
      focusAfter(inserted);
      return;
    }
    // File: insert the cwd-relative mention and dismiss the palette.
    const inserted = `@${file.path} `;
    setInput(before + inserted + after);
    setCaret((before + inserted).length);
    fileMention.hide();
    setPaletteHidden(false);
    setActiveIndex(-1);
    focusAfter(inserted);
  };

  const resetInput = (): void => {
    setInput("");
    setDraftCommand(null);
    setCaret(0);
    clearImage();
    setPaletteHidden(false);
    setActiveIndex(-1);
    fileMention.reset();
  };

  const submit = (): void => {
    if (disabled || (!input.trim() && !pendingImage)) return;
    const draft: ChatDraft = {
      text: input,
      image: pendingImage,
      ...(draftCommand ? { command: draftCommand } : {}),
    };
    if (!onSubmit(draft)) return;
    resetInput();
  };

  const steer = (): void => {
    const text = input.trim();
    if (!text || disabled) return;
    onSteer(text);
    setInput("");
    setPaletteHidden(false);
    setActiveIndex(-1);
  };

  return (
    <form
      className={`th-chat-input${isDragOver ? " th-chat-input--dragover" : ""}`}
      aria-disabled={disabled || undefined}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ChatComposerAttachmentPreview
        pendingImage={pendingImage}
        removeLabel={t("chat.removeAttach")}
        onClear={clearImage}
      />
      <div className="th-chat-input-inner">
        {isDragOver && <div className="th-chat-drop-hint" role="status">{t("chat.dropImage")}</div>}
        <ChatComposerPalettes
          command={{
            open: paletteOpen, id: paletteListboxId, optionIdPrefix: paletteOptionIdPrefix,
            matches, selectedIndex, onActiveIndex: setActiveIndex, onSelect: selectCommand,
          }}
          file={{
            open: fileOpen, id: fileListboxId, optionIdPrefix: fileOptionIdPrefix,
            mention: fileMention, onSelect: selectFile,
          }}
          labels={{
            pathOutsideRoot: t("chat.pathOutsideRoot"), pathNotFound: t("chat.pathNotFound"),
            noFiles: t("chat.noFiles"), folderEmpty: t("chat.folderEmpty"),
            searchingFiles: t("chat.searchingFiles"), browseCapped: t("chat.browseCapped"),
          }}
        />
        <ChatComposerAttachment
          imageSupported={imageSupported}
          disabled={disabled}
          attachLabel={imageSupported ? t("chat.attach") : t("chat.attachUnsupported")}
          fileInputRef={fileInputRef}
          onPick={pickImage}
        />
        <ChatComposerEditor
          textareaRef={textareaRef}
          label={t("chat.placeholder", { provider })}
          controls={paletteOpen ? paletteListboxId : fileOpen ? fileListboxId : undefined}
          expanded={paletteOpen || fileOpen}
          activeDescendant={paletteOpen && selectedIndex >= 0 ? `${paletteOptionIdPrefix}-${selectedIndex}` : fileOpen && fileMention.activeIndex >= 0 ? `${fileOptionIdPrefix}-${fileMention.activeIndex}` : undefined}
          input={input}
          isCompacting={false}
          disabled={disabled}
          running={running}
          sendLabel={t(running ? "chat.stop" : "chat.send")}
          onCaret={setCaret}
          onInput={(value, at) => {
            setInput(value);
            setDraftCommand(null);
            setCaret(at);
            setPaletteHidden(false);
          }}
          onKeyDown={(event) => handleChatComposerKeyDown(event, {
            file: { open: fileOpen, mention: fileMention, onSelect: selectFile },
            command: {
              open: paletteOpen, matches, selectedIndex, onSelect: selectCommand,
              setActiveIndex, setHidden: setPaletteHidden,
            },
            run: { running, onSteer: steer, onStop, onSubmit: submit },
            isMobile,
          })}
          onStop={onStop}
        />
      </div>
    </form>
  );
}
