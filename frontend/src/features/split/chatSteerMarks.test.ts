import { beforeEach, describe, expect, it } from "vitest";
import { applyEntrySteerMarks, forgetSteerMark, recordSteerMark, steerMarks } from "./chatSteerMarks";
import type { UiMessage } from "./chatEntries";

describe("chatSteerMarks client-side store", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("records stable steer occurrences per chat", () => {
    recordSteerMark("chat-1", { requestId: "r1", text: "hold on", ordinal: 2 });
    recordSteerMark("chat-1", { requestId: "r2", text: "also lint", ordinal: 3 });
    recordSteerMark("chat-2", { requestId: "r3", text: "hold on", ordinal: 1 });
    expect(steerMarks("chat-1")).toEqual([
      { requestId: "r1", text: "hold on", ordinal: 2 },
      { requestId: "r2", text: "also lint", ordinal: 3 },
    ]);
    expect(steerMarks("chat-2")).toEqual([{ requestId: "r3", text: "hold on", ordinal: 1 }]);
    expect(steerMarks("chat-3")).toEqual([]);
  });

  it("keeps identical texts as separate canonical occurrences", () => {
    recordSteerMark("chat-1", { requestId: "r1", text: "again", ordinal: 2 });
    recordSteerMark("chat-1", { requestId: "r2", text: "again", ordinal: 4 });
    expect(steerMarks("chat-1").map((mark) => mark.ordinal)).toEqual([2, 4]);
  });

  it("survives a simulated reload through sessionStorage", () => {
    const mark = { requestId: "r1", text: "hold on", entryId: "e-2" } as const;
    recordSteerMark("chat-1", mark);
    const raw = window.sessionStorage.getItem("th-chat-steer:chat-1");
    expect(raw).not.toBeNull();
    expect(steerMarks("chat-1")).toEqual([mark]);
  });

  it("applies entry-id marks to a bounded tail without mistaking identical text for identity", () => {
    recordSteerMark("chat-1", { requestId: "r1", text: "again", entryId: "steer" });
    const messages: readonly UiMessage[] = ["ordinary", "steer"].map(id => ({
      id, role: "user", blocks: [{ kind: "text", text: "again" }],
    }));
    expect(applyEntrySteerMarks("chat-1", messages, false).map(message => message.customType))
      .toEqual([undefined, "steer"]);
  });

  it("migrates legacy ordinals only once the committed branch reaches its root", () => {
    window.sessionStorage.setItem("th-chat-steer:chat-1", JSON.stringify([
      { requestId: "legacy", text: "again", ordinal: 1 },
    ]));
    const tail: readonly UiMessage[] = [{ id: "tail", role: "user", blocks: [{ kind: "text", text: "again" }] }];
    expect(applyEntrySteerMarks("chat-1", tail, false)[0]?.customType).toBeUndefined();
    expect(steerMarks("chat-1")[0]?.ordinal).toBe(1);
    const root: UiMessage = { id: "root", role: "user", blocks: [{ kind: "text", text: "again" }] };
    expect(applyEntrySteerMarks("chat-1", [root, ...tail], true).map(message => message.customType))
      .toEqual(["steer", undefined]);
    expect(steerMarks("chat-1")).toEqual([{ requestId: "legacy", text: "again", entryId: "root" }]);
  });

  it("forgets only the rejected request occurrence", () => {
    recordSteerMark("chat-1", { requestId: "r1", text: "racy", ordinal: 2 });
    recordSteerMark("chat-1", { requestId: "r2", text: "racy", ordinal: 3 });
    forgetSteerMark("chat-1", "r2");
    expect(steerMarks("chat-1")).toEqual([{ requestId: "r1", text: "racy", ordinal: 2 }]);
    forgetSteerMark("chat-1", "r1");
    expect(steerMarks("chat-1")).toEqual([]);
    expect(window.sessionStorage.getItem("th-chat-steer:chat-1")).toBe("[]");
  });

  it("ignores corrupt and legacy text-only persisted payloads", () => {
    window.sessionStorage.setItem("th-chat-steer:chat-1", JSON.stringify(["legacy", { ordinal: 0 }]));
    expect(steerMarks("chat-1")).toEqual([]);
    recordSteerMark("chat-1", { requestId: "r1", text: "fresh", ordinal: 1 });
    expect(steerMarks("chat-1")).toEqual([{ requestId: "r1", text: "fresh", ordinal: 1 }]);
  });
});
