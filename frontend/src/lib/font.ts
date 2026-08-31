export type FontId = "system" | "nanum" | "jetbrains" | "fira" | "ibmplex" | "sourcecode";

export interface FontPreset {
  readonly id: FontId;
  readonly labelKey: string;
  /** CSS font-family stack. Korean glyphs fall through to a CJK monospace face. */
  readonly stack: string;
}

/** Locally installed Korean coding faces, ordered by availability across platforms. */
const KOREAN_MONO = '"Nanum Gothic Coding", D2Coding, "Noto Sans Mono CJK KR", "Noto Sans Mono KR"';
/** Trailing local Korean faces + generic monospace for any remaining glyphs. */
const KOREAN_SANS_TAIL = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", monospace';

export const SYSTEM_FONT_STACK = `ui-monospace, "SF Mono", "Cascadia Mono", "Cascadia Code", Menlo, Consolas, "Liberation Mono", ${KOREAN_MONO}, ${KOREAN_SANS_TAIL}`;

export const FONT_PRESETS: readonly FontPreset[] = [
  {
    id: "system",
    labelKey: "font.system",
    stack: SYSTEM_FONT_STACK,
  },
  {
    id: "nanum",
    labelKey: "font.nanum",
    stack: `${KOREAN_MONO}, ${KOREAN_SANS_TAIL}`,
  },
  {
    id: "jetbrains",
    labelKey: "font.jetbrains",
    stack: `"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, ${KOREAN_MONO}, ${KOREAN_SANS_TAIL}`,
  },
  {
    id: "fira",
    labelKey: "font.fira",
    stack: `"Fira Code", "Cascadia Code", "SF Mono", Menlo, Consolas, ${KOREAN_MONO}, ${KOREAN_SANS_TAIL}`,
  },
  {
    id: "ibmplex",
    labelKey: "font.ibmplex",
    stack: `"IBM Plex Mono", "Liberation Mono", "Nimbus Mono PS", "Courier New", ${KOREAN_MONO}, ${KOREAN_SANS_TAIL}`,
  },
  {
    id: "sourcecode",
    labelKey: "font.sourcecode",
    stack: `"Source Code Pro", "DejaVu Sans Mono", "Liberation Mono", "SF Mono", Menlo, Consolas, ${KOREAN_MONO}, ${KOREAN_SANS_TAIL}`,
  },
];

const STORAGE_KEY = "th-font";

export function detectFont(): FontId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const match = FONT_PRESETS.find((p) => p.id === stored);
    return match ? match.id : "system";
  } catch {
    return "system";
  }
}

export function persistFont(id: FontId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private modes may throw; the choice simply will not persist.
  }
}

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 13;

const SIZE_STORAGE_KEY = "th-font-size";

export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
}

export function detectFontSize(): number {
  try {
    const raw = window.localStorage.getItem(SIZE_STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampFontSize(parsed) : FONT_SIZE_DEFAULT;
  } catch {
    return FONT_SIZE_DEFAULT;
  }
}

export function persistFontSize(size: number): void {
  try {
    window.localStorage.setItem(SIZE_STORAGE_KEY, String(clampFontSize(size)));
  } catch {
    // Private modes may throw; the choice simply will not persist.
  }
}
