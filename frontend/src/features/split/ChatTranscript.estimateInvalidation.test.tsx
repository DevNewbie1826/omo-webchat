import { act, useEffect, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { I18nContext } from "../../i18n";
import { FONT_PRESETS, SYSTEM_FONT_STACK, type FontId } from "../../lib/font";
import { ChatTranscript } from "./ChatTranscript";
import { estimateRowHeight, readRowMetrics, type RowMetrics } from "./chatRowEstimate";
import type { TranscriptItem } from "./useChatFrameState";

const { observed, scaleForAppliedStyles } = vi.hoisted(() => {
  const observed: { current?: Virtualizer<Element, Element> } = {};
  Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
  function scaleForAppliedStyles(base: RowMetrics): RowMetrics {
    const size = Number.parseFloat(document.documentElement.style.getPropertyValue("--th-font-size"));
    const family = document.documentElement.style.getPropertyValue("--th-font-mono");
    const sizeFactor = Number.isFinite(size) && size > 0 ? size / 13 : 1;
    const familyFactor = family.includes("JetBrains") ? 1.2 : 1;
    const factor = sizeFactor * familyFactor;
    if (factor === 1) return base;
    return {
      laneWidth: base.laneWidth,
      bodyLineHeight: base.bodyLineHeight * factor,
      secondaryLineHeight: base.secondaryLineHeight * factor,
      charWidth: base.charWidth * factor,
      monoCharWidth: base.monoCharWidth * factor,
    };
  }
  return { observed, scaleForAppliedStyles };
});

vi.mock("./chatRowEstimate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatRowEstimate")>();
  return {
    ...actual,
    readRowMetrics: (scrollElement: HTMLElement | null) =>
      scaleForAppliedStyles(actual.readRowMetrics(scrollElement)),
  };
});
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
      const instance = actual.useVirtualizer(...args);
      observed.current = instance;
      return instance;
    },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const BODY = "Assistant output wraps across the message lane and must not use a constant height. ".repeat(8);
const ROW_COUNT = 30;
const UNMEASURED = 22;

function textItem(id: string, text = BODY): TranscriptItem {
  return {
    kind: "message",
    message: { id, role: "assistant", blocks: [{ kind: "text", text }] },
  };
}

function withImage(item: TranscriptItem): TranscriptItem {
  if (item.kind !== "message") throw new Error("expected message item");
  return {
    kind: "message",
    message: {
      ...item.message,
      blocks: [
        ...(item.message.blocks ?? []),
        { kind: "image", data: "QUJD", mimeType: "image/png", byteLength: 3 },
      ],
    },
  };
}

function makeItems(): TranscriptItem[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => textItem(`row-${index}`));
}

function FontSettings({
  fontSize,
  font,
  children,
}: {
  fontSize: number;
  font: FontId;
  children: ReactNode;
}): ReactNode {
  const value = useMemo(
    () => ({
      lang: "en" as const,
      setLang: () => undefined,
      font,
      setFont: () => undefined,
      fontSize,
      setFontSize: () => undefined,
      t: (key: string) => key,
    }),
    [font, fontSize],
  );
  // Same timing as useAppConfig: CSS vars are written in an effect, after
  // descendants have already rendered.
  useEffect(() => {
    const preset = FONT_PRESETS.find((candidate) => candidate.id === font);
    const stack = preset ? preset.stack : SYSTEM_FONT_STACK;
    document.documentElement.style.setProperty("--th-font-mono", stack);
    document.documentElement.style.setProperty("--th-font-size", `${fontSize}px`);
  }, [font, fontSize]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function transcript(items: readonly TranscriptItem[]): ReactNode {
  return (
    <ChatTranscript
      items={items}
      streaming=""
      thinking=""
      toolCalls={{}}
      doneReason={null}
      error=""
      restoreVersion={0}
      focused={false}
      historyLoaded
    />
  );
}

async function commit(
  root: ReturnType<typeof createRoot>,
  items: readonly TranscriptItem[],
  fontSize: number,
  font: FontId,
): Promise<void> {
  await act(async () => {
    root.render(
      <FontSettings fontSize={fontSize} font={font}>
        {transcript(items)}
      </FontSettings>,
    );
    await Promise.resolve();
  });
}

afterEach(() => {
  document.documentElement.style.removeProperty("--th-font-mono");
  document.documentElement.style.removeProperty("--th-font-size");
  delete observed.current;
});

it("updates an unmeasured row estimate when font size or family changes, without unrelated input", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const items = makeItems();
  try {
    await commit(root, items, 13, "system");
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");
    const atDefault = instance.options.estimateSize(UNMEASURED);
    const totalDefault = instance.getTotalSize();

    await commit(root, items, 10, "system");
    const atSmall = observed.current?.options.estimateSize(UNMEASURED);
    const totalSmall = observed.current?.getTotalSize();
    expect(atSmall).toBeLessThan(atDefault);
    expect(totalSmall).not.toBe(totalDefault);

    await commit(root, items, 24, "system");
    const atLarge = observed.current?.options.estimateSize(UNMEASURED);
    const totalLarge = observed.current?.getTotalSize();
    expect(atLarge).toBeGreaterThan(atDefault);
    expect(totalLarge).not.toBe(totalSmall);

    await commit(root, items, 24, "jetbrains");
    const atJetbrains = observed.current?.options.estimateSize(UNMEASURED);
    const totalJetbrains = observed.current?.getTotalSize();
    expect(atJetbrains).not.toBe(atLarge);
    expect(totalJetbrains).not.toBe(totalLarge);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("keeps a row's estimate frozen when only that row's content changes", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const base = [textItem("a"), textItem("target"), textItem("b")];
    await commit(root, base, 13, "system");
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");
    const before = instance.options.estimateSize(1);

    await commit(root, [base[0]!, withImage(base[1]!), base[2]!], 13, "system");
    const after = observed.current?.options.estimateSize(1);

    expect(after).toBe(before);
    expect(before).not.toBe(estimateRowHeight(withImage(base[1]!), readRowMetrics(null)));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
