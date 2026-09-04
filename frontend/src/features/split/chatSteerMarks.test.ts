import { beforeEach, describe, expect, it } from "vitest";
import { forgetSteerMark, recordSteerMark, steerMarks } from "./chatSteerMarks";

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
    const mark = { requestId: "r1", text: "hold on", ordinal: 2 } as const;
    recordSteerMark("chat-1", mark);
    const raw = window.sessionStorage.getItem("th-chat-steer:chat-1");
    expect(raw).not.toBeNull();
    expect(steerMarks("chat-1")).toEqual([mark]);
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
