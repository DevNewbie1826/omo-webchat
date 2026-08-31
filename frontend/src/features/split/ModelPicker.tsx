import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { IconChevron, IconSettings } from "../../components/icons";

export interface ModelOption {
  readonly provider: string;
  readonly modelId: string;
  readonly name?: string;
  readonly input?: readonly string[];
}

interface ModelPickerProps {
  readonly models: readonly ModelOption[];
  readonly currentModelKey: string;
  readonly placeholder: string;
  readonly searchPlaceholder: string;
  readonly onSelect: (value: string) => void;
  readonly thinkingLevels?: readonly string[];
  readonly thinkingLevel?: string;
  readonly thinkingLabel?: string;
  readonly onThinkingChange?: (level: string) => void;
}

const keyOf = (model: ModelOption): string => `${model.provider}/${model.modelId}`;
const labelOf = (model: ModelOption): string => model.name || model.modelId;

export function ModelPicker({ models, currentModelKey, placeholder, searchPlaceholder, onSelect, thinkingLevels, thinkingLevel, thinkingLabel, onThinkingChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionIdPrefix = `${reactId}-option`;

  const current = models.find((model) => keyOf(model) === currentModelKey);
  const matches = useMemo(() => {
    if (query === "") return models;
    const needle = query.toLowerCase();
    return models.filter(
      (model) => labelOf(model).toLowerCase().includes(needle) || model.provider.toLowerCase().includes(needle),
    );
  }, [models, query]);

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }
    setQuery("");
    setActiveIndex(models.length > 0 ? 0 : -1);
    searchRef.current?.focus();
  }, [open, models.length]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const select = (model: ModelOption): void => {
    onSelect(keyOf(model));
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (matches.length === 0) {
      if (event.key === "Escape") setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index < 0 ? 0 : (index + 1) % matches.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? matches.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = matches[activeIndex] ?? matches[0];
      if (model) select(model);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  const buttonLabel = current ? labelOf(current) : placeholder;

  return (
    <div className="th-model-picker" ref={rootRef}>
      <button
        type="button"
        className="th-model-picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="th-model-picker-icon" aria-hidden="true">
          <IconSettings size={14} />
        </span>
        <span className="th-model-picker-label">{buttonLabel}</span>
        <IconChevron size={14} />
      </button>
      {open && (
        <div className="th-model-picker-popover">
          {thinkingLevels && onThinkingChange ? (
            <div className="th-thinking-in-picker" role="group" aria-label={thinkingLabel}>
              <span className="th-thinking-in-picker-label">{thinkingLabel}</span>
              <div className="th-thinking-in-picker-levels">
                {thinkingLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`th-thinking-level${level === thinkingLevel ? " th-thinking-level--active" : ""}`}
                    aria-pressed={level === thinkingLevel}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onThinkingChange(level)}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <input
            ref={searchRef}
            className="th-model-picker-search"
            type="text"
            role="combobox"
            aria-controls={listboxId}
            aria-expanded={matches.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="th-model-picker-list" id={listboxId} role="listbox">
            {matches.map((model, index) => {
              const active = index === activeIndex;
              return (
                <button
                  key={keyOf(model)}
                  ref={(element) => { optionRefs.current[index] = element; }}
                  id={`${optionIdPrefix}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseMove={() => setActiveIndex(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(model)}
                >
                  <strong>{labelOf(model)}</strong>
                  <span>{model.provider}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
