import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";
import { parseServerFrame, SERVER_FRAME_TYPES } from "./contract/types_gen";

const base = {
  type: "chat.todo", sessionId: "chat-1", durableSessionId: "durable-1",
  bindingId: "binding-1", requestGeneration: 1,
};
const source = { leafId: "leaf-2", entryId: "entry-1", entryIndex: 0, kind: "custom" };
const ready = { ...base, status: "ready", source, phases: [] };
const unavailable = { ...base, status: "unavailable", error: "history-unavailable" };

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("canonical todo wire boundary", () => {
  it("registers chat.todo as a known frame", () => {
    expect(SERVER_FRAME_TYPES).toContain("chat.todo");
  });

  for (const [name, parse] of [["generated", parseServerFrame], ["UI", parseChatServerFrame]] as const) {
    describe(name, () => {
      it("preserves whole lists, explicit clears, proven absence, and availability", () => {
        const phases = [{ name: "Verification", tasks: [
          { content: "first", status: "pending" },
          { content: "first", status: "in_progress" },
          { content: "done", status: "completed" },
          { content: "dropped", status: "abandoned" },
        ] }];
        for (const frame of [
          ready, { ...ready, phases }, { ...ready, phases: [{ name: "empty", tasks: [] }] },
          { ...ready, source: { ...source, kind: "legacy-tool" } },
          ...[null, "leaf-without-todo"].map((leafId) => ({
            ...ready, source: { leafId, entryId: null, entryIndex: null, kind: "absent" }, phases: null,
          })),
          ...["history-unavailable", "invalid-state", "oversized"].map((error) => ({ ...unavailable, error })),
          { ...ready, requestGeneration: 0 }, { ...ready, requestGeneration: Number.MAX_SAFE_INTEGER },
        ]) expect(parse(frame)).toEqual(frame);
      });

      it("rejects missing fields and invalid identity/acquisition coordinates", () => {
        for (const key of ["sessionId", "durableSessionId", "bindingId", "requestGeneration", "status", "source", "phases"]) {
          expect(parse(without(ready, key)), key).toBeNull();
        }
        for (const key of ["sessionId", "durableSessionId", "bindingId"]) {
          for (const value of [null, "", 1]) expect(parse({ ...ready, [key]: value })).toBeNull();
        }
        for (const requestGeneration of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2"]) {
          expect(parse({ ...ready, requestGeneration })).toBeNull();
        }
        for (const key of ["leafId", "entryId", "entryIndex", "kind"]) {
          expect(parse({ ...ready, source: without(source, key) })).toBeNull();
        }
        for (const leafId of [null, ""]) expect(parse({ ...ready, source: { ...source, leafId } })).toBeNull();
        for (const entryId of [null, ""]) expect(parse({ ...ready, source: { ...source, entryId } })).toBeNull();
        for (const entryIndex of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(parse({ ...ready, source: { ...source, entryIndex } })).toBeNull();
        }
      });

      it("rejects contradictory availability and absence rather than inventing a clear", () => {
        for (const frame of [
          { ...ready, status: "future" }, { ...ready, error: "invalid-state" },
          { ...ready, phases: null }, { ...ready, source: null },
          { ...ready, source: { ...source, kind: "future" } },
          { ...ready, source: { ...source, kind: "absent" }, phases: null },
          { ...ready, source: { leafId: null, entryId: null, entryIndex: null, kind: "absent" } },
          { ...ready, source: { leafId: "", entryId: null, entryIndex: null, kind: "absent" }, phases: null },
          without(unavailable, "error"), { ...unavailable, error: "future" },
          { ...unavailable, phases: null }, { ...unavailable, phases: [] },
          { ...unavailable, source }, { ...unavailable, source: null },
        ]) expect(parse(frame)).toBeNull();
      });

      it("rejects the whole snapshot for any malformed phase/task", () => {
        const good = { name: "valid", tasks: [{ content: "keep", status: "completed" }] };
        for (const bad of [null, {}, { name: "bad" }, { name: 1, tasks: [] },
          { name: "bad", tasks: null }, { name: "bad", tasks: [{}] },
          { name: "bad", tasks: [{ content: "x", status: "future" }] },
          { name: "bad", tasks: [{ content: 1, status: "pending" }] }]) {
          expect(parse({ ...ready, phases: [good, bad] })).toBeNull();
        }
      });
    });
  }

  it("preserves legacy ready frames but carries valid todo binding announcements", () => {
    const legacy = { type: "ready", sessionId: "chat-1", piSessionId: "durable-1", resumed: true };
    for (const parse of [parseServerFrame, parseChatServerFrame]) {
      expect(parse(legacy)).toEqual(legacy);
      expect(parse({ ...legacy, piSessionId: null })).toEqual({ ...legacy, piSessionId: null });
      expect(parse({ ...legacy, bindingId: "binding-1" })).toEqual({ ...legacy, bindingId: "binding-1" });
      for (const bindingId of [null, "", 1]) expect(parse({ ...legacy, bindingId })).toBeNull();
      expect(parse({ ...legacy, piSessionId: null, bindingId: "binding-1" })).toBeNull();
      expect(parse({ ...legacy, sessionId: "", bindingId: "binding-1" })).toBeNull();
    }
  });
});
