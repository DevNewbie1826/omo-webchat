import { describe, expect, it } from "vitest";
import type { UiMessage } from "./chatEntries";
import { mergeTranscriptItems, type ChatNotice, type TranscriptItem } from "./useChatFrameState";

function message(ts: number, text: string): UiMessage {
  return { role: "assistant", blocks: [{ kind: "text", text }], ts };
}

function notice(id: number, at: number): ChatNotice {
  return { id, kind: "auto_retry_start", payload: { message: `n${id}` }, at };
}

function label(item: TranscriptItem): string {
  if (item.kind === "notice") {
    const text = item.notice.payload?.["message"];
    return typeof text === "string" ? text : item.notice.kind;
  }
  const block = item.message.blocks?.[0];
  return block && typeof block.text === "string" ? block.text : "";
}

function labels(messages: readonly UiMessage[], notices: readonly ChatNotice[]): string[] {
  return mergeTranscriptItems(messages, notices).map(label);
}

describe("mergeTranscriptItems", () => {
  it("renders a notice whose at falls between two entries' ts between them", () => {
    const merged = labels([message(100, "early"), message(300, "late")], [notice(1, 200)]);
    expect(merged).toEqual(["early", "n1", "late"]);
  });

  it("keeps ts=0 entries in their relative array order", () => {
    const merged = labels(
      [message(0, "a"), message(500, "b"), message(0, "c"), message(0, "d")],
      [notice(1, 250)],
    );
    expect(merged).toEqual(["a", "c", "d", "n1", "b"]);
  });

  it("renders a notice after the entries sharing its timestamp on a tie", () => {
    const merged = labels([message(100, "first"), message(100, "second")], [notice(1, 100)]);
    expect(merged).toEqual(["first", "second", "n1"]);
  });
});
