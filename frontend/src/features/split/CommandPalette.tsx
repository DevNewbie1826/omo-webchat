import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import type { CommandEntry } from "../../lib/chatWs";
import { commandPrefix } from "./commandMatch";
import { COMPACT_DESCRIPTION_I18N_KEY, isCuratedCompact } from "./curatedCommands";

interface CommandPaletteProps {
  readonly id: string;
  readonly optionIdPrefix: string;
  readonly commands: readonly CommandEntry[];
  readonly activeIndex: number;
  readonly onActiveIndex: (index: number) => void;
  readonly onSelect: (command: CommandEntry) => void;
}

export function CommandPalette({
  id,
  optionIdPrefix,
  commands,
  activeIndex,
  onActiveIndex,
  onSelect,
}: CommandPaletteProps) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const { t } = useT();

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="th-chat-slash" id={id} role="listbox">
      {commands.map((command, index) => {
        const active = index === activeIndex;
        // Only the client-owned curated entry is localized; provider
        // descriptions render verbatim.
        const description = isCuratedCompact(command) ? t(COMPACT_DESCRIPTION_I18N_KEY) : command.description;
        return (
          <button
            key={command.name}
            ref={(element) => { optionRefs.current[index] = element; }}
            id={`${optionIdPrefix}-${index}`}
            type="button"
            role="option"
            aria-selected={active}
            onMouseMove={() => onActiveIndex(index)}
            onMouseEnter={() => onActiveIndex(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
          >
            <span aria-hidden="true">{active ? "›" : " "}</span>
            <strong>{commandPrefix(command)}{command.name}</strong>
            {description && <span> — {description}</span>}
            {command.sourceInfo?.path && <span> — {command.sourceInfo.path}</span>}
          </button>
        );
      })}
    </div>
  );
}
