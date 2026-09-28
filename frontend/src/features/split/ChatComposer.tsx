import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandEntry } from "../../lib/chatWs";
import { useT } from "../../i18n";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { ChatComposerAttachment, ChatComposerAttachmentPreview } from "./chatComposerAttachment";
import { ChatComposerEditor } from "./chatComposerEditor";
import { TOUCH_QUERY, handleChatComposerKeyDown } from "./chatComposerKeyboard";
import { ChatComposerPalettes } from "./chatComposerPalettes";
import { commandPrefix, detectCommandTrigger, matchCommands } from "./commandMatch";
import { mergeCommands } from "./curatedCommands";
import { detectFileTrigger, type FileMatch } from "./fileSearch";
import type { ChatDraft, RecoveredChatDraft } from "./chatSessionTypes";
import { useFileMention } from "./useFileMention";
import { useImageAttachment } from "./useImageAttachment";
import { useSessionDraft } from "./sessionDraft";
import type { ChatSessionRef } from "../workspace/workspace";
import type { QuestionEndedSignal } from "./useChatFrameState";

/** The shown pending question the composer can answer (omo's
 *  composerDestination = {kind:"answer"}): typing into the empty focused
 *  composer enters reply mode, Enter/the send button send the text as the
 *  question's comment answer, and Alt+Enter or the toggle send a normal
 *  message. */
export interface ComposerQuestionTarget {
  /** Stable request identity, independent of a re-issued wire id. */
  readonly key: string;
  /** The question's CURRENT wire id (re-issued ids keep the reply). */
  readonly id: string;
  /** First question's header for the reply label. */
  readonly header: string;
  /** A collapsed blocking window forces reply mode (IS-3). */
  readonly forceReply: boolean;
  /** Option labels of the first unanswered question (1-9 shortcut). */
  readonly options: readonly string[];
  readonly onAnswer: (comment: string) => boolean;
  readonly onProgress: (comment: string) => void;
  readonly onCancelProgress: () => void;
  readonly onPickOption: (optionIndex: number) => void;
}

interface ChatComposerProps {
  readonly session?: Pick<ChatSessionRef, "wsId" | "id">;
  readonly commands: readonly CommandEntry[];
  readonly running: boolean;
  /** A blocking (waitForAnswer) question is pending: no Stop in the send
   *  slot, Esc never aborts, and the steer control sends as a message. */
  readonly blockingQuestion?: boolean;
  readonly questionTarget?: ComposerQuestionTarget | null;
  /** Fires when a question leaves the pending list (any outcome, any pane). */
  readonly questionEndedSignal?: QuestionEndedSignal | null;
  readonly isCompacting: boolean;
  readonly disabled?: boolean;
  readonly retryDraft: RecoveredChatDraft | null;
  readonly onSubmit: (draft: ChatDraft) => boolean;
  readonly onSteer: (text: string, command: CommandEntry | null) => boolean;
  readonly onStop: () => void;
  readonly onNewChat?: () => void;
  readonly provider: string;
  readonly cwd: string;
  readonly imageSupported?: boolean;
}

