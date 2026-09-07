import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

function revealInList(list: HTMLElement, option: HTMLElement): void {
  // Never scroll popup chrome or hidden pane/transcript ancestors.
  const top = list.getBoundingClientRect().top + list.clientTop;
  const rect = option.getBoundingClientRect();
  if (rect.top < top) list.scrollTop += rect.top - top;
  else if (rect.bottom > top + list.clientHeight) {
    list.scrollTop += Math.min(rect.top - top, rect.bottom - top - list.clientHeight);
  }
}

export function ModelPicker({ compact = false, models, currentModelKey, placeholder, searchPlaceholder, onSelect, thinkingLevels, thinkingLevel, thinkingLabel, onThinkingChange }: ModelPickerProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const navigationKey = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const normalMinimum = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionIdPrefix = `${reactId}-option`;

  const current = models.find((model) => keyOf(model) === currentModelKey);
  const [fitMaxHeight, setFitMaxHeight] = useState<number | null>(null);
  const [panel, setPanel] = useState(false);
  const [dense, setDense] = useState(false);
  const portalled = compact || panel;
  useLayoutEffect(() => {
    if (compact || !open || typeof ResizeObserver === "undefined") return;
    const picker = rootRef.current;
    const popup = popoverRef.current;
    const column = picker?.closest<HTMLElement>(".th-chat-main");
    if (!picker || !popup) return;
    const measure = (): void => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const above = picker.getBoundingClientRect().top - (column?.getBoundingClientRect().top ?? 0) - 4;
      const bound = Math.max(0, Math.floor(Math.min(280, viewportHeight / 2, above)));
      // Measure nonshrinking chrome and a natural option, not the already
      // squeezed list. Keep the normal requirement while dense controls render.
      if (!dense) {
        const chrome = Array.from(popup.children).filter(child => child !== listRef.current)
          .reduce((height, child) => height + child.getBoundingClientRect().height, 0);
        const row = optionRefs.current[0]?.getBoundingClientRect().height ?? 44;
        normalMinimum.current = chrome + row + 10;
      }
      const needsPanel = bound < normalMinimum.current;
      const needsDense = needsPanel && viewportHeight - 8 < normalMinimum.current;
      if (panel !== needsPanel || dense !== needsDense) {
        const focused = document.activeElement;
        pendingFocus.current = focused === searchRef.current ? "search"
          : focused instanceof HTMLElement && focused.matches(".th-thinking-level, .th-thinking-in-picker select")
            ? `thinking:${focused instanceof HTMLSelectElement ? focused.value : focused.textContent}` : null;
      }
      setFitMaxHeight(bound);
      setPanel(needsPanel);
      setDense(needsDense);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (column) observer.observe(column);
    observer.observe(picker);
    for (const child of popup.children) if (child !== listRef.current) observer.observe(child);
    window.visualViewport?.addEventListener("resize", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", measure);
      window.removeEventListener("resize", measure);
    };
  }, [compact, open, panel, dense, models, thinkingLevels]);
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

  // A no-op key update cannot leave intent for a later passive reconciliation.
  const navigate = (key: string): void => { navigationKey.current = key === resolvedActiveKey ? null : key; setActiveKey(key); };

  useEffect(() => {
    // Commit the fallback so a removed key cannot become active again on hydration.
    setActiveKey(resolvedActiveKey);
  }, [resolvedActiveKey, activeKey]);

  useEffect(() => {
    if (!open) return;
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    const target = focus === "search" ? searchRef.current
      : focus?.startsWith("thinking:") ? popoverRef.current?.querySelector<HTMLSelectElement>("select")
        ?? Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>(".th-thinking-level") ?? []).find(button => button.textContent === focus.slice(9))
        : popoverRef.current;
    target?.focus({ preventScroll: true });
  }, [open, compact, panel, dense]);

  useLayoutEffect(() => {
    const deliberateNavigation = navigationKey.current === resolvedActiveKey && resolvedActiveKey !== null;
    navigationKey.current = null;
    const option = optionRefs.current[activeIndex];
    if (!open) return;
    if (compact) option?.scrollIntoView?.({ block: "nearest" });
    else if (listRef.current && option && (deliberateNavigation || !popoverRef.current?.querySelector(".th-thinking-level:focus, select:focus"))) {
      revealInList(listRef.current, option);
    }
  }, [activeIndex, resolvedActiveKey, open, compact, fitMaxHeight, panel, dense]);

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
    if (portalled && event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE))
        .filter(control => control.tabIndex >= 0);
      const index = controls.findIndex((control) => control === document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? controls.length - 1 : index - 1)
        : (index + 1) % controls.length;
      controls[next]?.focus({ preventScroll: !compact });
      return;
    }
    if (event.key === "Tab") {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE))
        .filter(control => control.tabIndex >= 0);
      const index = controls.findIndex(control => control === document.activeElement);
      const next = controls[index + (event.shiftKey ? -1 : 1)];
      if (next) {
        event.preventDefault();
        next.focus({ preventScroll: true });
      } else {
        // Reverse returns to the trigger; forward continues natively into the
        // composer from that same trigger, without walking a long catalog.
        if (event.shiftKey) event.preventDefault();
        close();
      }
      return;
    }
    if (event.target !== searchRef.current && event.target !== popoverRef.current) return;
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navigate(keyOf(matches[(activeIndex + 1) % matches.length]!));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      navigate(keyOf(matches[activeIndex <= 0 ? matches.length - 1 : activeIndex - 1]!));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = matches[activeIndex] ?? matches[0];
      if (model) select(model);
    }
  };

  const buttonLabel = current ? labelOf(current) : currentModelKey || placeholder;
  const triggerLabel = thinkingLevel ? `${buttonLabel}, ${thinkingLevel}` : buttonLabel;
  const thinking = thinkingLevels && onThinkingChange ? (
    <div className="th-thinking-in-picker" role="group" aria-label={thinkingLabel}>
      <span className="th-thinking-in-picker-label">{thinkingLabel}</span>
      {dense && !compact ? <select aria-label={thinkingLabel} value={thinkingLevel ?? ""}
        onChange={event => onThinkingChange(event.target.value)}>
        {!thinkingLevel && <option value="" disabled>{thinkingLabel}</option>}
        {thinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}
      </select> : <div className="th-thinking-in-picker-levels">
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
      </div>}
    </div>
  ) : null;

  const popover = (
    <div ref={popoverRef} tabIndex={-1} onKeyDown={onKeyDown}
      role={portalled ? "dialog" : undefined} aria-label={portalled ? buttonLabel : undefined}
      style={!portalled && fitMaxHeight !== null ? { maxHeight: `${fitMaxHeight}px` } : undefined}
      className={`th-model-picker-popover${compact ? " th-model-picker-popover--sheet" : panel ? ` th-model-picker-popover--panel${dense ? " th-model-picker-popover--dense" : ""}` : ""}`}>
      <div className="th-model-picker-current">
        <div><strong>{buttonLabel}</strong><span>{current?.provider ?? currentModelKey}</span></div>
        {portalled && <button type="button" className="th-btn-icon" aria-label={t("common.close")} onClick={close}><IconX size={16} /></button>}
      </div>
      {thinking}
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
          navigationKey.current = null;
          setQuery(event.target.value);
          setActiveKey(null);
        }}
      />
      <div ref={listRef} className="th-model-picker-list" id={listboxId} role="listbox">
        {matches.map((model, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={keyOf(model)}
              ref={(element) => { optionRefs.current[index] = element; }}
              id={`${optionIdPrefix}-${index}`}
              type="button"
              role="option"
              tabIndex={compact ? 0 : -1}
              aria-selected={keyOf(model) === currentModelKey}
              data-active={active || undefined}
              onMouseMove={() => navigate(keyOf(model))}
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
        aria-haspopup={portalled ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
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
        {thinkingLevel && <span className="th-model-picker-thinking">{thinkingLevel}</span>}
        <IconChevron size={14} />
      </button>
      {open && (portalled ? createPortal(popover, document.body) : popover)}
    </div>
  );
}
