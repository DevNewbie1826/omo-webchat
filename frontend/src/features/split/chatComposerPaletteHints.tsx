interface PaletteHintsProps {
  readonly navigateLabel: string;
  readonly selectLabel: string;
  readonly closeLabel: string;
}

export function PaletteHints({ navigateLabel, selectLabel, closeLabel }: PaletteHintsProps) {
  return (
    <div className="th-chat-slash-hints">
      <span className="th-chat-slash-hint">
        <kbd aria-hidden="true">↑</kbd>
        <kbd aria-hidden="true">↓</kbd>
        <span>{navigateLabel}</span>
      </span>
      <span className="th-chat-slash-hint">
        <kbd aria-hidden="true">↵</kbd>
        <span>{selectLabel}</span>
      </span>
      <span className="th-chat-slash-hint th-chat-slash-hint--end">
        <kbd aria-hidden="true">esc</kbd>
        <span>{closeLabel}</span>
      </span>
    </div>
  );
}
