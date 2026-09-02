import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame extensionEvent", () => {
  it("accepts an extension event with JSON data", () => {
    expect(
      parseChatServerFrame({
        type: "extensionEvent",
        sessionId: "s1",
        name: "omo.task.updated",
        data: { tasks: [] },
      }),
    ).toEqual({
      type: "extensionEvent",
      sessionId: "s1",
      name: "omo.task.updated",
      data: { tasks: [] },
    });
  });

  it("drops an extension event without a name", () => {
    expect(parseChatServerFrame({ type: "extensionEvent", sessionId: "s1" })).toBeNull();
    expect(parseChatServerFrame({ type: "extensionEvent", sessionId: "s1", name: "" })).toBeNull();
  });

  it("drops an unknown frame type unchanged", () => {
    expect(parseChatServerFrame({ type: "unknown.extension", sessionId: "s1" })).toBeNull();
  });

  it("keeps data absent when omitted", () => {
    expect(parseChatServerFrame({ type: "extensionEvent", sessionId: "s1", name: "omo.task.updated" })).toEqual({
      type: "extensionEvent",
      sessionId: "s1",
      name: "omo.task.updated",
    });
  });

  it("drops extension events with non-record data", () => {
    expect(parseChatServerFrame({ type: "extensionEvent", sessionId: "s1", name: "event", data: [] })).toEqual({
      type: "extensionEvent", sessionId: "s1", name: "event", data: [],
    });
    expect(parseChatServerFrame({ type: "extensionEvent", sessionId: "s1", name: "event", data: "value" })).toEqual({
      type: "extensionEvent", sessionId: "s1", name: "event", data: "value",
    });
  });
});
