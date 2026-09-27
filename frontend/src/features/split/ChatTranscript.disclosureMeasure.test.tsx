import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Virtualizer } from "@tanstack/react-virtual";
import { afterEach, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import { ChatTranscript } from "./ChatTranscript";
import type { TranscriptItem } from "./useChatFrameState";

const observed = vi.hoisted(() => ({ current: undefined as Virtualizer<Element, Element> | undefined }));
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

const i18n: I18nValue = {
  lang: "en", setLang: () => undefined, font: "system", setFont: () => undefined,
  fontSize: 13, setFontSize: () => undefined, t: (key) => key,
};

const items: readonly TranscriptItem[] = [
  { kind: "message", message: { id: "tool", role: "assistant", blocks: [
    { kind: "toolCall", id: "failed", name: "bash", arguments: { command: "exit 1" }, text: "failed output", isError: true },
  ] } },
  { kind: "message", message: { id: "thinking", role: "assistant", blocks: [
    { kind: "thinking", id: "thought", thinking: "Following reasoning" },
  ] } },
  { kind: "message", message: { id: "tail", role: "user", blocks: [{ kind: "text", text: "After the records" }] } },
];

afterEach(() => {
  observed.current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("re-measures tool and thinking rows in the disclosure commit before ResizeObserver delivers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.matches('.th-chat-row[data-index="0"]')) return this.querySelector(".th-tool-body") ? 400 : 100;
    if (this.matches('.th-chat-row[data-index="1"]')) return this.querySelector(".th-chat-thinking--open") ? 180 : 60;
    return 40;
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nContext.Provider value={i18n}>
        <ChatTranscript items={items} streaming="" thinking="" toolCalls={{}}
          doneReason={null} error="" restoreVersion={0} focused={false} historyLoaded />
      </I18nContext.Provider>,
    ));
    const virtualizer = observed.current;
    if (!virtualizer) throw new Error("missing virtualizer");
    expect(virtualizer.measurementsCache.slice(0, 2).map((row) => row.size)).toEqual([400, 60]);

    const toggle = async (selector: string): Promise<void> => {
      const button = container.querySelector<HTMLButtonElement>(selector);
      if (!button) throw new Error(`missing ${selector}`);
      await act(async () => button.click());
    };
    await toggle(".th-tool-head");
    expect(virtualizer.measurementsCache.slice(0, 2).map((row) => row.size)).toEqual([100, 60]);
    expect(virtualizer.getTotalSize()).toBe(200);
    await toggle(".th-chat-thinking-head");
    expect(virtualizer.measurementsCache.slice(0, 2).map((row) => row.size)).toEqual([100, 180]);
    await toggle(".th-chat-thinking-head");
    expect(virtualizer.measurementsCache.slice(0, 2).map((row) => row.size)).toEqual([100, 60]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
