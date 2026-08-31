import type { KeyboardEventHandler, RefObject } from "react";
import { IconArrowUp, IconX } from "../../components/icons";

interface ChatComposerEditorProps {
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly label: string;
  readonly controls: string | undefined;
  readonly expanded: boolean;
  readonly activeDescendant: string | undefined;
  readonly input: string;
  readonly isCompacting: boolean;
  readonly running: boolean;
  readonly sendLabel: string;
  readonly onCaret: (caret: number) => void;
  readonly onInput: (input: string, caret: number) => void;
  readonly onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
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
  running,
  sendLabel,
  onCaret,
  onInput,
  onKeyDown,
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
        disabled={isCompacting}
        onClick={(event) => onCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => {
          if (!event.nativeEvent.isComposing) onCaret(event.currentTarget.selectionStart ?? 0);
        }}
        onChange={(event) => onInput(event.target.value, event.target.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      <button
        type={running ? "button" : "submit"}
        className={`th-btn th-chat-send-btn${running ? " th-btn--danger" : ""}`}
        disabled={!running && isCompacting}
        onClick={running ? onStop : undefined}
      >
        {running ? <IconX size={18} /> : <IconArrowUp size={18} />}
        <span className="th-chat-send-label">{sendLabel}</span>
      </button>
    </>
  );
}
