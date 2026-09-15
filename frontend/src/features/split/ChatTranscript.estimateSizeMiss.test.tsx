import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChatTranscript } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => {
  const state: { current?: Virtualizer<Element, Element>; sizes: unknown[] } = { sizes: [] };
  Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
  return state;
});
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...actual,
    useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
      const [options] = args;
      const instance = actual.useVirtualizer({
        ...options,
        estimateSize: (index) => {
          const size = options.estimateSize(index);
          observed.sizes.push(size);
          return size;
        },
      });
      observed.current = instance;
      return instance;
    },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function chatItems(prefix: string, count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "message" as const,
    message: {
      id: `${prefix}-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      blocks: [{ kind: "text" as const, text: `${prefix} row ${index}` }],
    },
  }));
}

function render(
  root: ReturnType<typeof createRoot>,
  items: readonly TranscriptItem[],
): void {
  act(() => root.render(
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
    />,
  ));
}

it("keeps finite estimates and visible rows when the transcript shrinks to a shorter chat", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const longCount = 60;
  const shortCount = 3;
  try {
    render(root, chatItems("long", longCount));
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");

    observed.sizes = [];
    render(root, chatItems("short", shortCount));
    const after = observed.current;
    if (!after) throw new Error("missing virtualizer instance after shrink");

    // The virtualizer can still ask about indices from the previous longer
    // chat. Those lookups must stay finite so position arithmetic cannot
    // collapse the transcript to a blank view.
    for (let index = 0; index < longCount; index += 1) {
      after.options.estimateSize(index);
    }

    expect(observed.sizes.filter((size) => !Number.isFinite(size))).toEqual([]);
    expect(Number.isFinite(after.getTotalSize())).toBe(true);
    expect(container.querySelectorAll(".th-chat-row[data-index]").length).toBeGreaterThan(0);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete observed.current;
    observed.sizes = [];
  }
});
