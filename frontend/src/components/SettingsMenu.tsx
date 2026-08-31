import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useTheme } from "../app-config";
import { IconActivity, IconSettings } from "./icons";
import { FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../lib/font";
import { THEME_OPTIONS } from "../lib/theme";

export interface SettingsMenuProps {
  readonly onOpenStats: () => void;
}

export function SettingsMenu({ onOpenStats }: SettingsMenuProps) {
  const { t, lang, setLang, font, setFont, fontSize, setFontSize } = useT();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (ev: PointerEvent): void => {
      const target = ev.target;
      if (target instanceof Node && settingsRef.current && !settingsRef.current.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  return (
    <div className="th-settings-menu" ref={settingsRef}>
      <button
        type="button"
        className={`th-btn-icon${settingsOpen ? " th-btn-icon--on" : ""}`}
        title={t("settings.title")}
        aria-label={t("settings.title")}
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((v) => !v)}
      >
        <IconSettings size={15} />
      </button>
      {settingsOpen && (
        <div className="th-settings-panel" role="region" aria-label={t("settings.title")}>
          <div className="th-settings-section">
            <span className="th-settings-label">{t("settings.language")}</span>
            <div className="th-settings-seg" role="radiogroup" aria-label={t("settings.language")}>
              {(["en", "ko"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  role="radio"
                  aria-checked={lang === code}
                  className={`th-settings-seg-btn${lang === code ? " th-settings-seg-btn--on" : ""}`}
                  onClick={() => setLang(code)}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="th-settings-section">
            <span className="th-settings-label">{t("settings.theme")}</span>
            <div className="th-settings-seg" role="radiogroup" aria-label={t("settings.theme")}>
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.id}
                  className={`th-settings-seg-btn${theme === option.id ? " th-settings-seg-btn--on" : ""}`}
                  onClick={() => setTheme(option.id)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="th-settings-section">
            <span className="th-settings-label">{t("settings.font")}</span>
            <select
              className="th-settings-select"
              value={font}
              aria-label={t("settings.font")}
              onChange={(ev) => {
                const preset = FONT_PRESETS.find((p) => p.id === ev.target.value);
                if (preset) setFont(preset.id);
              }}
            >
              {FONT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(p.labelKey)}
                </option>
              ))}
            </select>
          </div>

          <div className="th-settings-section">
            <span className="th-settings-label">{t("settings.fontSize")}</span>
            <div className="th-settings-size">
              <button
                type="button"
                className="th-settings-size-btn"
                aria-label={t("settings.fontSizeDecrease")}
                disabled={fontSize <= FONT_SIZE_MIN}
                onClick={() => setFontSize(fontSize - 1)}
              >
                −
              </button>
              <span className="th-settings-size-value">{fontSize}px</span>
              <button
                type="button"
                className="th-settings-size-btn"
                aria-label={t("settings.fontSizeIncrease")}
                disabled={fontSize >= FONT_SIZE_MAX}
                onClick={() => setFontSize(fontSize + 1)}
              >
                +
              </button>
            </div>
          </div>

          <div className="th-settings-divider" />

          <button
            type="button"
            className="th-settings-item"
            onClick={() => {
              setSettingsOpen(false);
              onOpenStats();
            }}
          >
            <IconActivity size={14} />
            <span>{t("settings.systemStats")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
