import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChatTranscript } from "./ChatTranscript";
import { estimateRowHeight, readRowMetrics } from "./chatRowEstimate";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => {
  const state: { current?: Virtualizer<Element, Element> } = {};
  Object.defineProperty(window, "onscrollend", { configurable: true, value: null });
  return state;
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

function textItem(id: string): TranscriptItem {
  return {
    kind: "message",
    message: { id, role: "assistant", blocks: [{ kind: "text", text: "hello world" }] },
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

it("keeps a row's estimate stable when that row later gains image content", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const base = [textItem("a"), textItem("target"), textItem("b")];
    render(root, base);
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");
    const before = instance.options.estimateSize(1);

    render(root, [base[0]!, withImage(base[1]!), base[2]!]);
    const after = observed.current?.options.estimateSize(1);

    expect(after).toBe(before);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete observed.current;
  }
});

it("still gives a never-seen row key a content-derived estimate", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    render(root, [textItem("a"), textItem("b")]);
    const instance = observed.current;
    if (!instance) throw new Error("missing virtualizer instance");

    const fresh = withImage(textItem("fresh"));
    render(root, [textItem("a"), textItem("b"), fresh]);
    const estimate = observed.current?.options.estimateSize(2);

    // jsdom has no layout, so the component's metrics are the fallback set.
    expect(estimate).toBe(estimateRowHeight(fresh, readRowMetrics(null)));
  } finally {
    act(() => root.unmount());
    container.remove();
    delete observed.current;
  }
});
