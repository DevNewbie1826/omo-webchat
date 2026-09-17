import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from "react";
import { IconArrowUp, IconX } from "../../components/icons";

interface ChatComposerEditorProps {
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly label: string;
  readonly controls: string | undefined;
  readonly expanded: boolean;
  readonly activeDescendant: string | undefined;
  readonly input: string;
  readonly isCompacting: boolean;
  readonly disabled: boolean;
  readonly running: boolean;
  readonly sendLabel: string;
  readonly steerLabel: string;
  /** A run-time steer needs text; an empty draft leaves the action disabled. */
  readonly canSteer: boolean;
  readonly onCaret: (caret: number) => void;
  readonly onInput: (input: string, caret: number) => void;
  readonly onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  readonly onPaste?: ClipboardEventHandler<HTMLTextAreaElement> | undefined;
  readonly onSteer: () => void;
  readonly onStop: () => void;
}

export function ChatComposerEditor({
  textareaRef,
  label,
  controls,
  expanded,
  activeDescendant,
  input,
  isCompacting,
  disabled,
  running,
  sendLabel,
  steerLabel,
  canSteer,
  onCaret,
  onInput,
  onKeyDown,
  onPaste,
  onSteer,
  onStop,
}: ChatComposerEditorProps) {
  return (
    <>
      <textarea
        ref={textareaRef}
        rows={1}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={controls}
        aria-expanded={expanded}
        aria-activedescendant={activeDescendant}
        placeholder={label}
        value={input}
        disabled={isCompacting || disabled}
        onClick={(event) => onCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => {
          if (!event.nativeEvent.isComposing) onCaret(event.currentTarget.selectionStart ?? 0);
        }}
        onChange={(event) => onInput(event.target.value, event.target.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {/* Steering is otherwise keyboard-only (Cmd/Ctrl+Enter), which a soft
          keyboard cannot produce. While a run is in flight the capsule gains
          this action beside — never inside — the fixed send/stop slot, so the
          stop control keeps its position. */}
      {running && (
        <button
          type="button"
          className="th-btn th-chat-steer-btn"
          disabled={disabled || !canSteer}
          title={steerLabel}
          onClick={onSteer}
        >
          <IconArrowUp size={18} />
          <span className="th-chat-send-label">{steerLabel}</span>
        </button>
      )}
      <button
        type={running ? "button" : "submit"}
        className={`th-btn th-chat-send-btn${running ? " th-btn--danger" : ""}`}
        disabled={disabled || (!running && isCompacting)}
        onClick={running ? onStop : undefined}
      >
        {running ? <IconX size={18} /> : <IconArrowUp size={18} />}
        <span className="th-chat-send-label">{sendLabel}</span>
      </button>
    </>
  );
}