export function ChatComposer({ session, commands, running, blockingQuestion = false, questionTarget = null, questionEndedSignal = null, disabled = false, retryDraft, onSubmit, onSteer, onStop, onNewChat, provider, cwd, imageSupported = true }: ChatComposerProps) {
  const { t } = useT();
  const { input, setInput, draftCommand, setDraftCommand, pendingImage, setPendingImage, restoreDraft } = useSessionDraft(session);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const paletteId = useId();
  const paletteListboxId = `${paletteId}-command-listbox`, paletteOptionIdPrefix = `${paletteId}-command-option`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isTouch = useMediaQuery(TOUCH_QUERY);
  const { clear: clearImage, pick: pickImage, fileInputRef, isDragOver, dragHandlers, onPaste } = useImageAttachment(pendingImage, setPendingImage);
  const [caret, setCaret] = useState(0);
  // Reply mode (omo setComposerReply): entered by typing a printable first
  // char (not `/`/`!`) into the empty focused composer while a question is
  // shown; the toggle switches the destination between the question's
  // comment answer and a normal chat message.
  const [replyMode, setReplyMode] = useState(false);
  const [sendAsMessage, setSendAsMessage] = useState(false);
  const [endedNotice, setEndedNotice] = useState(false);
  const [replySuspended, setReplySuspended] = useState(false);
  const inputRef = useRef(input);
  inputRef.current = input;
  // Keep the destination selected when reply mode began, not the next
  // question the pane chooses to display after this one ends or cycles.
  const replyTargetRef = useRef<ComposerQuestionTarget | null>(null);
  useEffect(() => {
    if (questionTarget && (replyMode || questionTarget.forceReply)) {
      if (replyTargetRef.current === null || replyTargetRef.current.key === questionTarget.key) {
        replyTargetRef.current = questionTarget;
      }
    }
  }, [questionTarget, replyMode]);
  const fileId = useId();
  const fileListboxId = `${fileId}-file-listbox`, fileOptionIdPrefix = `${fileId}-file-option`;
  const fileMention = useFileMention(cwd, input, caret);
  const allCommands = useMemo(() => mergeCommands(commands, onNewChat !== undefined), [commands, onNewChat]);
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
    if (!retryDraft || (!retryDraft.explicit && (input !== "" || pendingImage !== null || draftCommand !== null))) return;
    restoreDraft(retryDraft);
    setCaret(retryDraft.text.length);
    textareaRef.current?.focus();
  }, [retryDraft, restoreDraft]);

  useEffect(() => {
    if (!imageSupported && pendingImage) clearImage();
  }, [imageSupported, pendingImage, clearImage]);

  // omo finish(): when the question the composer targets ends (any outcome,
  // any pane), leave reply mode; a remaining draft is kept and flagged.
  const lastEndedSeqRef = useRef(0);
  useEffect(() => {
    if (!questionEndedSignal || questionEndedSignal.seq === lastEndedSeqRef.current) return;
    lastEndedSeqRef.current = questionEndedSignal.seq;
    if (!questionEndedSignal.ended.some(question => question.key === replyTargetRef.current?.key)) return;
    replyTargetRef.current = null;
    setReplyMode(false);
    setSendAsMessage(false);
    setReplySuspended(inputRef.current !== "");
    if (inputRef.current !== "") setEndedNotice(true);
  }, [questionEndedSignal]);

  const replyTarget = replySuspended ? null : replyTargetRef.current ?? questionTarget;
  const replyActive = replyTarget !== null && (replyMode || replyTarget.forceReply) && !sendAsMessage;
  const stopSuppressed = blockingQuestion || (replyTarget !== null && (replyMode || replyTarget.forceReply));

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

  const submit = (forceMessage = false): void => {
    if (disabled || (!input.trim() && !pendingImage)) return;
    // Reply mode (omo submitAsyncQuestionComment): Enter and the send button
    // answer the shown question with the text as its comment. Text starting
    // with `/` or `!` and an attached image never route to the answer.
    if (!forceMessage && replyTarget && replyActive && pendingImage === null && !/^[/!]/.test(input.trimStart())) {
      if (replyTarget.onAnswer(input.trim())) {
        resetInput();
        replyTargetRef.current = null;
        setReplySuspended(false);
        setReplyMode(false);
        setSendAsMessage(false);
        setEndedNotice(false);
      }
      return;
    }
    // Only the exact invocation is local. Arguments and embedded mentions keep
    // their existing provider semantics; never send the local action as a prompt.
    if (input.trim() === "/new") {
      onNewChat?.();
      if (onNewChat) resetInput();
      return;
    }
    const draft: ChatDraft = {
      text: input,
      image: pendingImage,
      ...(draftCommand ? { command: draftCommand } : {}),
    };
    if (!onSubmit(draft)) return;
    if (replyTarget) replyTarget.onCancelProgress();
    resetInput();
    setReplySuspended(false);
  };

  const steer = (): void => {
    const text = input.trim();
    if (!text || disabled) return;
    if (text === "/new") {
      submit();
      return;
    }
    if (!onSteer(input, draftCommand)) return;
    setInput("");
    setDraftCommand(null);
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
      <div className="th-chat-input-inner">
        {/* The pending-image chip lives in the capsule's top context strip:
        its own row above the input row (the capsule wraps), per DESIGN.md
        "Attachments open through the icon-only plus action … a thumbnail
        chip in its own row above the input row, inside the capsule". */}
        <ChatComposerAttachmentPreview
          pendingImage={pendingImage}
          removeLabel={t("chat.removeAttach")}
          onClear={clearImage}
        />
        {isDragOver && <div className="th-chat-drop-hint" role="status">{t("chat.dropImage")}</div>}
        {replyTarget && (replyMode || replyTarget.forceReply) && (
          <div className="th-chat-reply-label">
            <span className="th-chat-reply-label-text">
              {"↳ "}{t("question.reply.label", { header: replyTarget.header })}
            </span>
            {!replyTarget.forceReply && (
              <button
                type="button"
                className="th-btn th-btn--ghost th-chat-reply-toggle"
                onClick={() => {
                  if (!sendAsMessage) replyTarget.onCancelProgress();
                  setSendAsMessage((value) => !value);
                }}
              >
                {t(sendAsMessage ? "question.reply.backToAnswer" : "question.reply.sendAsMessage")}
              </button>
            )}
          </div>
        )}
        {endedNotice && (
          <div className="th-chat-reply-ended" role="status">{t("question.noLongerPending")}</div>
        )}
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
            hintNavigate: t("chat.composer.paletteHintNavigate"),
            hintSelect: t("chat.composer.paletteHintSelect"),
            hintClose: t("chat.composer.paletteHintClose"),
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
          stopSuppressed={stopSuppressed}
          steerVisible={blockingQuestion}
          steerVariant={blockingQuestion ? "message" : "steer"}
          sendLabel={t(running && !stopSuppressed ? "chat.stop" : "chat.send")}
          steerLabel={t(blockingQuestion ? "question.reply.sendAsMessage" : "chat.steer")}
          canSteer={input.trim().length > 0}
          onCaret={setCaret}
          onInput={(value, at) => {
            // omo handleAskUserShortcut: a printable first char (never `/` or
            // `!`) typed into the EMPTY composer routes it to the question.
            if (questionTarget && !replySuspended && input === "" && value !== "" && !/^[/!]/.test(value)) {
              replyTargetRef.current = questionTarget;
              setReplyMode(true);
              setSendAsMessage(false);
            }
            if (value === "") setReplySuspended(false);
            if (value !== input) setEndedNotice(false);
            if (replyActive && replyTarget && !sendAsMessage && value !== input) replyTarget.onProgress(value);
            else if (questionTarget && !replySuspended && input === "" && value !== "" && !/^[/!]/.test(value)) questionTarget.onProgress(value);
            setInput(value);
            setDraftCommand(null);
            setCaret(at);
            setPaletteHidden(false);
          }}
          onPaste={imageSupported && !disabled ? onPaste : undefined}
          onSteer={steer}
          onKeyDown={(event) => handleChatComposerKeyDown(event, {
            file: { open: fileOpen, mention: fileMention, onSelect: selectFile },
            command: {
              open: paletteOpen, matches, selectedIndex, onSelect: selectCommand,
              setActiveIndex, setHidden: setPaletteHidden,
            },
            run: {
              running,
              blockingQuestion: stopSuppressed,
              onSteer: steer,
              onStop,
              onSubmit: () => submit(),
              onSubmitMessage: () => submit(true),
            },
            ...(questionTarget ? {
              question: {
                inputEmpty: input === "",
                options: questionTarget.options,
                onPickOption: questionTarget.onPickOption,
              },
            } : {}),
            isTouch,
          })}
          onStop={onStop}
        />
      </div>
    </form>
  );
}
