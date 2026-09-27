import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("entry.appended frame parsing", () => {
  it("parses the complete v4 identity hint", () => {
    expect(parseChatServerFrame({
      type: "entry.appended",
      sessionId: "chat-1",
      id: "entry-2",
      parentId: "entry-1",
      role: "assistant",
      textPrefix: "hello",
      bindingId: "binding-1",
    })).toEqual({
      type: "entry.appended",
      sessionId: "chat-1",
      id: "entry-2",
      parentId: "entry-1",
      role: "assistant",
      textPrefix: "hello",
      bindingId: "binding-1",
    });
  });

  it("rejects missing or malformed fields", () => {
    const base = {
      type: "entry.appended",
      sessionId: "chat-1",
      id: "entry-2",
      parentId: null,
      role: "user",
      textPrefix: "hello",
    };
    expect(parseChatServerFrame({ ...base, sessionId: 1 })).toBeNull();
    expect(parseChatServerFrame({ ...base, parentId: 1 })).toBeNull();
    expect(parseChatServerFrame({ ...base, bindingId: null })).toBeNull();
    const { textPrefix: _textPrefix, ...missingPrefix } = base;
    expect(parseChatServerFrame(missingPrefix)).toBeNull();
  });

  it("rejects prototype-polluting keys", () => {
    const raw = JSON.parse('{"type":"entry.appended","sessionId":"c","id":"e","parentId":null,"role":"user","textPrefix":"","constructor":{}}');
    expect(parseChatServerFrame(raw)).toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
