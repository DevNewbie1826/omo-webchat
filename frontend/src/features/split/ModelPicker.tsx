import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent } from "react";
import { useT } from "../../i18n";
import { IconCheck, IconChevron, IconSettings, IconX } from "../../components/icons";
import { MODAL_FOCUSABLE } from "../../components/modalStack";

export interface ModelOption {
  readonly provider: string;
  readonly modelId: string;
  readonly name?: string;
  readonly input?: readonly string[];
}

interface ModelPickerProps {
  readonly compact?: boolean;
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

export function ModelPicker({ compact = false, models, currentModelKey, placeholder, searchPlaceholder, onSelect, thinkingLevels, thinkingLevel, thinkingLabel, onThinkingChange }: ModelPickerProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
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

  const activeIndex = matches.length === 0 ? -1 : Math.max(0, matches.findIndex((model) => keyOf(model) === activeKey));
  const activeModel = matches[activeIndex];
  const resolvedActiveKey = activeModel ? keyOf(activeModel) : null;

  useEffect(() => {
    // Commit the fallback so a removed key cannot become active again on hydration.
    setActiveKey(resolvedActiveKey);
  }, [resolvedActiveKey, activeKey]);

  useEffect(() => {
    if (!open) return;
    if (compact) popoverRef.current?.focus();
    else searchRef.current?.focus();
  }, [open, compact]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, resolvedActiveKey, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current && !rootRef.current.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = (): void => { setOpen(false); triggerRef.current?.focus(); };

  const select = (model: ModelOption): void => {
    onSelect(keyOf(model));
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (compact && event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE));
      const index = controls.findIndex((control) => control === document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? controls.length - 1 : index - 1)
        : (index + 1) % controls.length;
      controls[next]?.focus();
      return;
    }
    if (event.target !== searchRef.current && event.target !== popoverRef.current) return;
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveKey(keyOf(matches[(activeIndex + 1) % matches.length]!));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveKey(keyOf(matches[activeIndex <= 0 ? matches.length - 1 : activeIndex - 1]!));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = matches[activeIndex] ?? matches[0];
      if (model) select(model);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const buttonLabel = current ? labelOf(current) : placeholder;

  const popover = (
    <div ref={popoverRef} tabIndex={-1} onKeyDown={onKeyDown}
      role={compact ? "dialog" : undefined} aria-label={compact ? buttonLabel : undefined}
      className={`th-model-picker-popover${compact ? " th-model-picker-popover--sheet" : ""}`}>
      <div className="th-model-picker-current">
        <div><strong>{buttonLabel}</strong><span>{current?.provider ?? currentModelKey}</span></div>
        {compact && <button type="button" className="th-btn-icon" aria-label={t("common.close")} onClick={close}><IconX size={16} /></button>}
      </div>
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
                onMouseDown={compact ? undefined : (event) => event.preventDefault()}
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
          setActiveKey(null);
        }}
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
              aria-selected={keyOf(model) === currentModelKey}
              data-active={active || undefined}
              onMouseMove={() => setActiveKey(keyOf(model))}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(model)}
            >
              <strong>{labelOf(model)}{keyOf(model) === currentModelKey && <IconCheck size={14} />}</strong>
              <span>{model.provider}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="th-model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="th-model-picker-btn"
        aria-haspopup={compact ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => {
          if (!open) {
            setQuery("");
            setActiveKey(currentModelKey);
          }
          setOpen((value) => !value);
        }}
      >
        <span className="th-model-picker-icon" aria-hidden="true">
          <IconSettings size={14} />
        </span>
        <span className="th-model-picker-label">{buttonLabel}</span>
        {compact && thinkingLevel && <span className="th-model-picker-thinking">{thinkingLevel}</span>}
        <IconChevron size={14} />
      </button>
      {open && (compact ? createPortal(popover, document.body) : popover)}
    </div>
  );
}
